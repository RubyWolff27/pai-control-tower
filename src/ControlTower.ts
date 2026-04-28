#!/usr/bin/env bun
/**
 * ControlTower.ts — PAI Control Tower Dashboard
 * Real-time augmentation dashboard at http://localhost:8895
 * Phase 1: Core metrics, system inventory, cockpit aesthetic.
 *
 * Usage: bun ControlTower.ts
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, basename } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import type { VoiceEvent, LiveEvent, LiveSession, GanttItem, SessionMeta, MachineHealth } from "./ct-types";

const PORT = 8895;
const HOME = homedir();
const DB_PATH = join(HOME, ".claude/data/control-tower.db");
const TRANSCRIPTS_DIR = join(HOME, ".claude/projects/");
const SKILLS_DIR = join(HOME, ".claude/skills");
const HOOKS_DIR = join(HOME, ".claude/hooks");
const LAUNCH_AGENTS_DIR = join(HOME, "Library/LaunchAgents");
const MEMORY_DIR = join(HOME, ".claude/projects//memory");
const WORK_DIR = join(HOME, ".claude/MEMORY/WORK");
const WIKI_DIR = join(HOME, ".claude/MEMORY/WIKI");
const RATINGS_PATH = join(HOME, ".claude/MEMORY/LEARNING/SIGNALS/ratings.jsonl");
const REFLECTIONS_PATH = join(HOME, ".claude/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl");
const PUBLIC_DIR = join(import.meta.dir, "public");
const CLAUDE_DIR = join(HOME, ".claude");

// PAI inception date
const INCEPTION_DATE = new Date(); // Set your PAI start date

// ─── Phase 3: Live Operations ────────────────────────────────────────────────

// Voice event ring buffer (in-memory, max 50 entries)
const voiceEventLog: VoiceEvent[] = [];
const MAX_VOICE_EVENTS = 50;

function pushVoiceEvent(evt: VoiceEvent) {
  voiceEventLog.push(evt);
  if (voiceEventLog.length > MAX_VOICE_EVENTS) voiceEventLog.shift();
}

// Live session detection: find most recent transcript + tail-parse it
async function getLiveSession(): Promise<LiveSession> {
  const result: LiveSession = {
    isActive: false,
    sessionId: null,
    startedAt: null,
    elapsedMins: 0,
    recentEvents: [],
    toolCallSummary: {},
    activePhase: null,
  };

  try {
    // Find most recently modified .jsonl
    const files = readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".jsonl"));
    if (files.length === 0) return result;

    let newestFile = "";
    let newestMtime = 0;
    for (const f of files) {
      try {
        const s = statSync(join(TRANSCRIPTS_DIR, f));
        if (s.mtimeMs > newestMtime) {
          newestMtime = s.mtimeMs;
          newestFile = f;
        }
      } catch {}
    }

    if (!newestFile) return result;

    // Active if modified within last 2 minutes
    const ageMs = Date.now() - newestMtime;
    result.isActive = ageMs < 2 * 60 * 1000;
    result.sessionId = basename(newestFile, ".jsonl");

    // Efficient tail read: last 64KB of the file (avoid reading multi-MB transcripts)
    const filePath = join(TRANSCRIPTS_DIR, newestFile);
    const fileHandle = Bun.file(filePath);
    const fileSize = fileHandle.size;
    const TAIL_BYTES = 512 * 1024; // 512KB — compacted transcripts have very large entries
    const HEAD_BYTES = 1024; // Just enough to get first timestamp

    // Read head (first line for startedAt) — only 1KB
    const headSlice = fileHandle.slice(0, Math.min(HEAD_BYTES, fileSize));
    const headText = await headSlice.text();
    const firstLineEnd = headText.indexOf("\n");
    if (firstLineEnd > 0) {
      try {
        const first = JSON.parse(headText.slice(0, firstLineEnd));
        if (first.timestamp) {
          result.startedAt = first.timestamp;
          const startMs = new Date(first.timestamp).getTime();
          result.elapsedMins = Math.round((Date.now() - startMs) / 60000 * 10) / 10;
        }
      } catch {}
    }

    // Read tail (last 64KB for recent events)
    const startOffset = Math.max(0, fileSize - TAIL_BYTES);
    const tailSlice = fileHandle.slice(startOffset, fileSize);
    const tailText = await tailSlice.text();
    // Skip potentially partial first line if we're mid-file
    const adjustedTail = startOffset > 0 ? tailText.slice(tailText.indexOf("\n") + 1) : tailText;
    const lines = adjustedTail.split("\n").filter(l => l.trim());

    // Parse tail lines for recent events
    const events: LiveEvent[] = [];
    let lastPhase: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp || "";

        // Extract tool calls from assistant messages
        const msg = entry.message;
        if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "tool_use") {
              const toolName = block.name || "unknown";
              result.toolCallSummary[toolName] = (result.toolCallSummary[toolName] || 0) + 1;

              // Agent spawns
              if (toolName === "Task" || toolName === "Agent") {
                const agentType = block.input?.subagent_type || block.input?.type || "general-purpose";
                events.push({
                  type: "agent_spawn",
                  name: agentType,
                  timestamp: ts,
                  detail: block.input?.description ? block.input.description.slice(0, 40).replace(/[^a-zA-Z0-9\s\-]/g, "") : agentType,
                });
              } else {
                events.push({
                  type: "tool_call",
                  name: toolName,
                  timestamp: ts,
                });
              }
            }

            // Phase transitions
            if (block?.type === "text" && typeof block.text === "string") {
              const phaseMatch = block.text.match(/━━━\s*[^\s]+\s*(OBSERVE|THINK|PLAN|BUILD|EXECUTE|VERIFY|LEARN)\s*━━━/);
              if (phaseMatch) {
                lastPhase = phaseMatch[1];
                events.push({
                  type: "phase_transition",
                  name: phaseMatch[1],
                  timestamp: ts,
                });
              }
            }
          }
        }

        // User messages
        if (entry.type === "user" && ts) {
          events.push({
            type: "user_message",
            name: "User Input",
            timestamp: ts,
          });
        }
      } catch {}
    }

    result.activePhase = lastPhase;
    // Return last 60 events, most recent first
    result.recentEvents = events.slice(-60).reverse();
  } catch (err) {
    console.error("getLiveSession error:", err);
  }

  return result;
}

// ─── Live Gantt Timeline ──────────────────────────────────────────────────

async function getLiveGantt(): Promise<{ items: GanttItem[]; sessionActive: boolean; sessionStart: string | null }> {
  const items: GanttItem[] = [];
  let sessionActive = false;
  let sessionStart: string | null = null;

  try {
    const files = readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".jsonl"));
    if (files.length === 0) return { items, sessionActive, sessionStart };

    let newestFile = "";
    let newestMtime = 0;
    for (const f of files) {
      try {
        const s = statSync(join(TRANSCRIPTS_DIR, f));
        if (s.mtimeMs > newestMtime) { newestMtime = s.mtimeMs; newestFile = f; }
      } catch {}
    }
    if (!newestFile) return { items, sessionActive, sessionStart };

    const ageMs = Date.now() - newestMtime;
    sessionActive = ageMs < 2 * 60 * 1000;

    const filePath = join(TRANSCRIPTS_DIR, newestFile);
    const fileHandle = Bun.file(filePath);
    const fileSize = fileHandle.size;

    // Read head for session start
    const headSlice = fileHandle.slice(0, Math.min(1024, fileSize));
    const headText = await headSlice.text();
    const firstLineEnd = headText.indexOf("\n");
    if (firstLineEnd > 0) {
      try {
        const first = JSON.parse(headText.slice(0, firstLineEnd));
        if (first.timestamp) sessionStart = first.timestamp;
      } catch {}
    }

    // Read tail 128KB for more coverage of skill/agent activity
    const TAIL_BYTES = 128 * 1024;
    const startOffset = Math.max(0, fileSize - TAIL_BYTES);
    const tailSlice = fileHandle.slice(startOffset, fileSize);
    const tailText = await tailSlice.text();
    const adjustedTail = startOffset > 0 ? tailText.slice(tailText.indexOf("\n") + 1) : tailText;
    const lines = adjustedTail.split("\n").filter(l => l.trim());

    // Track skill and agent activity windows
    const skillWindows: Map<string, { start: string; lastSeen: string }> = new Map();
    const agentWindows: Map<string, { start: string; lastSeen: string; parentSkill: string | null }> = new Map();
    let currentSkill: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp || "";
        if (!ts) continue;

        const msg = entry.message;
        if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "tool_use") {
              const toolName = block.name || "";

              // Skill invocation
              if (toolName === "Skill") {
                const skillName = block.input?.skill || block.input?.name || "unknown";
                currentSkill = skillName;
                if (!skillWindows.has(skillName)) {
                  skillWindows.set(skillName, { start: ts, lastSeen: ts });
                } else {
                  skillWindows.get(skillName)!.lastSeen = ts;
                }
              }

              // Agent spawn
              if (toolName === "Task" || toolName === "Agent") {
                const agentType = block.input?.subagent_type || block.input?.type || "general-purpose";
                const key = `${agentType}_${ts}`;
                if (!agentWindows.has(agentType)) {
                  agentWindows.set(agentType, { start: ts, lastSeen: ts, parentSkill: currentSkill });
                } else {
                  agentWindows.get(agentType)!.lastSeen = ts;
                }
              }

              // Any tool call extends current skill window
              if (currentSkill && skillWindows.has(currentSkill)) {
                skillWindows.get(currentSkill)!.lastSeen = ts;
              }
            }

            // Phase transitions reset current skill context
            if (block?.type === "text" && typeof block.text === "string") {
              const phaseMatch = block.text.match(/━━━\s*[^\s]+\s*(OBSERVE|THINK|PLAN|BUILD|EXECUTE|VERIFY|LEARN)\s*━━━/);
              if (phaseMatch) {
                // Algorithm phases are tracked but don't replace skill context
              }
            }
          }
        }
      } catch {}
    }

    const now = Date.now();
    // Convert skill windows to Gantt items
    for (const [name, window] of skillWindows) {
      const startMs = new Date(window.start).getTime();
      const endMs = new Date(window.lastSeen).getTime();
      const isStillActive = sessionActive && (now - endMs < 60000); // active if seen in last 60s
      items.push({
        type: "skill",
        name,
        startTime: window.start,
        endTime: isStillActive ? null : window.lastSeen,
        durationMins: Math.round(((isStillActive ? now : endMs) - startMs) / 60000 * 10) / 10,
      });
    }

    // Convert agent windows to Gantt items
    for (const [name, window] of agentWindows) {
      const startMs = new Date(window.start).getTime();
      const endMs = new Date(window.lastSeen).getTime();
      const isStillActive = sessionActive && (now - endMs < 60000);
      items.push({
        type: "agent",
        name,
        startTime: window.start,
        endTime: isStillActive ? null : window.lastSeen,
        durationMins: Math.round(((isStillActive ? now : endMs) - startMs) / 60000 * 10) / 10,
        parentSkill: window.parentSkill || undefined,
      });
    }

    // Sort: skills first, then agents, by start time
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "skill" ? -1 : 1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    });
  } catch (err) {
    console.error("getLiveGantt error:", err);
  }

  return { items, sessionActive, sessionStart };
}

// Cached storage values (computed in background, expensive operation)
let cachedStorage = { totalGB: 0, transcriptGB: 0, computedAt: 0 };
const STORAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Cached dashboard health and system status
let cachedDashboardHealth: Record<number, boolean> = {};
let cachedSystemStatus = { voiceServer: false, ollama: false, telegramBot: false, groot: false, grootUptime: "" };

async function refreshHealthCache() {
  const ports = [8891, 8892, 8893, 8894, 8895, 8896];
  for (const port of ports) {
    try {
      const proc = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "1", `http://127.0.0.1:${port}/`], { stdout: "pipe" });
      const code = (await new Response(proc.stdout).text()).trim();
      cachedDashboardHealth[port] = code !== "000" && code !== "";
    } catch {
      cachedDashboardHealth[port] = false;
    }
  }
  // Voice server
  try {
    const proc = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "1", "http://127.0.0.1:8888/"], { stdout: "pipe" });
    cachedSystemStatus.voiceServer = (await new Response(proc.stdout).text()).trim() !== "000";
  } catch {}
  // Ollama
  try {
    const proc = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "1", "http://127.0.0.1:11434/"], { stdout: "pipe" });
    cachedSystemStatus.ollama = (await new Response(proc.stdout).text()).trim() !== "000";
  } catch {}
  // Telegram bot (process-based check, not port — it's a polling bot)
  try {
    const proc = Bun.spawn(["pgrep", "-f", "TelegramBot.ts"], { stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    cachedSystemStatus.telegramBot = out.length > 0;
  } catch {}

  // Groot VPS (SSH health check — 3s timeout)
  try {
    const proc = Bun.spawn(
      ["ssh", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
       "root@72.60.41.251", "echo ALIVE && uptime -p 2>/dev/null || uptime"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = (await new Response(proc.stdout).text()).trim();
    cachedSystemStatus.groot = out.includes("ALIVE");
    // Extract uptime portion
    const lines = out.split("\n");
    cachedSystemStatus.grootUptime = lines.length > 1 ? lines[1].trim() : "";
  } catch {
    cachedSystemStatus.groot = false;
    cachedSystemStatus.grootUptime = "";
  }
}

async function refreshStorageCache() {
  try {
    const proc1 = Bun.spawn(["du", "-sk", CLAUDE_DIR], { stdout: "pipe" });
    const out1 = await new Response(proc1.stdout).text();
    const m1 = out1.match(/^(\d+)/);

    const proc2 = Bun.spawn(["du", "-sk", TRANSCRIPTS_DIR], { stdout: "pipe" });
    const out2 = await new Response(proc2.stdout).text();
    const m2 = out2.match(/^(\d+)/);

    cachedStorage = {
      totalGB: m1 ? Math.round((parseInt(m1[1]) * 1024 / 1073741824) * 100) / 100 : 0,
      transcriptGB: m2 ? Math.round((parseInt(m2[1]) * 1024 / 1073741824) * 100) / 100 : 0,
      computedAt: Date.now(),
    };
    console.log(`📏 Storage cache updated: ${cachedStorage.totalGB} GB total, ${cachedStorage.transcriptGB} GB transcripts`);
  } catch (err) {
    console.error("Storage cache error:", err);
  }
}

// ─── Database Setup ─────────────────────────────────────────────────────────

function initDB(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      file_path TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_mins REAL,
      active_mins REAL DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      agent_spawn_count INTEGER DEFAULT 0,
      effort_level TEXT,
      task_description TEXT,
      file_size_bytes INTEGER,
      file_mtime REAL
    );

    CREATE TABLE IF NOT EXISTS agent_spawns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      agent_type TEXT,
      spawned_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      session_id TEXT,
      tool_name TEXT,
      call_count INTEGER,
      PRIMARY KEY (session_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS skill_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      skill_name TEXT,
      invoked_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      session_count INTEGER,
      total_duration_mins REAL,
      total_tool_calls INTEGER,
      total_agent_spawns INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

// ─── JSONL Streaming Parser ─────────────────────────────────────────────────

async function parseTranscriptStream(filePath: string): Promise<SessionMeta> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.split("\n");

  const MAX_GAP_MS = 5 * 60 * 1000; // 5 min — gaps longer than this = idle
  const meta: SessionMeta = {
    id: basename(filePath, ".jsonl"),
    startedAt: null,
    endedAt: null,
    activeMins: 0,
    messageCount: 0,
    toolCalls: {},
    agentSpawns: [],
    skillInvocations: [],
    effortLevel: null,
    taskDescription: null,
  };

  const timestamps: number[] = [];

  let firstUserMsg = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const ts = entry.timestamp;

      // Track timestamps
      if (ts) {
        if (!meta.startedAt || ts < meta.startedAt) meta.startedAt = ts;
        if (!meta.endedAt || ts > meta.endedAt) meta.endedAt = ts;
        const t = new Date(ts).getTime();
        if (!isNaN(t)) timestamps.push(t);
      }

      // Count messages
      if (entry.type === "human" || entry.type === "assistant" || entry.type === "user") {
        meta.messageCount++;
      }

      // Capture first substantive user message as fallback task description
      if ((entry.type === "human" || entry.type === "user") && !firstUserMsg) {
        const msg = entry.message;
        let text = "";
        if (msg && typeof msg === "object") {
          const content = msg.content;
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            for (const b of content) {
              if (b?.type === "text" && typeof b.text === "string") { text = b.text; break; }
            }
          }
        }
        // Strip XML tags, commands, and system reminders
        const clean = text
          .replace(/<[^>]+>/g, "")
          .replace(/\/(PAI|commit|help|review|simplify)\b/g, "")
          .trim();
        if (clean.length > 15 && !clean.startsWith("system-reminder")) {
          firstUserMsg = clean.slice(0, 200);
        }
      }

      // Extract tool calls from assistant messages
      const msg = entry.message;
      if (msg && typeof msg === "object") {
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === "tool_use") {
              const name = block.name || "unknown";
              meta.toolCalls[name] = (meta.toolCalls[name] || 0) + 1;

              // Detect agent spawns
              if (name === "Task" || name === "Agent") {
                const input = block.input;
                if (input && typeof input === "object") {
                  const agentType = input.subagent_type || input.type || "general-purpose";
                  meta.agentSpawns.push({ type: agentType, at: ts || "" });
                }
              }

              // Detect skill invocations
              if (name === "Skill" && block.input) {
                const skillName = block.input.skill || block.input.name || "unknown";
                meta.skillInvocations.push({ name: skillName, at: ts || "" });
              }
            }

            // Extract task description from Algorithm format
            if (block && block.type === "text" && typeof block.text === "string" && !meta.taskDescription) {
              const taskMatch = block.text.match(/🗒️\s*TASK:\s*(.+)/);
              if (taskMatch) meta.taskDescription = taskMatch[1].trim().slice(0, 200);
            }

            // Extract effort level (multiple patterns across Algorithm versions)
            if (block?.type === "text" && typeof block.text === "string" && !meta.effortLevel) {
              const patterns = [
                /Selected:\s*\*?\*?(\w+)\*?\*?\s*\(/,
                /EFFORT LEVEL:\s*\*?\*?(\w+)\*?\*?/,
                /💪🏼\s*EFFORT LEVEL:\s*\*?\*?(\w+)\*?\*?/i,
                /Effort Level:\s*(\w+)/,
              ];
              for (const pat of patterns) {
                const m = block.text.match(pat);
                if (m) { meta.effortLevel = m[1]; break; }
              }
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Fallback: use first user message if no Algorithm TASK line found
  if (!meta.taskDescription && firstUserMsg) {
    meta.taskDescription = firstUserMsg;
  }

  // Calculate active working time: sum gaps between consecutive timestamps,
  // capping each gap at MAX_GAP_MS to exclude idle periods
  if (timestamps.length > 1) {
    timestamps.sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      activeMs += Math.min(gap, MAX_GAP_MS);
    }
    meta.activeMins = Math.round((activeMs / 60000) * 100) / 100;
  }

  return meta;
}

// ─── Sync Engine ────────────────────────────────────────────────────────────

async function syncTranscripts(db: Database, force = false): Promise<{ processed: number; skipped: number }> {
  let processed = 0;
  let skipped = 0;

  const files = readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".jsonl"));

  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions
    (id, file_path, started_at, ended_at, duration_mins, active_mins, message_count,
     tool_call_count, agent_spawn_count, effort_level, task_description,
     file_size_bytes, file_mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertToolCall = db.prepare(`
    INSERT OR REPLACE INTO tool_calls (session_id, tool_name, call_count)
    VALUES (?, ?, ?)
  `);

  const insertAgentSpawn = db.prepare(`
    INSERT OR IGNORE INTO agent_spawns (session_id, agent_type, spawned_at)
    VALUES (?, ?, ?)
  `);

  const insertSkillInvocation = db.prepare(`
    INSERT OR IGNORE INTO skill_invocations (session_id, skill_name, invoked_at)
    VALUES (?, ?, ?)
  `);

  const getSession = db.prepare("SELECT file_mtime FROM sessions WHERE id = ?");

  for (const file of files) {
    const filePath = join(TRANSCRIPTS_DIR, file);
    const sessionId = basename(file, ".jsonl");

    try {
      const stat = statSync(filePath);
      const mtime = stat.mtimeMs;

      // Incremental: skip if mtime hasn't changed (unless force backfill)
      if (!force) {
        const existing = getSession.get(sessionId) as { file_mtime: number } | null;
        if (existing && Math.abs(existing.file_mtime - mtime) < 1000) {
          skipped++;
          continue;
        }
      }

      const meta = await parseTranscriptStream(filePath);

      // Calculate duration
      let durationMins = 0;
      if (meta.startedAt && meta.endedAt) {
        const start = new Date(meta.startedAt).getTime();
        const end = new Date(meta.endedAt).getTime();
        durationMins = Math.max(0, (end - start) / 60000);
      }

      const totalToolCalls = Object.values(meta.toolCalls).reduce((a, b) => a + b, 0);

      // Insert session metadata (NO message content)
      insertSession.run(
        meta.id,
        filePath,
        meta.startedAt,
        meta.endedAt,
        Math.round(durationMins * 100) / 100,
        meta.activeMins,
        meta.messageCount,
        totalToolCalls,
        meta.agentSpawns.length,
        meta.effortLevel,
        meta.taskDescription,
        stat.size,
        mtime
      );

      // Insert tool call summaries
      for (const [toolName, count] of Object.entries(meta.toolCalls)) {
        insertToolCall.run(meta.id, toolName, count);
      }

      // Insert agent spawns
      for (const spawn of meta.agentSpawns) {
        insertAgentSpawn.run(meta.id, spawn.type, spawn.at);
      }

      // Insert skill invocations
      for (const skill of meta.skillInvocations) {
        insertSkillInvocation.run(meta.id, skill.name, skill.at);
      }

      processed++;
    } catch (err) {
      // Skip files that fail to parse
      console.error(`Failed to parse ${file}:`, err);
    }
  }

  // Rebuild daily stats — count only real conversations (not sub-agent transcripts)
  db.exec(`
    DELETE FROM daily_stats;
    INSERT INTO daily_stats (date, session_count, total_duration_mins, total_tool_calls, total_agent_spawns)
    SELECT
      DATE(started_at) AS date,
      SUM(CASE WHEN message_count >= 2 AND duration_mins > 1 THEN 1 ELSE 0 END) AS session_count,
      COALESCE(SUM(CASE WHEN message_count >= 2 AND duration_mins > 1 THEN active_mins ELSE 0 END), 0) AS total_duration_mins,
      COALESCE(SUM(tool_call_count), 0) AS total_tool_calls,
      COALESCE(SUM(agent_spawn_count), 0) AS total_agent_spawns
    FROM sessions
    WHERE started_at IS NOT NULL
    GROUP BY DATE(started_at);
  `);

  // Update sync timestamp
  db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sync', ?)").run(new Date().toISOString());

  return { processed, skipped };
}

// ─── Metrics API ────────────────────────────────────────────────────────────

function getCoreMetrics(db: Database) {
  // Real conversations: human-interaction sessions with actual content
  // Sub-agent transcripts (Explore, ClaudeResearcher, etc.) create transcript files
  // but are NOT conversations — they have 0-1 messages and 0 duration
  const CONVERSATION_FILTER = "message_count >= 2 AND duration_mins > 1";

  const totalSessions = (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${CONVERSATION_FILTER}`).get() as any)?.c || 0;
  const totalTranscripts = (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as any)?.c || 0;
  const totalAgentOps = totalTranscripts - totalSessions;
  const totalActiveHrs = (db.prepare(`SELECT COALESCE(SUM(active_mins), 0) AS m FROM sessions WHERE ${CONVERSATION_FILTER}`).get() as any)?.m / 60 || 0;
  const avgActiveMins = (db.prepare(`SELECT COALESCE(AVG(active_mins), 0) AS m FROM sessions WHERE ${CONVERSATION_FILTER} AND active_mins > 0.5`).get() as any)?.m || 0;
  const totalToolCalls = (db.prepare("SELECT COALESCE(SUM(tool_call_count), 0) AS c FROM sessions").get() as any)?.c || 0;
  const totalAgentSpawns = (db.prepare("SELECT COALESCE(SUM(agent_spawn_count), 0) AS c FROM sessions").get() as any)?.c || 0;

  // This week / this month — conversations only
  const thisWeek = (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE started_at >= date('now', '-7 days') AND ${CONVERSATION_FILTER}`).get() as any)?.c || 0;
  const thisWeekAgentOps = (db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE started_at >= date('now', '-7 days') AND NOT (message_count >= 2 AND duration_mins > 1)").get() as any)?.c || 0;
  const thisMonth = (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE started_at >= date('now', 'start of month') AND ${CONVERSATION_FILTER}`).get() as any)?.c || 0;

  // Earliest session date
  const earliest = (db.prepare("SELECT MIN(started_at) AS d FROM sessions WHERE started_at IS NOT NULL").get() as any)?.d;
  const firstDate = earliest ? new Date(earliest) : INCEPTION_DATE;
  const daysAlive = Math.floor((Date.now() - firstDate.getTime()) / 86400000);

  // Storage from cache (computed async in background)
  if (Date.now() - cachedStorage.computedAt > STORAGE_CACHE_TTL) {
    refreshStorageCache(); // Fire and forget — don't block the response
  }

  // Avg rating from ratings.jsonl
  let avgRating = 0;
  let ratingCount = 0;
  try {
    if (existsSync(RATINGS_PATH)) {
      const lines = readFileSync(RATINGS_PATH, "utf-8").split("\n").filter(l => l.trim());
      let sum = 0;
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (typeof r.rating === "number") {
            sum += r.rating;
            ratingCount++;
          }
        } catch {}
      }
      if (ratingCount > 0) avgRating = Math.round((sum / ratingCount) * 10) / 10;
    }
  } catch {}

  // Algorithm reflections count
  let reflectionCount = 0;
  try {
    if (existsSync(REFLECTIONS_PATH)) {
      reflectionCount = readFileSync(REFLECTIONS_PATH, "utf-8").split("\n").filter(l => l.trim()).length;
    }
  } catch {}

  // Daily stats for sparkline (last 30 days)
  const dailyStats = db.prepare(`
    SELECT date, session_count, total_duration_mins
    FROM daily_stats
    WHERE date >= date('now', '-30 days')
    ORDER BY date ASC
  `).all();

  // Last sync
  const lastSync = (db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync'").get() as any)?.value || null;

  return {
    daysAlive,
    firstDate: firstDate.toISOString().split("T")[0],
    totalSessions,
    totalAgentOps,
    totalActiveHrs: Math.round(totalActiveHrs * 10) / 10,
    avgActiveMins: Math.round(avgActiveMins * 10) / 10,
    thisWeek,
    thisWeekAgentOps,
    thisMonth,
    totalToolCalls,
    totalAgentSpawns,
    avgRating,
    ratingCount,
    reflectionCount,
    totalStorageGB: cachedStorage.totalGB,
    transcriptStorageGB: cachedStorage.transcriptGB,
    dailyStats,
    lastSync,
  };
}

function getSystemInventory() {
  // Skills
  let skillCount = 0;
  let skillCategories: string[] = [];
  try {
    skillCategories = readdirSync(SKILLS_DIR).filter(d => {
      try { return statSync(join(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
    });
    // Count SKILL.md files recursively
    const countSkills = (dir: string): number => {
      let count = 0;
      try {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) count += countSkills(p);
            else if (entry === "SKILL.md") count++;
          } catch {}
        }
      } catch {}
      return count;
    };
    skillCount = countSkills(SKILLS_DIR);
  } catch {}

  // Hooks
  let hookCount = 0;
  try {
    hookCount = readdirSync(HOOKS_DIR).filter(f => f.endsWith(".ts")).length;
  } catch {}

  // LaunchAgents (ai.pai.*)
  let automationCount = 0;
  try {
    automationCount = readdirSync(LAUNCH_AGENTS_DIR).filter(f => f.startsWith("ai.pai.")).length;
  } catch {}

  // PRDs
  let prdTotal = 0;
  let prdComplete = 0;
  let prdInProgress = 0;
  try {
    const countPRDs = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) countPRDs(p);
            else if (entry.startsWith("PRD-") && entry.endsWith(".md")) {
              prdTotal++;
              try {
                const content = readFileSync(p, "utf-8");
                if (content.includes("status: COMPLETE")) prdComplete++;
                else if (content.includes("status: IN_PROGRESS")) prdInProgress++;
              } catch {}
            }
          } catch {}
        }
      } catch {}
    };
    countPRDs(WORK_DIR);
  } catch {}

  // Memory files
  let memoryFileCount = 0;
  try {
    memoryFileCount = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md")).length;
  } catch {}

  // Running dashboards (check ports)
  const dashboardPorts = [
    { port: 8891, name: "Health Dashboard" },
    { port: 8893, name: "Finance Dashboard v2" },
    { port: 8895, name: "Control Tower" },
    { port: 8897, name: "Sage Mobile PWA" },
  ];
  // Dashboard health — use cached results (updated async)
  const runningDashboards = dashboardPorts.map(d => ({
    ...d,
    running: cachedDashboardHealth[d.port] || false,
  }));

  return {
    skills: skillCount,
    skillCategories: skillCategories.length,
    skillCategoryNames: skillCategories,
    hooks: hookCount,
    automations: automationCount,
    prds: { total: prdTotal, complete: prdComplete, inProgress: prdInProgress },
    memoryFiles: memoryFileCount,
    dashboards: runningDashboards,
  };
}

// ─── Wiki Dashboard Data ────────────────────────────────────────────────────

interface WikiEntity {
  id: string;           // "people/peter-yang"
  name: string;
  type: "people" | "tools" | "concepts" | "projects" | "areas";
  watch: boolean;
  last_seen: string | null;
  last_refreshed: string | null;
  sources: string[];
  related: string[];    // e.g. ["tools/claude-code", "concepts/curation"]
}

interface WikiSource {
  filename: string;
  date: string;
  title: string;
  entities_touched: string[];
}

interface WikiLensEntry {
  id: string;
  name: string;
  type: string;
  degree?: number;
  last_seen?: string | null;
}

interface WikiData {
  counts: { people: number; tools: number; concepts: number; projects: number; areas: number; sources: number };
  watchCount: number;
  lastRefreshed: string | null;
  recentSources: WikiSource[];
  entities: WikiEntity[];
  edges: Array<{ from: string; to: string }>;
  refreshQueue: number;
  lenses: {
    mostConnected: WikiLensEntry[];
    orphans: WikiLensEntry[];
    recentlyTouched: WikiLensEntry[];
  };
}

function parseWikiFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const body = match[1];
  const result: Record<string, unknown> = {};
  const lines = body.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && currentKey) {
      const item = line.replace(/^\s*-\s+/, "").trim();
      if (currentList) currentList.push(item);
      continue;
    }
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentList = null;
    }
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    currentKey = key;
    if (val === "") {
      currentList = [];
    } else if (val === "true" || val === "false") {
      result[key] = val === "true";
      currentKey = null;
    } else {
      result[key] = val.replace(/^["']|["']$/g, "");
      currentKey = null;
    }
  }
  if (currentKey && currentList) result[currentKey] = currentList;
  return result;
}

function getWikiData(): WikiData {
  const empty: WikiData = {
    counts: { people: 0, tools: 0, concepts: 0, projects: 0, sources: 0 },
    watchCount: 0,
    lastRefreshed: null,
    recentSources: [],
    entities: [],
    edges: [],
    refreshQueue: 0,
  };
  if (!existsSync(WIKI_DIR)) return empty;

  const ENTITY_TYPES: WikiEntity["type"][] = ["people", "tools", "concepts", "projects", "areas"];
  const entities: WikiEntity[] = [];
  const counts = { people: 0, tools: 0, concepts: 0, projects: 0, areas: 0, sources: 0 };
  let watchCount = 0;
  let latestRefresh: string | null = null;

  for (const type of ENTITY_TYPES) {
    const dir = join(WIKI_DIR, "entities", type);
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    counts[type] = files.length;
    for (const file of files) {
      const path = join(dir, file);
      let content = "";
      try {
        content = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const fm = parseWikiFrontmatter(content);
      const id = `${type}/${file.replace(/\.md$/, "")}`;
      const watch = fm.watch === true;
      if (watch) watchCount++;
      const lastRefreshed = typeof fm.last_refreshed === "string" ? fm.last_refreshed : null;
      if (lastRefreshed && (!latestRefresh || lastRefreshed > latestRefresh)) {
        latestRefresh = lastRefreshed;
      }
      entities.push({
        id,
        name: (fm.name as string) || file.replace(/\.md$/, ""),
        type,
        watch,
        last_seen: typeof fm.last_seen === "string" ? fm.last_seen : null,
        last_refreshed: lastRefreshed,
        sources: (fm.sources as string[]) || [],
        related: (fm.related as string[]) || [],
      });
    }
  }

  // Build entity ID set for edge validation
  const entityIds = new Set(entities.map((e) => e.id));
  const edges: Array<{ from: string; to: string }> = [];
  for (const entity of entities) {
    for (const rel of entity.related) {
      // related is "type/kebab-name" format
      if (entityIds.has(rel)) {
        edges.push({ from: entity.id, to: rel });
      }
    }
  }

  // Recent sources
  const sourcesDir = join(WIKI_DIR, "sources");
  const recentSources: WikiSource[] = [];
  if (existsSync(sourcesDir)) {
    let files: string[] = [];
    try {
      files = readdirSync(sourcesDir).filter((f) => f.endsWith(".md"));
    } catch {
      files = [];
    }
    // Filenames are YYYYMMDD-slug — sort desc
    files.sort().reverse();
    counts.sources = files.length;
    for (const file of files.slice(0, 10)) {
      const path = join(sourcesDir, file);
      let content = "";
      try {
        content = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const fm = parseWikiFrontmatter(content);
      const dateMatch = file.match(/^(\d{4})(\d{2})(\d{2})-/);
      const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";
      recentSources.push({
        filename: file,
        date,
        title: (fm.title as string) || file.replace(/\.md$/, ""),
        entities_touched: (fm.entities_touched as string[]) || [],
      });
    }
  }

  // Refresh queue
  let refreshQueue = 0;
  const queuePath = join(WIKI_DIR, "refresh-queue.json");
  if (existsSync(queuePath)) {
    try {
      const queue = JSON.parse(readFileSync(queuePath, "utf-8"));
      refreshQueue = Array.isArray(queue.items) ? queue.items.length : 0;
    } catch {}
  }

  // ─── Compiled lenses (replace the graph-as-default) ───
  // Degree = inbound + outbound edges
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.from, (degreeMap.get(e.from) || 0) + 1);
    degreeMap.set(e.to, (degreeMap.get(e.to) || 0) + 1);
  }

  const mostConnected: WikiLensEntry[] = entities
    .map((e) => ({ id: e.id, name: e.name, type: e.type, degree: degreeMap.get(e.id) || 0 }))
    .sort((a, b) => (b.degree || 0) - (a.degree || 0))
    .slice(0, 8);

  const orphans: WikiLensEntry[] = entities
    .filter((e) => (degreeMap.get(e.id) || 0) === 0)
    .map((e) => ({ id: e.id, name: e.name, type: e.type }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8);

  const recentlyTouched: WikiLensEntry[] = entities
    .filter((e) => e.last_seen)
    .map((e) => ({ id: e.id, name: e.name, type: e.type, last_seen: e.last_seen }))
    .sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""))
    .slice(0, 8);

  return {
    counts,
    watchCount,
    lastRefreshed: latestRefresh,
    recentSources,
    entities,
    edges,
    refreshQueue,
    lenses: { mostConnected, orphans, recentlyTouched },
  };
}

interface WikiEntityDetail {
  found: boolean;
  id: string;
  name: string;
  type: string;
  frontmatter: Record<string, unknown>;
  summary: string;           // first substantive paragraph (pre-compiled truth, not re-synthesized)
  sections: Array<{ heading: string; body: string }>;
  claimsBySource: Array<{ source: string; claims: string[] }>;
  contradictions: string;    // body of ## Contradictions section, if present
  related: Array<{ id: string; name: string; type: string; exists: boolean }>;
  // Reverse-lookup enrichment
  relatedFrom: Array<{ id: string; name: string; type: string }>;      // entities whose `related:` lists this one
  areasContaining: Array<{ id: string; name: string }>;                // areas where this appears in related
  conceptsOriginated: Array<{ id: string; name: string }>;             // concepts whose `origin:` names this person
  sourcesCiting: Array<{ filename: string; title: string; date: string }>; // sources where this appears in entities_touched
  sources: string[];
  editorUrl: string;         // vscode://file/...
  filePath: string;
}

function extractSections(body: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = body.split("\n");
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
      current = { heading: h[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
  return sections;
}

function getWikiEntity(id: string): WikiEntityDetail {
  const empty: WikiEntityDetail = {
    found: false, id, name: "", type: "", frontmatter: {}, summary: "",
    sections: [], claimsBySource: [], contradictions: "", related: [],
    relatedFrom: [], areasContaining: [], conceptsOriginated: [], sourcesCiting: [],
    sources: [],
    editorUrl: "", filePath: "",
  };
  const parts = id.split("/");
  if (parts.length !== 2) return empty;
  const [type, slug] = parts;
  const path = join(WIKI_DIR, "entities", type, `${slug}.md`);
  if (!existsSync(path)) return empty;

  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return empty;
  }
  const fm = parseWikiFrontmatter(content);
  // Strip frontmatter to get body
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");

  // First substantive paragraph = summary (after any H1)
  const bodyNoH1 = body.replace(/^#\s+.+\n/, "").trim();
  const firstPara = bodyNoH1.split(/\n\n+/).find((p) => p.trim() && !p.startsWith("#")) || "";

  const sections = extractSections(body);

  // Claims grouped by source — look for inline citations like "— *source-title (date)*"
  const claimsBySource = new Map<string, string[]>();
  for (const section of sections) {
    if (section.heading.toLowerCase().includes("contradiction")) continue;
    const lines = section.body.split("\n").filter((l) => l.trim().startsWith("-") || l.trim().startsWith("*"));
    for (const line of lines) {
      const citeMatch = line.match(/—\s*\*?([^*]+?)\*?$/);
      if (!citeMatch) continue;
      const source = citeMatch[1].trim();
      const claim = line.replace(/^\s*[-*]\s*/, "").replace(/—\s*\*?[^*]+?\*?$/, "").trim();
      if (!claimsBySource.has(source)) claimsBySource.set(source, []);
      claimsBySource.get(source)!.push(claim);
    }
  }

  const contradictionSection = sections.find((s) => s.heading.toLowerCase().includes("contradiction"));
  const contradictions = contradictionSection?.body.trim() || "";

  // Resolve related entities to check existence
  const relatedRaw = (fm.related as string[]) || [];
  const related = relatedRaw.map((rel) => {
    const relParts = rel.split("/");
    if (relParts.length !== 2) return { id: rel, name: rel, type: "", exists: false };
    const [relType, relSlug] = relParts;
    const relPath = join(WIKI_DIR, "entities", relType, `${relSlug}.md`);
    const exists = existsSync(relPath);
    let name = relSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (exists) {
      try {
        const relContent = readFileSync(relPath, "utf-8");
        const relFm = parseWikiFrontmatter(relContent);
        if (typeof relFm.name === "string") name = relFm.name;
      } catch {}
    }
    return { id: rel, name, type: relType, exists };
  });

  // ─── Reverse lookups ───
  // Scan all other entities once; cheap at our scale.
  const relatedFrom: Array<{ id: string; name: string; type: string }> = [];
  const areasContaining: Array<{ id: string; name: string }> = [];
  const conceptsOriginated: Array<{ id: string; name: string }> = [];
  const entityOwnName = (fm.name as string) || slug;
  const ALL_TYPES = ["people", "tools", "concepts", "projects", "areas"];
  for (const otherType of ALL_TYPES) {
    const oDir = join(WIKI_DIR, "entities", otherType);
    if (!existsSync(oDir)) continue;
    let oFiles: string[] = [];
    try { oFiles = readdirSync(oDir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const oFile of oFiles) {
      const oPath = join(oDir, oFile);
      if (oPath === path) continue;
      let oContent = "";
      try { oContent = readFileSync(oPath, "utf-8"); } catch { continue; }
      const oFm = parseWikiFrontmatter(oContent);
      const oName = (oFm.name as string) || oFile.replace(/\.md$/, "");
      const oId = `${otherType}/${oFile.replace(/\.md$/, "")}`;
      const oRelated = (oFm.related as string[]) || [];
      if (oRelated.includes(id)) {
        relatedFrom.push({ id: oId, name: oName, type: otherType });
        if (otherType === "areas") areasContaining.push({ id: oId, name: oName });
      }
      // Concepts originated by this person — concept.origin contains person's name
      if (type === "people" && otherType === "concepts") {
        const origin = (oFm.origin as string) || "";
        if (origin && origin.toLowerCase().includes(entityOwnName.toLowerCase())) {
          conceptsOriginated.push({ id: oId, name: oName });
        }
      }
    }
  }

  // Sources citing this entity (entities_touched in source frontmatter)
  const sourcesCiting: Array<{ filename: string; title: string; date: string }> = [];
  const sourcesDir = join(WIKI_DIR, "sources");
  if (existsSync(sourcesDir)) {
    let sFiles: string[] = [];
    try { sFiles = readdirSync(sourcesDir).filter((f) => f.endsWith(".md")); } catch { sFiles = []; }
    for (const sFile of sFiles) {
      let sContent = "";
      try { sContent = readFileSync(join(sourcesDir, sFile), "utf-8"); } catch { continue; }
      const sFm = parseWikiFrontmatter(sContent);
      const touched = (sFm.entities_touched as string[]) || [];
      if (touched.includes(id)) {
        const sTitle = (sFm.title as string) || sFile;
        const dateMatch = sFile.match(/^(\d{4})(\d{2})(\d{2})-/);
        const sDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";
        sourcesCiting.push({ filename: sFile, title: sTitle, date: sDate });
      }
    }
  }

  return {
    found: true,
    id,
    name: (fm.name as string) || slug,
    type,
    frontmatter: fm,
    summary: firstPara,
    sections,
    claimsBySource: Array.from(claimsBySource.entries()).map(([source, claims]) => ({ source, claims })),
    contradictions,
    related,
    relatedFrom,
    areasContaining,
    conceptsOriginated,
    sourcesCiting,
    sources: (fm.sources as string[]) || [],
    editorUrl: `vscode://file${path}`,
    filePath: path,
  };
}

interface WikiSourceDetail {
  found: boolean;
  filename: string;
  title: string;
  frontmatter: Record<string, unknown>;
  summary: string;
  keyTakeaways: string[];
  entitiesTouched: Array<{ id: string; name: string; type: string; exists: boolean }>;
  contradictionsFound: string;
  alignmentsFound: string;
  editorUrl: string;
  filePath: string;
  rawPath: string | null;
}

function getWikiSource(filename: string): WikiSourceDetail {
  const empty: WikiSourceDetail = {
    found: false, filename, title: "", frontmatter: {}, summary: "",
    keyTakeaways: [], entitiesTouched: [], contradictionsFound: "", alignmentsFound: "",
    editorUrl: "", filePath: "", rawPath: null,
  };
  if (!filename) return empty;
  const safe = basename(filename);
  const path = join(WIKI_DIR, "sources", safe);
  if (!existsSync(path)) return empty;

  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return empty;
  }
  const fm = parseWikiFrontmatter(content);
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const sections = extractSections(body);

  const summarySection = sections.find((s) => s.heading.toLowerCase() === "summary");
  const takeawaysSection = sections.find((s) => s.heading.toLowerCase().includes("takeaway"));
  const contradictionsSection = sections.find((s) => s.heading.toLowerCase().includes("contradiction"));
  const alignmentsSection = sections.find((s) => s.heading.toLowerCase().includes("alignment"));

  const keyTakeaways = takeawaysSection
    ? takeawaysSection.body
        .split("\n")
        .filter((l) => /^\s*[-*]/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
        .filter(Boolean)
    : [];

  const entitiesRaw = (fm.entities_touched as string[]) || [];
  const entitiesTouched = entitiesRaw.map((e) => {
    const parts = e.split("/");
    if (parts.length !== 2) return { id: e, name: e, type: "", exists: false };
    const [type, slug] = parts;
    const entityPath = join(WIKI_DIR, "entities", type, `${slug}.md`);
    const exists = existsSync(entityPath);
    let name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (exists) {
      try {
        const c = readFileSync(entityPath, "utf-8");
        const efm = parseWikiFrontmatter(c);
        if (typeof efm.name === "string") name = efm.name;
      } catch {}
    }
    return { id: e, name, type, exists };
  });

  const rawFilename = safe;
  const rawPath = join(WIKI_DIR, "raw", rawFilename);
  const rawExists = existsSync(rawPath);

  return {
    found: true,
    filename: safe,
    title: (fm.title as string) || safe,
    frontmatter: fm,
    summary: summarySection?.body.trim() || "",
    keyTakeaways,
    entitiesTouched,
    contradictionsFound: contradictionsSection?.body.trim() || "",
    alignmentsFound: alignmentsSection?.body.trim() || "",
    editorUrl: `vscode://file${path}`,
    filePath: path,
    rawPath: rawExists ? rawPath : null,
  };
}

interface WikiSearchHit {
  kind: "entity" | "source";
  id: string;                // entity id ("tools/claude-code") or source filename
  name: string;
  type: string;
  snippet: string;           // ~160 chars of matching context
  matchField: "name" | "body" | "frontmatter";
}

function searchWiki(query: string): { query: string; total: number; hits: WikiSearchHit[] } {
  const q = query.trim().toLowerCase();
  if (!q || q.length < 2) return { query, total: 0, hits: [] };
  const hits: WikiSearchHit[] = [];

  // Search entities across all four types
  const ENTITY_TYPES = ["people", "tools", "concepts", "projects"];
  for (const type of ENTITY_TYPES) {
    const dir = join(WIKI_DIR, "entities", type);
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const file of files) {
      const path = join(dir, file);
      let content = "";
      try { content = readFileSync(path, "utf-8"); } catch { continue; }
      const fm = parseWikiFrontmatter(content);
      const name = (fm.name as string) || file.replace(/\.md$/, "");
      const slug = file.replace(/\.md$/, "");
      const id = `${type}/${slug}`;
      const lcName = name.toLowerCase();
      const lcContent = content.toLowerCase();

      // Name match (highest priority)
      if (lcName.includes(q)) {
        hits.push({ kind: "entity", id, name, type, matchField: "name", snippet: name });
        continue;
      }
      // Body match
      const idx = lcContent.indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + q.length + 100);
        let snippet = content.slice(start, end).replace(/\n+/g, " ").replace(/\s+/g, " ");
        if (start > 0) snippet = "…" + snippet;
        if (end < content.length) snippet = snippet + "…";
        hits.push({ kind: "entity", id, name, type, matchField: "body", snippet });
      }
    }
  }

  // Search sources
  const sourcesDir = join(WIKI_DIR, "sources");
  if (existsSync(sourcesDir)) {
    let files: string[] = [];
    try { files = readdirSync(sourcesDir).filter((f) => f.endsWith(".md")); } catch { files = []; }
    for (const file of files) {
      const path = join(sourcesDir, file);
      let content = "";
      try { content = readFileSync(path, "utf-8"); } catch { continue; }
      const fm = parseWikiFrontmatter(content);
      const title = (fm.title as string) || file;
      const lcTitle = title.toLowerCase();
      const lcContent = content.toLowerCase();

      if (lcTitle.includes(q)) {
        hits.push({ kind: "source", id: file, name: title, type: "source", matchField: "name", snippet: title });
        continue;
      }
      const idx = lcContent.indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + q.length + 100);
        let snippet = content.slice(start, end).replace(/\n+/g, " ").replace(/\s+/g, " ");
        if (start > 0) snippet = "…" + snippet;
        if (end < content.length) snippet = snippet + "…";
        hits.push({ kind: "source", id: file, name: title, type: "source", matchField: "body", snippet });
      }
    }
  }

  // Sort: name matches first, then by kind (entities before sources)
  hits.sort((a, b) => {
    if (a.matchField === "name" && b.matchField !== "name") return -1;
    if (b.matchField === "name" && a.matchField !== "name") return 1;
    if (a.kind !== b.kind) return a.kind === "entity" ? -1 : 1;
    return 0;
  });

  return { query, total: hits.length, hits: hits.slice(0, 30) };
}

// ─── Phase 2: Intelligence APIs ─────────────────────────────────────────────

function getRatings() {
  const ratings: { timestamp: string; rating: number; source: string }[] = [];
  try {
    if (existsSync(RATINGS_PATH)) {
      const lines = readFileSync(RATINGS_PATH, "utf-8").split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          ratings.push({
            timestamp: r.timestamp,
            rating: r.rating,
            source: r.source || "unknown",
          });
        } catch {}
      }
    }
  } catch {}

  // 7-day moving average
  const sorted = ratings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const withMA: any[] = sorted.map((r, i) => {
    const window = sorted.slice(Math.max(0, i - 6), i + 1);
    const avg = window.reduce((s, x) => s + x.rating, 0) / window.length;
    return { ...r, movingAvg: Math.round(avg * 10) / 10 };
  });

  return {
    ratings: withMA,
    count: ratings.length,
    avg: ratings.length ? Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10 : 0,
    distribution: [1,2,3,4,5,6,7,8,9,10].map(n => ({
      rating: n,
      count: ratings.filter(r => r.rating === n).length,
    })),
  };
}

function getReflections() {
  const reflections: any[] = [];
  try {
    if (existsSync(REFLECTIONS_PATH)) {
      const lines = readFileSync(REFLECTIONS_PATH, "utf-8").split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          reflections.push({
            timestamp: r.timestamp,
            effortLevel: r.effort_level,
            task: r.task_description,
            criteriaCount: r.criteria_count,
            criteriaPassed: r.criteria_passed,
            criteriaFailed: r.criteria_failed,
            sentiment: r.implied_sentiment,
            withinBudget: r.within_budget,
          });
        } catch {}
      }
    }
  } catch {}

  const total = reflections.length;
  const totalCriteria = reflections.reduce((s, r) => s + (r.criteriaCount || 0), 0);
  const totalPassed = reflections.reduce((s, r) => s + (r.criteriaPassed || 0), 0);
  const withinBudget = reflections.filter(r => r.withinBudget).length;

  // Effort level distribution
  const effortDist: Record<string, number> = {};
  for (const r of reflections) {
    const e = r.effortLevel || "Unknown";
    effortDist[e] = (effortDist[e] || 0) + 1;
  }

  return {
    reflections,
    count: total,
    passRate: totalCriteria ? Math.round((totalPassed / totalCriteria) * 100) : 0,
    totalCriteria,
    totalPassed,
    budgetAdherence: total ? Math.round((withinBudget / total) * 100) : 0,
    effortDistribution: Object.entries(effortDist).map(([level, count]) => ({ level, count })),
    avgSentiment: total ? Math.round((reflections.reduce((s, r) => s + (r.sentiment || 0), 0) / total) * 10) / 10 : 0,
  };
}

function getSkillsTimeline() {
  const skills: { name: string; category: string; created: string }[] = [];
  try {
    const categories = readdirSync(SKILLS_DIR).filter(d => {
      try { return statSync(join(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
    });

    for (const cat of categories) {
      const scanDir = (dir: string) => {
        try {
          for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            try {
              const s = statSync(p);
              if (s.isDirectory()) scanDir(p);
              else if (entry === "SKILL.md") {
                // Get creation date (birthtime on macOS)
                const created = s.birthtime.toISOString().split("T")[0];
                const name = basename(dir);
                skills.push({ name, category: cat, created });
              }
            } catch {}
          }
        } catch {}
      };
      scanDir(join(SKILLS_DIR, cat));
    }
  } catch {}

  // Group by date for timeline
  const byDate: Record<string, number> = {};
  for (const s of skills) {
    byDate[s.created] = (byDate[s.created] || 0) + 1;
  }

  // Group by category
  const byCategory: Record<string, number> = {};
  for (const s of skills) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  }

  return {
    skills: skills.sort((a, b) => a.created.localeCompare(b.created)),
    total: skills.length,
    byDate: Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    byCategory: Object.entries(byCategory).sort(([,a], [,b]) => b - a).map(([category, count]) => ({ category, count })),
  };
}

function getStaleness() {
  const now = Date.now();
  const DAY_MS = 86400000;

  // Stale memory files (>14 days)
  const staleMemory: { name: string; daysSinceUpdate: number }[] = [];
  try {
    const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md"));
    for (const f of files) {
      try {
        const s = statSync(join(MEMORY_DIR, f));
        const days = Math.floor((now - s.mtimeMs) / DAY_MS);
        if (days > 14) staleMemory.push({ name: f, daysSinceUpdate: days });
      } catch {}
    }
  } catch {}

  // Stuck PRDs (non-COMPLETE, >7 days)
  const stuckPRDs: { name: string; status: string; daysSinceUpdate: number }[] = [];
  try {
    const scanPRDs = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) scanPRDs(p);
            else if (entry.startsWith("PRD-") && entry.endsWith(".md")) {
              const days = Math.floor((now - s.mtimeMs) / DAY_MS);
              if (days > 7) {
                const content = readFileSync(p, "utf-8");
                const statusMatch = content.match(/status:\s*(\S+)/);
                const status = statusMatch?.[1] || "unknown";
                if (status !== "COMPLETE") {
                  stuckPRDs.push({ name: entry, status, daysSinceUpdate: days });
                }
              }
            }
          } catch {}
        }
      } catch {}
    };
    scanPRDs(WORK_DIR);
  } catch {}

  // MEOC matrix — auto-classified from real data
  const meoc = {
    mitigate: [] as string[],
    eliminate: [] as string[],
    observe: [] as string[],
    contain: [] as string[],
  };

  // Mitigate: stuck PRDs
  for (const p of stuckPRDs.slice(0, 5)) {
    meoc.mitigate.push(`${p.name} (${p.status}, ${p.daysSinceUpdate}d stale)`);
  }

  // Eliminate: very stale memory files (>30 days)
  for (const m of staleMemory.filter(x => x.daysSinceUpdate > 30).slice(0, 5)) {
    meoc.eliminate.push(`${m.name} (${m.daysSinceUpdate}d untouched)`);
  }

  // Observe: moderately stale memory (14-30 days)
  for (const m of staleMemory.filter(x => x.daysSinceUpdate <= 30).slice(0, 5)) {
    meoc.observe.push(`${m.name} (${m.daysSinceUpdate}d)`);
  }

  // Contain: storage growth
  if (cachedStorage.totalGB > 2.5) {
    meoc.contain.push(`Total storage at ${cachedStorage.totalGB} GB`);
  }
  if (cachedStorage.transcriptGB > 1.5) {
    meoc.contain.push(`Transcripts at ${cachedStorage.transcriptGB} GB`);
  }

  return {
    staleMemory: staleMemory.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate),
    stuckPRDs: stuckPRDs.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate),
    staleMemoryCount: staleMemory.length,
    stuckPRDCount: stuckPRDs.length,
    meoc,
  };
}

function getTimeSavings() {
  const INCEPTION = new Date(); // Set your PAI start date
  const daysSince = Math.floor((Date.now() - INCEPTION.getTime()) / 86400000);

  // Estimated daily savings per automation (conservative ranges)
  const automations = [
    { name: "Morning Briefing", dailyMinsLow: 30, dailyMinsHigh: 45, description: "News, weather, calendar, health research" },
    { name: "Health Sync", dailyMinsLow: 10, dailyMinsHigh: 15, description: "WHOOP + Garmin + MFP data gathering" },
    { name: "Email Management", dailyMinsLow: 20, dailyMinsHigh: 30, description: "Inbox scanning, newsletter digest, archiving" },
    { name: "Calendar Sync", dailyMinsLow: 5, dailyMinsHigh: 10, description: "Outlook ICS → Google Calendar sync" },
    { name: "Finance Tracking", dailyMinsLow: 3, dailyMinsHigh: 5, description: "Transaction import, categorization" },
    { name: "Dashboard Upkeep", dailyMinsLow: 5, dailyMinsHigh: 10, description: "5 dashboards auto-maintained" },
  ];

  const totalDailyLow = automations.reduce((s, a) => s + a.dailyMinsLow, 0);
  const totalDailyHigh = automations.reduce((s, a) => s + a.dailyMinsHigh, 0);

  // Actual time together from DB (real conversations only, using active_mins for accuracy)
  let totalTogetherHrs = 0;
  let weekTogetherHrs = 0;
  let monthTogetherHrs = 0;
  try {
    const dbPath = join(HOME, ".claude/data/control-tower.db");
    if (existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const CONV = "message_count >= 2 AND duration_mins > 1";
      totalTogetherHrs = Math.round(((db.prepare(`SELECT COALESCE(SUM(active_mins), 0) AS m FROM sessions WHERE ${CONV}`).get() as any)?.m || 0) / 60 * 10) / 10;
      weekTogetherHrs = Math.round(((db.prepare(`SELECT COALESCE(SUM(active_mins), 0) AS m FROM sessions WHERE ${CONV} AND started_at >= date('now', '-7 days')`).get() as any)?.m || 0) / 60 * 10) / 10;
      monthTogetherHrs = Math.round(((db.prepare(`SELECT COALESCE(SUM(active_mins), 0) AS m FROM sessions WHERE ${CONV} AND started_at >= date('now', 'start of month')`).get() as any)?.m || 0) / 60 * 10) / 10;
      db.close();
    }
  } catch {}

  const weeklySavedLow = Math.round((totalDailyLow * 7) / 60 * 10) / 10;
  const weeklySavedHigh = Math.round((totalDailyHigh * 7) / 60 * 10) / 10;

  // Monthly savings (days so far this month)
  const now = new Date();
  const dayOfMonth = now.getDate();
  const monthlySavedLow = Math.round((totalDailyLow * dayOfMonth) / 60 * 10) / 10;
  const monthlySavedHigh = Math.round((totalDailyHigh * dayOfMonth) / 60 * 10) / 10;

  // Ratio: time saved vs time spent together
  // >1.0 means net positive (saving more than investing)
  const weeklyRatio = weekTogetherHrs > 0
    ? Math.round(((weeklySavedLow + weeklySavedHigh) / 2) / weekTogetherHrs * 10) / 10
    : 0;
  const totalRatio = totalTogetherHrs > 0
    ? Math.round(((totalDailyLow + totalDailyHigh) / 2 * daysSince / 60) / totalTogetherHrs * 10) / 10
    : 0;

  return {
    daysSinceInception: daysSince,
    automations,
    dailySavingsMins: { low: totalDailyLow, high: totalDailyHigh },
    cumulativeHrs: {
      low: Math.round((totalDailyLow * daysSince) / 60),
      high: Math.round((totalDailyHigh * daysSince) / 60),
    },
    weeklyHrs: { low: weeklySavedLow, high: weeklySavedHigh },
    monthlyHrs: { low: monthlySavedLow, high: monthlySavedHigh },
    timeTogetherHrs: { total: totalTogetherHrs, thisWeek: weekTogetherHrs, thisMonth: monthTogetherHrs },
    ratio: { weekly: weeklyRatio, total: totalRatio },
  };
}

// ─── PAI Maturity Model (PAIMM — Daniel Miessler) ───────────────────────────

function getMaturityAssessment() {
  // PAIMM v1.0 — 9 tiers across 3 macro-stages
  const tiers = [
    { id: "CH1", stage: "Chatbot", name: "Basic Chat", description: "Chat interface, no tools, no personal knowledge" },
    { id: "CH2", stage: "Chatbot", name: "Chat + Memory", description: "Basic tools, rudimentary memory, limited context" },
    { id: "CH3", stage: "Chatbot", name: "Advanced Chat", description: "Advanced tooling, better context, agents experimental" },
    { id: "AG1", stage: "Agent", name: "Standalone Agents", description: "Autonomous agents via frameworks, mostly ephemeral" },
    { id: "AG2", stage: "Agent", name: "Agent-First", description: "Controllable scaffolding, scheduled agents, voice acceleration" },
    { id: "AG3", stage: "Agent", name: "Agent Maturity", description: "Interactive + continuous background, local + cloud, highly steerable" },
    { id: "AS1", stage: "Assistant", name: "Named Assistant", description: "Trusted assistant using agents transparently, personality, voice-first" },
    { id: "AS2", stage: "Assistant", name: "Proactive Advocate", description: "Personality crystallised, state management, continuous monitoring" },
    { id: "AS3", stage: "Assistant", name: "Trusted Companion", description: "Full companion — monitoring, advocacy, protection, authentication" },
  ];

  // Six capability dimensions scored 0-100 — updated 9 Apr 2026
  const dimensions = [
    { name: "Context", score: 88, detail: "Goals, projects, stakeholders, health, finance, DNA, leadership, 185 skill-index, 78 memory files" },
    { name: "Personality", score: 82, detail: "Sage identity, voice, intro story, coaching frameworks, SkillForge methodology" },
    { name: "Tool Use", score: 92, detail: "185 skills, 43 hooks, 7 dashboards, MCP integrations, CLI tools, Sage AI chat with function calling" },
    { name: "Awareness", score: 75, detail: "HealthSync, CalendarSync, finance proactive alerts, debt trajectory tracking, recursive skill improvement" },
    { name: "Proactivity", score: 72, detail: "Sage proactive alerts, finance what-if engine, budget pace warnings, SkillDoctor auto-proposals" },
    { name: "Multitask Scale", score: 65, detail: "Up to 8 parallel agents, background tasks, agent teams, Groot VPS bridge" },
  ];

  const paimScore = 79.0; // Updated 9 Apr 2026 — post Sprint 1/2/3

  // Recent improvements — replaces old council fix burndown
  const councilFixes = [
    { id: 1, priority: "critical", description: "SkillForge — 4-phase skill creation methodology (Sprint 1)", done: true },
    { id: 2, priority: "critical", description: "Token Diet — PAI SKILL.md 28% reduction via progressive disclosure (Sprint 2)", done: true },
    { id: 3, priority: "critical", description: "SkillDoctor — recursive skill improvement in Algorithm LEARN phase (Sprint 3)", done: true },
    { id: 4, priority: "critical", description: "Finance Dashboard v2 — Sage AI chat with function calling (5 tools)", done: true },
    { id: 5, priority: "high", description: "Debt trajectory alerts + proactive Sage alerts on Today page", done: true },
    { id: 6, priority: "high", description: "Savings rate + interest burned metrics on Finance dashboard", done: true },
    { id: 7, priority: "high", description: "201 duplicate transactions cleaned, 14 merchant normalization rules", done: true },
    { id: 8, priority: "high", description: "4 new skills — HealthAnalysis, MeetingPrep, WeeklyReview, ProjectDashboard", done: true },
    { id: 9, priority: "high", description: "skill-index.json — 185 skills indexed for fast capability matching", done: true },
    { id: 10, priority: "high", description: "Command Center PAI System Status panel — dashboard fleet + inventory", done: true },
  ];

  // Current tier assessment — updated 9 Apr 2026
  const currentTier = "AG3";
  const currentIndex = tiers.findIndex(t => t.id === currentTier);
  const progressPct = Math.round(((currentIndex + 0.3) / tiers.length) * 100); // AG3.3

  // What's needed for AS1
  const nextMilestones = [
    "Voice as primary interface (Web Speech API integration)",
    "Full autonomous daily operations without prompting",
    "Cross-device state sync (Mac + iPhone + VPS)",
    "Natural language budget management via Sage chat",
    "Authentication layer for network-exposed dashboards",
  ];

  return {
    tiers,
    dimensions,
    paimScore,
    councilFixes,
    criticalDone: councilFixes.filter(f => f.priority === "critical" && f.done).length,
    criticalTotal: councilFixes.filter(f => f.priority === "critical").length,
    highDone: councilFixes.filter(f => f.priority === "high" && f.done).length,
    highTotal: councilFixes.filter(f => f.priority === "high").length,
    currentTier,
    currentIndex,
    progressPct,
    nextTier: tiers[currentIndex + 1]?.id || "AS3",
    nextTierName: tiers[currentIndex + 1]?.name || "Trusted Companion",
    nextMilestones,
    // SkillDoctor self-healing awareness
    skillDoctor: (() => {
      try {
        const jsonlPath = join(HOME, ".claude/MEMORY/LEARNING/skill-failures.jsonl");
        if (!existsSync(jsonlPath)) return { failures: 0, recentFixes: [], active: true };
        const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
        const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const recent = entries.slice(-5).reverse();
        return { failures: entries.length, recentFixes: recent, active: true };
      } catch { return { failures: 0, recentFixes: [], active: true }; }
    })(),
    // SkillForge stats
    skillForge: {
      installed: existsSync(join(HOME, ".claude/skills/Utilities/SkillForge/SKILL.md")),
      methodology: "Walk Through → Succeed → Codify → Test",
    },
    source: "danielmiessler.com/blog/personal-ai-maturity-model",
  };
}

// ─── Machine Health API ──────────────────────────────────────────────────────

let cachedMachine: MachineHealth | null = null;
let machineCacheTime = 0;
const MACHINE_CACHE_TTL = 30000; // 30 seconds

async function getMachineHealth(): Promise<MachineHealth> {
  if (cachedMachine && Date.now() - machineCacheTime < MACHINE_CACHE_TTL) return cachedMachine;

  const run = (cmd: string) => {
    try {
      const result = Bun.spawnSync(["bash", "-c", cmd], {
        env: { ...process.env, PATH: "/usr/sbin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" },
      });
      return result.stdout.toString().trim();
    } catch { return ""; }
  };

  // CPU
  const cpuModel = run("sysctl -n machdep.cpu.brand_string");
  const cpuCores = parseInt(run("sysctl -n hw.ncpu")) || 0;
  const loadAvgRaw = run("sysctl -n vm.loadavg");
  const loadAvg = (loadAvgRaw.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

  // Top processes
  const psOutput = run("ps -eo pcpu,pmem,comm -r | head -8 | tail -7");
  const topProcesses = psOutput.split("\n").filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    const cpu = parseFloat(parts[0]) || 0;
    const mem = parseFloat(parts[1]) || 0;
    const fullPath = parts.slice(2).join(" ");
    const name = fullPath.split("/").pop()?.replace(/\.app$/, "") || fullPath;
    return { name: name.slice(0, 30), cpu, mem };
  }).slice(0, 5);

  // Memory
  const totalBytes = parseInt(run("sysctl -n hw.memsize")) || 0;
  const totalGB = totalBytes / 1073741824;
  const vmStat = run("vm_stat");
  const pageSize = 16384;
  const getPages = (label: string) => {
    const match = vmStat.match(new RegExp(`${label}:\\s+(\\d+)`));
    return (parseInt(match?.[1] || "0") || 0) * pageSize;
  };
  const freePages = getPages("Pages free") + getPages("Pages speculative");
  const wiredBytes = getPages("Pages wired down");
  const activeBytes = getPages("Pages active");
  const inactiveBytes = getPages("Pages inactive");
  const usedBytes = activeBytes + wiredBytes; // active + wired = truly used
  const freeBytes = totalBytes - usedBytes;
  const freeGB = Math.max(0, freeBytes / 1073741824);
  const usedGB = usedBytes / 1073741824;
  const wiredGB = wiredBytes / 1073741824;
  const pressurePct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  // Disk
  const dfOutput = run("df -k / | tail -1");
  const dfParts = dfOutput.split(/\s+/);
  const diskTotalKB = parseInt(dfParts[1]) || 0;
  const diskFreeKB = parseInt(dfParts[3]) || 0; // "Available" column — real free space
  // On APFS, df "Used" column only shows volume-unique data, not actual consumption
  // Real used = total - available (includes snapshots, purgeable, system data)
  const diskUsedKB = diskTotalKB - diskFreeKB;
  const diskTotalGB = Math.round(diskTotalKB / 1048576 * 10) / 10;
  const diskUsedGB = Math.round(diskUsedKB / 1048576 * 10) / 10;
  const diskFreeGB = Math.round(diskFreeKB / 1048576 * 10) / 10;
  const diskUsedPct = diskTotalKB > 0 ? Math.round(diskUsedKB / diskTotalKB * 100) : 0;

  // Disk breakdown
  const duOutput = run("du -sk ~/Library ~/Downloads ~/Documents ~/Desktop ~/.claude /Applications 2>/dev/null | sort -rnk1");
  const breakdown = duOutput.split("\n").filter(l => l.trim()).map(line => {
    const parts = line.split("\t");
    const sizeKB = parseInt(parts[0]) || 0;
    const path = (parts[1] || "").replace(/^\/Users\/[^/]+\//, "~/");
    return { name: path.split("/").pop() || path, sizeGB: Math.round(sizeKB / 1048576 * 10) / 10 };
  }).filter(d => d.sizeGB >= 0.1);

  // Battery
  const batteryRaw = run("ioreg -r -c AppleSmartBattery");
  const getBattInt = (key: string) => {
    const match = batteryRaw.match(new RegExp(`"${key}"\\s*=\\s*(\\d+)`));
    return parseInt(match?.[1] || "0") || 0;
  };
  const cycleCount = getBattInt("CycleCount");
  const designCap = getBattInt("DesignCapacity");
  const maxCap = getBattInt("MaxCapacity");
  const currentCap = getBattInt("CurrentCapacity");
  const isCharging = batteryRaw.includes('"IsCharging" = Yes');
  const healthPct = maxCap; // MaxCapacity is already a percentage on modern Macs

  // Uptime
  const uptimeRaw = run("sysctl -n kern.boottime");
  const bootMatch = uptimeRaw.match(/sec\s*=\s*(\d+)/);
  const bootSec = parseInt(bootMatch?.[1] || "0") || 0;
  const uptimeHours = bootSec > 0 ? Math.round((Date.now() / 1000 - bootSec) / 3600 * 10) / 10 : 0;
  const uptimeDays = Math.floor(uptimeHours / 24);
  const uptimeHrsRem = Math.round(uptimeHours % 24);
  const uptimeFormatted = uptimeDays > 0 ? `${uptimeDays}d ${uptimeHrsRem}h` : `${uptimeHrsRem}h`;

  // Recommendations
  const recommendations: string[] = [];
  if (diskUsedPct > 80) recommendations.push(`Disk is ${diskUsedPct}% full — consider clearing caches or large files`);
  if (diskFreeGB < 50) recommendations.push(`Only ${diskFreeGB} GB free — review Downloads and Library folders`);
  if (pressurePct > 85) recommendations.push(`Memory pressure at ${pressurePct}% — close unused apps to free RAM`);
  if (uptimeHours > 168) recommendations.push(`System uptime is ${uptimeFormatted} — consider a restart for performance`);
  if (cycleCount > 500) recommendations.push(`Battery has ${cycleCount} cycles — monitor battery health`);
  const heavyCpu = topProcesses.filter(p => p.cpu > 50);
  for (const p of heavyCpu) {
    recommendations.push(`${p.name} is using ${p.cpu.toFixed(0)}% CPU`);
  }
  if (recommendations.length === 0) recommendations.push("System is running healthy — no issues detected");

  const result: MachineHealth = {
    cpu: { model: cpuModel, cores: cpuCores, loadAvg, topProcesses },
    memory: { totalGB: Math.round(totalGB * 10) / 10, usedGB: Math.round(usedGB * 10) / 10, freeGB: Math.round(freeGB * 10) / 10, pressurePct, wiredGB: Math.round(wiredGB * 10) / 10 },
    disk: { totalGB: diskTotalGB, usedGB: diskUsedGB, freeGB: diskFreeGB, usedPct: diskUsedPct, breakdown },
    battery: { cycleCount, health: healthPct, currentPct: currentCap, isCharging, designCapacity: designCap, maxCapacity: maxCap },
    uptime: { hours: uptimeHours, formatted: uptimeFormatted },
    recommendations,
  };

  cachedMachine = result;
  machineCacheTime = Date.now();
  return result;
}

// ─── Phase 4: Network & Discovery APIs ───────────────────────────────────────

function getAgentNetwork(db: Database) {
  // Nodes: agent types with spawn counts
  const nodeRows = db.prepare(`
    SELECT agent_type, COUNT(*) as cnt
    FROM agent_spawns
    GROUP BY agent_type
    ORDER BY cnt DESC
  `).all() as { agent_type: string; cnt: number }[];

  const nodes = nodeRows.map(r => ({
    id: r.agent_type,
    count: r.cnt,
  }));

  // Edges: co-occurrence (same session)
  const edgeRows = db.prepare(`
    SELECT a1.agent_type as source, a2.agent_type as target, COUNT(DISTINCT a1.session_id) as weight
    FROM agent_spawns a1
    JOIN agent_spawns a2 ON a1.session_id = a2.session_id AND a1.agent_type < a2.agent_type
    GROUP BY a1.agent_type, a2.agent_type
    HAVING weight >= 2
    ORDER BY weight DESC
  `).all() as { source: string; target: string; weight: number }[];

  const edges = edgeRows.map(r => ({
    source: r.source,
    target: r.target,
    weight: r.weight,
  }));

  // Top skills by invocation count
  const skillRows = db.prepare(`
    SELECT skill_name, COUNT(*) as total
    FROM skill_invocations
    GROUP BY skill_name
    ORDER BY total DESC
    LIMIT 15
  `).all() as { skill_name: string; total: number }[];

  const topSkills = skillRows.map(r => ({
    name: r.skill_name,
    count: r.total,
  }));

  // Top agent types by spawn count (reuse node data)
  const topAgents = nodes.slice(0, 12).map(n => ({
    name: n.id,
    count: n.count,
  }));

  return { nodes, edges, topSkills, topAgents };
}

function getOpportunities(db: Database) {
  const recommendations: { category: string; priority: string; message: string; detail: string }[] = [];

  // 1. Stuck PRDs (>7 days, not COMPLETE)
  const now = Date.now();
  const DAY_MS = 86400000;
  const seenPRDs = new Set<string>();
  try {
    const scanPRDs = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) scanPRDs(p);
            else if (entry.startsWith("PRD-") && entry.endsWith(".md") && !seenPRDs.has(entry)) {
              seenPRDs.add(entry);
              const days = Math.floor((now - s.mtimeMs) / DAY_MS);
              if (days > 7) {
                const content = readFileSync(p, "utf-8");
                const statusMatch = content.match(/status:\s*(\S+)/);
                const status = statusMatch?.[1] || "unknown";
                // DRAFT PRDs are parked, not stuck — only flag IN_PROGRESS or PLANNED
                const activeStatuses = ["IN_PROGRESS", "in_progress", "PLANNED", "planned", "VERIFYING", "verifying"];
                if (activeStatuses.includes(status)) {
                  const priority = days > 14 ? "high" : "medium";
                  recommendations.push({
                    category: "stuck_prd",
                    priority,
                    message: `Resume or archive ${entry} (stuck ${days} days, status: ${status})`,
                    detail: entry,
                  });
                } else if (status === "DRAFT" && days > 30) {
                  // DRAFTs only flagged after 30 days as low priority
                  recommendations.push({
                    category: "stuck_prd",
                    priority: "low",
                    message: `Archive or start ${entry} (draft for ${days} days)`,
                    detail: entry,
                  });
                }
              }
            }
          } catch {}
        }
      } catch {}
    };
    scanPRDs(WORK_DIR);
  } catch {}

  // 2. Skills never invoked — cross-ref skill names against skill_invocations table
  const invokedSkillNames = new Set<string>();
  try {
    // Primary source: actual Skill tool calls tracked in skill_invocations table
    const invocations = db.prepare(`
      SELECT DISTINCT LOWER(skill_name) as name FROM skill_invocations
    `).all() as { name: string }[];
    for (const row of invocations) {
      invokedSkillNames.add(row.name);
    }
    // Secondary source: task descriptions mentioning skill names (fuzzy backup)
    const taskDescriptions = db.prepare(`
      SELECT DISTINCT task_description FROM sessions WHERE task_description IS NOT NULL
    `).all() as { task_description: string }[];
    for (const t of taskDescriptions) {
      const desc = (t.task_description || "").toLowerCase();
      // Will be checked against skill names below
      invokedSkillNames.add(`__desc:${desc}`);
    }
  } catch {}

  // Get all skill names (top-level skills only, skip sub-directories that are components)
  const allSkillNames: string[] = [];
  const metaSkills = new Set(["PAI", "Releases", "Components", "Tools", "Hooks", "SYSTEM", "USER"]);
  try {
    const categories = readdirSync(SKILLS_DIR).filter(d => {
      try { return statSync(join(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const cat of categories) {
      if (metaSkills.has(cat)) continue;
      const scanSkills = (dir: string) => {
        try {
          for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            try {
              const s = statSync(p);
              if (s.isDirectory()) scanSkills(p);
              else if (entry === "SKILL.md") {
                allSkillNames.push(basename(dir));
              }
            } catch {}
          }
        } catch {}
      };
      scanSkills(join(SKILLS_DIR, cat));
    }
  } catch {}

  // Cross-reference: check if skill was invoked via Skill tool or mentioned in task descriptions
  const uninvokedSkills = allSkillNames.filter(skillName => {
    const lower = skillName.toLowerCase();
    // Check direct invocation via skill_invocations table
    if (invokedSkillNames.has(lower)) return false;
    // Check fuzzy match against task descriptions
    for (const key of invokedSkillNames) {
      if (key.startsWith("__desc:") && key.includes(lower)) return false;
    }
    return true;
  });

  for (const skill of uninvokedSkills.slice(0, 10)) {
    recommendations.push({
      category: "uninvoked_skill",
      priority: "low",
      message: `Skill "${skill}" has not been detected in session activity — review or remove`,
      detail: skill,
    });
  }

  // 3. Storage growth warning
  if (cachedStorage.totalGB > 3.0) {
    recommendations.push({
      category: "storage",
      priority: "medium",
      message: `PAI storage at ${cachedStorage.totalGB} GB — consider archiving old transcripts`,
      detail: `${cachedStorage.transcriptGB} GB in transcripts`,
    });
  }

  // 4. Failed algorithm patterns (from reflections)
  try {
    if (existsSync(REFLECTIONS_PATH)) {
      const lines = readFileSync(REFLECTIONS_PATH, "utf-8").split("\n").filter(l => l.trim());
      let overBudgetCount = 0;
      let failedCriteria = 0;
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (!r.within_budget) overBudgetCount++;
          failedCriteria += r.criteria_failed || 0;
        } catch {}
      }
      if (overBudgetCount > 2) {
        recommendations.push({
          category: "algorithm",
          priority: "medium",
          message: `${overBudgetCount}/${lines.length} algorithm runs exceeded time budget — review effort level selection`,
          detail: `${failedCriteria} total criteria failed`,
        });
      }
    }
  } catch {}

  // 5. Stale memory files — severity tiers (critical > watch > stable)
  // Critical: files that should be updated regularly (finance, stakeholders, weekly logs)
  const criticalPatterns = /finance|stakeholder|week-|daily-|briefing|calendar/i;
  // Stable: reference docs that are stale by design (coaching, frameworks, profiles, specs)
  const stablePatterns = /framework|profile|spec|coaching|poem|intro-story|dna-|roadmap|architecture/i;
  try {
    const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md"));
    let criticalStale = 0;
    let watchStale = 0;
    let stableStale = 0;
    for (const f of files) {
      try {
        const s = statSync(join(MEMORY_DIR, f));
        const days = Math.floor((now - s.mtimeMs) / DAY_MS);
        if (days > 14) {
          if (stablePatterns.test(f)) { stableStale++; }
          else if (criticalPatterns.test(f) && days > 14) { criticalStale++; }
          else if (days > 30) { watchStale++; }
        }
      } catch {}
    }
    if (criticalStale > 0) {
      recommendations.push({
        category: "memory",
        priority: "high",
        message: `${criticalStale} critical memory files stale 14+ days (finance/stakeholders/weekly)`,
        detail: "Review critical memory files",
      });
    }
    if (watchStale > 0) {
      recommendations.push({
        category: "memory",
        priority: "low",
        message: `${watchStale} project memory files untouched 30+ days — audit if still relevant`,
        detail: "Run memory cleanup",
      });
    }
    // Stable files are intentionally static — don't flag them
  } catch {}

  // Sort by priority
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));

  return {
    recommendations,
    counts: {
      total: recommendations.length,
      high: recommendations.filter(r => r.priority === "high").length,
      medium: recommendations.filter(r => r.priority === "medium").length,
      low: recommendations.filter(r => r.priority === "low").length,
    },
    uninvokedSkillCount: uninvokedSkills.length,
    stuckPRDCount: recommendations.filter(r => r.category === "stuck_prd").length,
  };
}

function getSystemStatus() {
  return {
    voiceServer: cachedSystemStatus.voiceServer,
    ollama: cachedSystemStatus.ollama,
    telegramBot: cachedSystemStatus.telegramBot,
    groot: cachedSystemStatus.groot,
    grootUptime: cachedSystemStatus.grootUptime,
    paiVersion: "4.0.3",
    algorithmVersion: "3.7.0",
  };
}

// ─── Next Best Action API ──────────────────────────────────────────────────

function getNextActions(db: Database): { actions: { title: string; reason: string; category: string; priority: number }[] } {
  const actions: { title: string; reason: string; category: string; priority: number }[] = [];
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun

  // Sunday finance check
  if (dayOfWeek === 0) {
    actions.push({ title: "Run Sunday Finance Check-In", reason: "It's Sunday — weekly spending review, debt pulse, bills preview", category: "ritual", priority: 1 });
  }

  // Check for stale critical memory files
  try {
    const criticalPatterns = /finance|stakeholder|week-/i;
    const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md"));
    let staleCount = 0;
    for (const f of files) {
      try {
        const s = statSync(join(MEMORY_DIR, f));
        const days = Math.floor((Date.now() - s.mtimeMs) / 86400000);
        if (criticalPatterns.test(f) && days > 7) staleCount++;
      } catch {}
    }
    if (staleCount > 0) {
      actions.push({ title: `Update ${staleCount} stale critical memory files`, reason: "Finance/stakeholder/weekly files untouched 7+ days", category: "maintenance", priority: 2 });
    }
  } catch {}

  // Check for stuck active PRDs
  try {
    const activeStatuses = ["IN_PROGRESS", "in_progress", "PLANNED", "planned"];
    const scanPRDs = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) scanPRDs(p);
            else if (entry.startsWith("PRD-") && entry.endsWith(".md")) {
              const days = Math.floor((Date.now() - s.mtimeMs) / 86400000);
              if (days > 7) {
                const content = readFileSync(p, "utf-8");
                const statusMatch = content.match(/status:\s*(\S+)/);
                if (statusMatch && activeStatuses.includes(statusMatch[1])) {
                  actions.push({ title: `Resume PRD: ${entry.replace(/\.md$/, "")}`, reason: `Active PRD untouched for ${days} days`, category: "project", priority: 3 });
                }
              }
            }
          } catch {}
        }
      } catch {}
    };
    scanPRDs(WORK_DIR);
  } catch {}

  // Check recently invoked skills for suggestions
  try {
    const recentSkills = db.prepare(`
      SELECT skill_name, COUNT(*) as cnt FROM skill_invocations
      WHERE invoked_at >= date('now', '-7 days')
      GROUP BY skill_name ORDER BY cnt DESC LIMIT 3
    `).all() as { skill_name: string; cnt: number }[];
    if (recentSkills.length > 0) {
      const names = recentSkills.map(s => s.skill_name).join(", ");
      actions.push({ title: `Continue momentum: ${names}`, reason: "Most-used skills this week — keep the streak", category: "momentum", priority: 4 });
    }
  } catch {}

  // AG3 council fixes remaining
  const maturity = getMaturityAssessment();
  const remaining = maturity.councilFixes.filter(f => !f.done);
  if (remaining.length > 0) {
    actions.push({ title: `${remaining.length} AG3 council fixes remaining`, reason: `PAIMM ${maturity.paimScore} → target 75+ for AG3`, category: "maturity", priority: 5 });
  }

  // Sort by priority, return top 3
  actions.sort((a, b) => a.priority - b.priority);
  return { actions: actions.slice(0, 3) };
}

// ─── Session Intent / Project Drift API ────────────────────────────────────

function getSessionIntent(db: Database): {
  projects: { name: string; sessions: number; lastActive: string; daysAgo: number }[];
  driftWarnings: string[];
} {
  const projectKeywords: Record<string, string[]> = {
    "RivaFlow": ["rivaflow", "riva", "sweet_spot", "bjj", "jiu jitsu"],
    "Finance": ["finance", "debt", "spending", "budget", "transaction", "sunday money", "dashboard", "rent", "savings rate"],
    "Control Tower": ["control tower", "control-tower", "command center"],
    "Sage Capture": ["sage capture", "telegram", "sage inbox", "capture app"],
    "Pharma Link": ["pharma", "wms", "warehouse", "vanya"],
    "AI Art": ["ai art", "post-photographic", "firefly", "no crew", "bag man", "character"],
    "Groot": ["groot", "vps", "hostinger", "openclaw"],
    "PAI Core": ["algorithm", "pai", "skill", "hook", "steering", "skillforge", "skilldoctor", "token diet", "paimm", "capability"],
    "Health": ["health", "whoop", "garmin", "recovery", "hrv"],
    "Email": ["email", "newsletter", "inbox", "briefing", "morning"],
    "Coaching": ["coaching", "multiplier", "diminisher", "wiseman", "goal editor"],
    "Work": ["work", "stakeholder", "meeting prep"],
  };

  const projects: { name: string; sessions: number; lastActive: string; daysAgo: number }[] = [];

  try {
    const sessions = db.prepare(`
      SELECT task_description, started_at, id FROM sessions
      WHERE message_count >= 2 AND task_description IS NOT NULL AND LENGTH(task_description) > 10
      ORDER BY started_at DESC
    `).all() as any[];

    const projectCounts: Record<string, { count: number; lastActive: string }> = {};

    for (const s of sessions) {
      const desc = (s.task_description || "").toLowerCase();
      for (const [project, keywords] of Object.entries(projectKeywords)) {
        if (keywords.some(kw => desc.includes(kw))) {
          if (!projectCounts[project]) {
            projectCounts[project] = { count: 0, lastActive: s.started_at };
          }
          projectCounts[project].count++;
          if (s.started_at > projectCounts[project].lastActive) {
            projectCounts[project].lastActive = s.started_at;
          }
        }
      }
    }

    for (const [name, data] of Object.entries(projectCounts)) {
      const daysAgo = Math.floor((Date.now() - new Date(data.lastActive).getTime()) / 86400000);
      projects.push({ name, sessions: data.count, lastActive: data.lastActive, daysAgo });
    }
    projects.sort((a, b) => b.sessions - a.sessions);
  } catch {}

  // Drift warnings: projects not touched in 14+ days that have active PRDs
  const driftWarnings: string[] = [];
  for (const p of projects) {
    if (p.daysAgo > 14) {
      driftWarnings.push(`${p.name}: ${p.daysAgo} days since last session`);
    }
  }

  return { projects, driftWarnings };
}

// ─── Departments API ──────────────────────────────────────────────────────

const DEPARTMENTS_PATH = join(HOME, ".claude/data/departments.json");

function getDepartments(db: Database) {
  let departments: any[] = [];
  try {
    if (existsSync(DEPARTMENTS_PATH)) {
      const data = JSON.parse(readFileSync(DEPARTMENTS_PATH, "utf-8"));
      departments = data.departments || [];
    }
  } catch {}

  // Enrich with activity data from skill_invocations
  const enriched = departments.map((dept: any) => {
    const skills = dept.skills || [];
    let totalSessions = 0;
    let weekSessions = 0;
    let lastActive = "";

    for (const skill of skills) {
      try {
        const row = db.prepare(`
          SELECT COUNT(DISTINCT session_id) as cnt FROM skill_invocations
          WHERE LOWER(skill_name) = LOWER(?)
        `).get(skill) as { cnt: number } | undefined;
        if (row) totalSessions += row.cnt;

        const weekRow = db.prepare(`
          SELECT COUNT(DISTINCT session_id) as cnt FROM skill_invocations
          WHERE LOWER(skill_name) = LOWER(?) AND invoked_at >= date('now', '-7 days')
        `).get(skill) as { cnt: number } | undefined;
        if (weekRow) weekSessions += weekRow.cnt;

        const lastRow = db.prepare(`
          SELECT MAX(invoked_at) as last_at FROM skill_invocations
          WHERE LOWER(skill_name) = LOWER(?)
        `).get(skill) as { last_at: string | null } | undefined;
        if (lastRow?.last_at && lastRow.last_at > lastActive) {
          lastActive = lastRow.last_at;
        }
      } catch {}
    }

    const daysAgo = lastActive
      ? Math.floor((Date.now() - new Date(lastActive).getTime()) / 86400000)
      : -1;

    return {
      ...dept,
      totalSessions,
      weekSessions,
      lastActive: lastActive || null,
      daysAgo,
      skillCount: skills.length,
    };
  });

  return { departments: enriched };
}

// ─── Bearer Token Auth ────────────────────────────────────────────────────

const TOKEN_PATH = join(HOME, ".claude/data/control-tower-token");

function getOrCreateToken(): string {
  try {
    if (existsSync(TOKEN_PATH)) {
      return readFileSync(TOKEN_PATH, "utf-8").trim();
    }
  } catch {}
  // Generate a random token
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  try {
    const { writeFileSync, chmodSync } = require("fs");
    writeFileSync(TOKEN_PATH, token, "utf-8");
    chmodSync(TOKEN_PATH, 0o600);
  } catch {}
  return token;
}

// ─── Server ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("🗼 PAI Control Tower starting...");

  // Initialize DB and run initial sync
  const db = initDB();
  console.log("📦 Database initialized at", DB_PATH);

  console.log("🔄 Running initial transcript sync...");
  const syncResult = await syncTranscripts(db);
  console.log(`✅ Sync complete: ${syncResult.processed} processed, ${syncResult.skipped} skipped`);

  // Compute initial caches (async, non-blocking)
  refreshStorageCache();
  refreshHealthCache();

  // Schedule periodic sync every 30 minutes + health cache every 2 minutes
  setInterval(async () => {
    try {
      const result = await syncTranscripts(db);
      console.log(`🔄 Periodic sync: ${result.processed} processed, ${result.skipped} skipped`);
    } catch (err) {
      console.error("Sync error:", err);
    }
  }, 30 * 60 * 1000);

  // Refresh health + storage cache every 2 minutes
  setInterval(async () => {
    try { await refreshHealthCache(); } catch {}
    if (Date.now() - cachedStorage.computedAt > STORAGE_CACHE_TTL) {
      try { await refreshStorageCache(); } catch {}
    }
  }, 2 * 60 * 1000);

  // Load dashboard HTML and inject auth token
  const authToken = getOrCreateToken();
  console.log(`🔒 Auth token loaded (${authToken.slice(0, 8)}...)`);

  const htmlPath = join(PUBLIC_DIR, "control-tower.html");
  let dashboardHTML = "";
  try {
    dashboardHTML = readFileSync(htmlPath, "utf-8");
  } catch {
    dashboardHTML = "<html><body><h1>Control Tower HTML not found</h1></body></html>";
  }
  // Inject token into HTML so fetch calls can include it
  dashboardHTML = dashboardHTML.replace(
    "/*__AUTH_TOKEN__*/",
    `const CT_AUTH_TOKEN = "${authToken}";`
  );

  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") return Response.json({ status: "ok", service: "control-tower" });

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(dashboardHTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Auth check for all /api/* endpoints
      if (url.pathname.startsWith("/api/")) {
        const authHeader = req.headers.get("Authorization") || "";
        const providedToken = authHeader.replace("Bearer ", "");
        const queryToken = url.searchParams.get("token") || "";
        if (providedToken !== authToken && queryToken !== authToken) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname === "/api/metrics") {
        const metrics = getCoreMetrics(db);
        return new Response(JSON.stringify(metrics), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/inventory") {
        const inventory = getSystemInventory();
        return new Response(JSON.stringify(inventory), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/status") {
        const status = getSystemStatus();
        return new Response(JSON.stringify(status), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Phase 2: Intelligence endpoints
      if (url.pathname === "/api/ratings") {
        return new Response(JSON.stringify(getRatings()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/reflections") {
        return new Response(JSON.stringify(getReflections()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/skills-timeline") {
        return new Response(JSON.stringify(getSkillsTimeline()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/staleness") {
        return new Response(JSON.stringify(getStaleness()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/time-savings") {
        return new Response(JSON.stringify(getTimeSavings()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/maturity") {
        return new Response(JSON.stringify(getMaturityAssessment()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/wiki") {
        return new Response(JSON.stringify(getWikiData()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // /api/wiki/entity?id=tools/claude-code
      if (url.pathname === "/api/wiki/entity") {
        const id = url.searchParams.get("id") || "";
        return new Response(JSON.stringify(getWikiEntity(id)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // /api/wiki/source?filename=20260418-allie-claudpedia.md
      if (url.pathname === "/api/wiki/source") {
        const filename = url.searchParams.get("filename") || "";
        return new Response(JSON.stringify(getWikiSource(filename)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // /api/wiki/search?q=karpathy
      if (url.pathname === "/api/wiki/search") {
        const q = url.searchParams.get("q") || "";
        return new Response(JSON.stringify(searchWiki(q)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Phase 4: Network & Discovery endpoints
      if (url.pathname === "/api/agent-network") {
        return new Response(JSON.stringify(getAgentNetwork(db)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/opportunities") {
        return new Response(JSON.stringify(getOpportunities(db)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/machine") {
        const machine = await getMachineHealth();
        return new Response(JSON.stringify(machine), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/backup-health") {
        // Read the health JSON written by SageCheck.ts
        try {
          const healthPath = join(HOME, ".claude/data/sage-backup-health.json");
          const health = JSON.parse(readFileSync(healthPath, "utf-8"));
          // Enrich with staleness check
          const lastRunMs = new Date(health.lastRun).getTime();
          const hoursAgo = (Date.now() - lastRunMs) / (1000 * 60 * 60);
          health.hours_since_last_check = Math.round(hoursAgo * 10) / 10;
          health.stale = hoursAgo > (7 * 24 + 6); // stale if > 7 days 6 hours
          return new Response(JSON.stringify(health), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({
            overall: "UNKNOWN",
            error: "sage-backup-health.json not yet written — first check runs Monday 6:30 AM",
          }), { headers: { "Content-Type": "application/json" }, status: 200 });
        }
      }

      if (url.pathname === "/api/render-health") {
        // Read the snapshot written by RenderMonitor.ts (updated every 30 min)
        try {
          const snapPath = join(HOME, ".claude/data/render-health.json");
          const snap = JSON.parse(readFileSync(snapPath, "utf-8"));
          // Enrich with staleness
          const ageMinutes = (Date.now() - new Date(snap.generated).getTime()) / (1000 * 60);
          snap.minutes_since_poll = Math.round(ageMinutes);
          snap.stale = ageMinutes > 60;
          return new Response(JSON.stringify(snap), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({
            overall: "UNKNOWN",
            error: "render-health.json not yet written — first poll runs within 30 min of LaunchAgent load",
          }), { headers: { "Content-Type": "application/json" }, status: 200 });
        }
      }

      if (url.pathname === "/api/live-gantt") {
        const gantt = await getLiveGantt();
        return new Response(JSON.stringify(gantt), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Phase 3: Live Operations endpoints
      if (url.pathname === "/api/live") {
        const live = await getLiveSession();
        return new Response(JSON.stringify(live), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/voice-log") {
        if (req.method === "POST") {
          try {
            const body = await req.json();
            // Redact freeform content — only keep known Algorithm phase patterns
            const rawMsg = body.message || body.title || "";
            const phaseMatch = rawMsg.match(/Entering the (\w+)\s*(?:phase|Algorithm)?/i);
            const safeMessage = phaseMatch ? `Phase: ${phaseMatch[1]}` : "Voice notification";
            pushVoiceEvent({
              timestamp: new Date().toISOString(),
              message: safeMessage,
              voiceId: body.voice_id || body.voiceId,
            });
            return new Response(JSON.stringify({ status: "logged" }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        // GET — return recent voice events
        return new Response(JSON.stringify({ events: [...voiceEventLog].reverse() }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // v2.1: New endpoints
      if (url.pathname === "/api/next-actions") {
        return Response.json(getNextActions(db));
      }

      if (url.pathname === "/api/session-intent") {
        return Response.json(getSessionIntent(db));
      }

      if (url.pathname === "/api/departments") {
        return Response.json(getDepartments(db));
      }

      if (url.pathname === "/api/sync" && req.method === "POST") {
        // Manual sync trigger
        syncTranscripts(db).then(result => {
          console.log(`🔄 Manual sync: ${result.processed} processed`);
        });
        return new Response(JSON.stringify({ status: "sync_started" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/api/backfill" && req.method === "POST") {
        // Force re-parse ALL transcripts (rebuilds task descriptions, tool calls, etc.)
        console.log("🔄 Starting full backfill...");
        syncTranscripts(db, true).then(result => {
          console.log(`✅ Backfill complete: ${result.processed} sessions re-parsed`);
        });
        return new Response(JSON.stringify({ status: "backfill_started" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
    error(err) {
      console.error("Server error:", err);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.log(`🗼 PAI Control Tower running at http://127.0.0.1:${PORT}`);
}

main().catch(console.error);
