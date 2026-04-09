/**
 * ct-types.ts — Shared type definitions for PAI Control Tower
 */

export interface VoiceEvent {
  timestamp: string;
  message: string;
  voiceId?: string;
}

export interface LiveEvent {
  type: "tool_call" | "agent_spawn" | "phase_transition" | "user_message";
  name: string;
  timestamp: string;
  detail?: string;
}

export interface LiveSession {
  isActive: boolean;
  sessionId: string | null;
  startedAt: string | null;
  elapsedMins: number;
  recentEvents: LiveEvent[];
  toolCallSummary: Record<string, number>;
  activePhase: string | null;
}

export interface GanttItem {
  type: "skill" | "agent";
  name: string;
  startTime: string;
  endTime: string | null;
  durationMins: number;
  parentSkill?: string;
}

export interface SessionMeta {
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  activeMins: number;
  messageCount: number;
  toolCalls: Record<string, number>;
  agentSpawns: { type: string; at: string }[];
  skillInvocations: { name: string; at: string }[];
  effortLevel: string | null;
  taskDescription: string | null;
}

export interface MachineHealth {
  cpu: { model: string; cores: number; loadAvg: number[]; topProcesses: { name: string; cpu: number; mem: number }[] };
  memory: { totalGB: number; usedGB: number; freeGB: number; pressurePct: number; wiredGB: number };
  disk: { totalGB: number; usedGB: number; freeGB: number; usedPct: number; breakdown: { name: string; sizeGB: number }[] };
  battery: { cycleCount: number; health: number; currentPct: number; isCharging: boolean; designCapacity: number; maxCapacity: number };
  uptime: { hours: number; formatted: string };
  recommendations: string[];
}
