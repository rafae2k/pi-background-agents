export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** The one argument that says what a tool call is doing, on a single line. */
export function shortArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.command ?? a.file_path ?? a.pattern ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 200);
}

export function textOf(message: { content?: unknown }): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");
}
