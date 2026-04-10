# PAI Control Tower

Real-time augmentation dashboard for PAI — session tracking, system inventory, agent spawns, tool calls, machine health, and maturity scoring.

![Dark cockpit aesthetic](https://img.shields.io/badge/theme-dark_cockpit-0D0F1A) ![Bun](https://img.shields.io/badge/runtime-Bun-f472b6) ![SQLite](https://img.shields.io/badge/db-SQLite-60a5fa)

## What It Does

A single-page dashboard at `http://localhost:8895` showing:

- **Live Session** — current session detection, elapsed time, recent events, tool call breakdown
- **Session History** — past sessions with duration, message count, task description, effort level
- **System Inventory** — skills count, hooks count, LaunchAgents, dashboards, memory files
- **Tool Call Analytics** — aggregated tool usage across sessions (Read, Write, Bash, Agent, etc.)
- **Agent Spawn Tracking** — which agent types are spawned, when, and how often
- **Machine Health** — CPU, memory, disk, battery, uptime, recommendations
- **PAIMM Score** — PAI Maturity Model scoring across 6 dimensions
- **Session Intent / Project Tracking** — maps sessions to projects by keyword matching
- **Next Actions** — AI-suggested maintenance tasks based on system state

## Stack

- **Runtime:** Bun (TypeScript)
- **Database:** SQLite (WAL mode) for session and event storage
- **Frontend:** Single inline HTML page with Tailwind CSS + ApexCharts
- **Architecture:** Single-file server (~2,100 lines) — all backend + frontend in one file

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) installed (`curl -fsSL https://bun.sh/install | bash`)
- PAI directory structure at `~/.claude/`

### Install

```bash
# Clone the repo
git clone https://github.com/RubyWolff27/pai-control-tower.git
cd pai-control-tower

# Copy source files to your PAI Tools directory
cp src/ControlTower.ts ~/.claude/Tools/ControlTower.ts
cp src/ct-types.ts ~/.claude/Tools/ct-types.ts

# Copy the dashboard frontend (server loads this at runtime)
mkdir -p ~/.claude/Tools/public
cp src/public/control-tower.html ~/.claude/Tools/public/control-tower.html

# Create the database directory
mkdir -p ~/.claude/data

# Test run
bun ~/.claude/Tools/ControlTower.ts
# → Open http://localhost:8895
```

### Run as LaunchAgent (auto-start on login)

```bash
# Copy the plist
cp setup/ai.pai.control-tower.plist ~/Library/LaunchAgents/

# Edit the plist to match your paths (replace YOUR_USERNAME)
sed -i '' "s|YOUR_USERNAME|$(whoami)|g" ~/Library/LaunchAgents/ai.pai.control-tower.plist

# Load it
launchctl load ~/Library/LaunchAgents/ai.pai.control-tower.plist

# Verify
curl -s http://localhost:8895 | head -1
```

## Configuration

### Project Keywords (Session Intent Tracking)

Edit the `projectKeywords` object in `ControlTower.ts` (~line 1741) to match your projects:

```typescript
const projectKeywords: Record<string, string[]> = {
  "My Web App": ["webapp", "react", "frontend", "api"],
  "Infrastructure": ["deploy", "ci", "docker", "kubernetes"],
  "Research": ["research", "paper", "analysis"],
  // Add your own...
};
```

### PAIMM Dimensions

Edit the `dimensions` array (~line 1193) to reflect your PAI's capabilities:

```typescript
const dimensions = [
  { name: "Context", score: 50, detail: "Your context description" },
  { name: "Personality", score: 30, detail: "Your DA personality status" },
  { name: "Tool Use", score: 60, detail: "Skills, hooks, integrations" },
  // ...
];
```

### Port

Change `const PORT = 8895;` at the top of the file.

### Inception Date

Set `const INCEPTION_DATE = new Date("YYYY-MM-DD");` to when you started your PAI.

## How It Works

### Session Detection

The dashboard scans `~/.claude/projects/` for Claude Code session transcript directories. It parses JSONL transcripts to extract:
- Session start/end times
- Tool calls (Read, Write, Bash, Agent, Skill, etc.)
- Agent spawns (type, timestamp)
- Task descriptions (from the conversation)
- Message counts

### Database Schema

SQLite at `~/.claude/data/control-tower.db`:

- `sessions` — one row per Claude Code session
- `tool_calls` — aggregated tool usage per session
- `agent_spawns` — agent spawn events
- `skill_invocations` — skill usage tracking

### System Inventory

Scans the filesystem for:
- `~/.claude/skills/**/SKILL.md` — skill count
- `~/.claude/hooks/*.ts` — hook count
- `~/Library/LaunchAgents/ai.pai.*` — LaunchAgent count
- `~/.claude/MEMORY/` — memory file count and staleness

### Machine Health

Uses macOS system commands:
- `sysctl` for CPU/memory
- `df` for disk
- `ioreg` for battery
- `ps` for top processes

## Screenshots

The dashboard uses a dark cockpit aesthetic with:
- Glass-morphism cards
- Emerald/blue accent colors
- ApexCharts for session timelines and tool usage
- Responsive grid layout

## Requirements

- macOS (LaunchAgent support, `sysctl`/`ioreg` for health metrics)
- Bun 1.0+
- Claude Code installed (for session transcript parsing)
- PAI directory structure (`~/.claude/skills/`, `~/.claude/hooks/`, etc.)

## License

MIT — use it, modify it, make it yours.
