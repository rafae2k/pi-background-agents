import { formatDuration } from "./format.ts";

export const TRANSCRIPT_BUDGET_CHARS = 40_000;

export interface Verdict {
  done: boolean;
  reason: string;
}

export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => {
      if (b?.type === "text") return b.text;
      if (b?.type === "toolCall") return `[tool ${b.name} ${JSON.stringify(b.arguments ?? {}).slice(0, 300)}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Transcript tail, newest-first budget, rendered oldest-first. */
export function transcriptTail(messages: readonly any[]): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && used < TRANSCRIPT_BUDGET_CHARS; i--) {
    const m = messages[i];
    if (m?.role === "system") continue;
    let text = blockText(m?.content);
    if (m?.role === "toolResult") text = text.slice(0, 2000);
    const chunk = `--- ${m?.role}${m?.toolName ? ` (${m.toolName})` : ""} ---\n${text}`;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.reverse().join("\n\n").slice(-TRANSCRIPT_BUDGET_CHARS);
}

export function lastAssistantText(messages: readonly any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      const t = blockText(messages[i].content);
      if (t.trim()) return t;
    }
  }
  return "";
}

/** Returns null when the text holds no usable verdict. */
export function parseVerdict(text: string): Verdict | null {
  const json = text.match(/\{[\s\S]*"done"[\s\S]*\}/);
  if (!json) return null;
  try {
    const v = JSON.parse(json[0]);
    return typeof v.done === "boolean" ? { done: v.done, reason: String(v.reason ?? "") } : null;
  } catch {
    return null;
  }
}

export function parseGoalArgs(raw: string): { check?: string; max?: number; objective: string } {
  let rest = raw.trim();
  let check: string | undefined;
  let max: number | undefined;
  for (;;) {
    const m =
      rest.match(/^--check[=\s]\s*"([^"]*)"\s*/) ??
      rest.match(/^--check[=\s]\s*'([^']*)'\s*/) ??
      rest.match(/^--check=(\S+)\s*/);
    if (m) {
      check = m[1];
      rest = rest.slice(m[0].length);
      continue;
    }
    const n = rest.match(/^--max[\s=](\d+)\s*/);
    if (n) {
      max = Number(n[1]);
      rest = rest.slice(n[0].length);
      continue;
    }
    break;
  }
  return { check, max, objective: rest.trim() };
}

export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${formatDuration(ms)}`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
