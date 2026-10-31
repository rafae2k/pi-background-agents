import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens } from "./format.ts";
import type { AgentRecord, TranscriptEntry } from "./types.ts";

const TICK_MS = 250;
const STOP_CONFIRM_MS = 3000;
const THINKING_PREVIEW_CHARS = 400;
// Header, two rules, composer and hints.
const CHROME_LINES = 5;

export interface ViewerActions {
  /** Latest record: a resumed agent gets a new one under the same name. */
  agent(): AgentRecord | undefined;
  send(text: string): void;
  stop(): void;
  close(): void;
}

export interface ViewerHost {
  requestRender(): void;
  rows(): number;
}

function entryLines(entry: TranscriptEntry, theme: Theme, width: number): string[] {
  const wrap = (text: string) => wrapTextWithAnsi(text, width);
  switch (entry.kind) {
    case "user":
      return wrap(theme.fg("accent", `› ${entry.text}`));
    case "tool":
      return wrap(`${theme.fg("toolTitle", "$")} ${theme.bold(entry.text)}`);
    case "result":
      return wrap(theme.fg("dim", entry.text));
    case "error":
      return wrap(theme.fg("error", entry.text));
    case "thinking": {
      const text =
        entry.text.length > THINKING_PREVIEW_CHARS ? `…${entry.text.slice(-THINKING_PREVIEW_CHARS)}` : entry.text;
      return wrap(theme.italic(theme.fg("dim", text)));
    }
    case "notice":
      return wrap(theme.fg("warning", entry.text));
    default:
      return wrap(entry.text);
  }
}

/** Full-screen view of one agent: live conversation, a composer that talks to it, and a stop key. */
export class AgentViewer implements Component, Focusable {
  focused = false;
  private draft = "";
  private scrollUp = 0;
  private stopArmedAt = 0;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly host: ViewerHost;
  private readonly theme: Theme;
  private readonly actions: ViewerActions;

  constructor(host: ViewerHost, theme: Theme, actions: ViewerActions) {
    this.host = host;
    this.theme = theme;
    this.actions = actions;
    this.ticker = setInterval(() => host.requestRender(), TICK_MS);
    this.ticker.unref?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.actions.close();
      return;
    }
    if (matchesKey(data, "ctrl+x")) {
      const now = Date.now();
      if (now - this.stopArmedAt < STOP_CONFIRM_MS) {
        this.stopArmedAt = 0;
        this.actions.stop();
      } else {
        this.stopArmedAt = now;
      }
    } else if (matchesKey(data, "up")) this.scrollUp += 1;
    else if (matchesKey(data, "down")) this.scrollUp = Math.max(0, this.scrollUp - 1);
    else if (matchesKey(data, "pageUp")) this.scrollUp += 10;
    else if (matchesKey(data, "pageDown")) this.scrollUp = Math.max(0, this.scrollUp - 10);
    else if (matchesKey(data, "enter")) {
      const text = this.draft.trim();
      if (text) this.actions.send(text);
      this.draft = "";
      this.scrollUp = 0;
    } else if (matchesKey(data, "backspace")) {
      this.draft = [...this.draft].slice(0, -1).join("");
    } else if (!/[\p{Cc}]/u.test(data)) {
      this.draft += data;
    }
    this.host.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this;
    const agent = this.actions.agent();
    const rule = theme.fg("dim", "─".repeat(width));
    const height = Math.max(8, this.host.rows() - 2);
    if (!agent) return [theme.fg("error", "Agent not found. Esc to go back.")];

    const now = Date.now();
    const elapsed = formatDuration((agent.endedAt ?? now) - (agent.startedAt ?? now));
    const color = agent.status === "done" ? "success" : agent.status === "running" ? "accent" : "error";
    const header =
      `${theme.bold(agent.name)} ${theme.fg(color, agent.status)} ` +
      theme.fg(
        "dim",
        `· ${elapsed} · ${agent.toolCalls} tools · ↓${formatTokens(agent.outputTokens)} · ${agent.activity}`,
      );

    const body = agent.transcript.flatMap((entry) => ["", ...entryLines(entry, theme, width)]);
    const bodyHeight = height - CHROME_LINES;
    const maxScroll = Math.max(0, body.length - bodyHeight);
    this.scrollUp = Math.min(this.scrollUp, maxScroll);
    const end = body.length - this.scrollUp;
    const visible = body.slice(Math.max(0, end - bodyHeight), end);
    while (visible.length < bodyHeight) visible.push("");

    const canSteer = agent.steer !== undefined;
    const canResume = !canSteer && agent.status !== "queued" && agent.sessionId !== undefined;
    const placeholder = canSteer
      ? "message this agent"
      : canResume
        ? "continue this agent"
        : "this agent cannot take messages";
    const composer = this.draft
      ? `${theme.fg("accent", "› ")}${this.draft}${theme.fg("accent", "█")}`
      : `${theme.fg("accent", "› ")}${theme.fg("dim", placeholder)}`;

    const armed = Date.now() - this.stopArmedAt < STOP_CONFIRM_MS;
    const stopHint = agent.stop ? (armed ? theme.fg("warning", "ctrl+x again to stop") : "ctrl+x stop") : "";
    const scrolled = this.scrollUp > 0 ? `↓ ${this.scrollUp} lines below · ` : "";
    const hints = theme.fg("dim", `${scrolled}enter send · ↑↓ scroll · esc back${stopHint ? " · " : ""}`) + stopHint;

    return [header, rule, ...visible, rule, composer, hints].map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.ticker);
  }
}
