export type AgentStatus = "queued" | "running" | "done" | "failed" | "aborted";

export type TranscriptKind = "user" | "text" | "thinking" | "tool" | "result" | "error" | "notice";

export interface TranscriptEntry {
  kind: TranscriptKind;
  text: string;
}

export interface AgentSpec {
  name: string;
  brief: string;
  cwd?: string;
  resume_session?: string;
  model?: string;
  thinking?: string;
  timeout_minutes?: number;
}

export interface AgentRecord {
  name: string;
  cwd: string;
  status: AgentStatus;
  sessionId?: string;
  toolCalls: number;
  outputTokens: number;
  activity: string;
  activitySince: number;
  toolRunning: boolean;
  lastEventAt: number;
  transcript: TranscriptEntry[];
  /** What the user sent to this agent from the live view, kept for the report. */
  userMessages: string[];
  /** Assistant text arrived as deltas for the current message, so message_end must not add it again. */
  streamedText: boolean;
  finalText: string;
  stopReason?: string;
  startedAt?: number;
  endedAt?: number;
  reportPath?: string;
  error?: string;
  stop?: (why: string) => void;
  /** Present only while the child accepts input. */
  steer?: (message: string) => void;
}

export interface AgentReport {
  name: string;
  status: AgentStatus;
  session_id?: string;
  report_path?: string;
  tool_calls: number;
  duration_s: number;
  error?: string;
  user_messages?: string[];
  final_text: string;
}
