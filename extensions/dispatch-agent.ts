/**
 * dispatch_agent: background subagents for pi.
 *
 * One call starts every agent in its `agents` array, each as a separate `pi --mode rpc` process,
 * and returns at once. The parent stays free: a live panel above the editor shows what each agent
 * is doing, and each final report arrives as a message that starts a new turn. Esc in the parent
 * does not kill agents. In print and JSON mode the process would exit under the agents, so there
 * the call blocks until all of them finish.
 *
 * Why one call with an array, not several calls in one message: pi-claude-bridge ends the turn
 * about 6 s after the first tool call is ready and prunes siblings whose arguments are still
 * streaming. A long brief always loses that race, so "parallel" calls run one after the other.
 *
 * Commands:
 *   /agents                       pick an agent and open it
 *   /agents open <name>           live conversation; type to message it, ctrl+x twice to stop it
 *   /agents send <name> <text>    message a running agent, or continue a finished one
 *   /agents stop <name|all>       stop agents
 *   /agents log <name>            last lines of an agent's activity
 *   /agents status                one line per agent
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  addTranscript,
  createRecord,
  DEFAULT_TIMEOUT_MINUTES,
  DEPTH_ENV,
  isActive,
  parseMaxParallel,
  reportText,
  runAgent,
} from "../src/agent-runner.ts";
import { AgentViewer } from "../src/agent-viewer.ts";
import { formatDuration, formatTokens } from "../src/format.ts";
import { Semaphore } from "../src/semaphore.ts";
import type { AgentRecord, AgentReport, AgentSpec } from "../src/types.ts";

const SILENCE_WARNING_MS = 3 * 60_000;
const WIDGET_TICK_MS = 500;
const WIDGET_LINGER_MS = 30_000;
const LOG_LINES = 25;
const REPORT_DIR = join(tmpdir(), "pi-agents");
const REPORT_MESSAGE_TYPE = "agent-report";
const STATE_CHANNEL = "dispatch:state"; // consumed by goal.ts: a goal is never judged while agents run
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBS = ["open", "send", "stop", "log", "status"];

/** Re-invoke the same pi CLI the parent runs on; fall back to PATH. */
function piCommand(): { cmd: string; prefix: string[] } {
  const script = process.argv[1];
  if (script && /cli\.(m?js|ts)$/.test(script)) return { cmd: process.execPath, prefix: [script] };
  return { cmd: "pi", prefix: [] };
}

function agentLine(a: AgentRecord, theme: Theme, width: number, now: number): string {
  const frame = SPINNER[Math.floor(now / 100) % SPINNER.length];
  const name = theme.bold(a.name);
  if (a.status === "queued") {
    return truncateToWidth(`${theme.fg("dim", "·")} ${name} ${theme.fg("dim", "waiting for a free slot")}`, width);
  }
  const elapsed = formatDuration((a.endedAt ?? now) - (a.startedAt ?? now));
  const stats = `${elapsed} · ${a.toolCalls} tools · ↓${formatTokens(a.outputTokens)}`;
  if (a.status === "done") {
    return truncateToWidth(`${theme.fg("success", "✓")} ${name} ${theme.fg("dim", `done · ${stats}`)}`, width);
  }
  if (a.status === "failed" || a.status === "aborted") {
    const why = a.error ? ` · ${a.error}` : "";
    return truncateToWidth(
      `${theme.fg("error", "✗")} ${name} ${theme.fg("dim", `${a.status} · ${stats}${why}`)}`,
      width,
    );
  }
  // Silence only means trouble between events: a long-running tool is expected to stay quiet.
  const silentFor = now - a.lastEventAt;
  const doing = `${a.activity} (${formatDuration(now - a.activitySince)})`;
  const activity =
    !a.toolRunning && silentFor > SILENCE_WARNING_MS
      ? theme.fg("warning", `no signal for ${formatDuration(silentFor)} · ${doing}`)
      : theme.fg("muted", doing);
  return truncateToWidth(`${theme.fg("accent", frame)} ${name} ${theme.fg("dim", `${stats} ·`)} ${activity}`, width);
}

function statusRow(a: AgentRecord, now: number): string {
  const elapsed = formatDuration((a.endedAt ?? now) - (a.startedAt ?? now));
  const extra = a.status === "running" ? ` · ${a.activity}` : a.error ? ` · ${a.error}` : "";
  return `${a.name}: ${a.status} · ${a.toolCalls} tools · ${elapsed}${extra}`;
}

export default function (pi: ExtensionAPI) {
  // Subagents load the same extensions; without this guard each one could fan out again.
  if (Number(process.env[DEPTH_ENV] ?? "0") >= 1) return;

  const semaphore = new Semaphore(parseMaxParallel(process.env.PI_AGENTS_MAX_PARALLEL));
  const agents = new Map<string, AgentRecord>();
  const activeCount = () => [...agents.values()].filter(isActive).length;

  let uiCtx: ExtensionContext | undefined;
  let widgetOn = false;
  let housekeeping: ReturnType<typeof setInterval> | undefined;

  const stopWidget = () => {
    if (housekeeping) clearInterval(housekeeping);
    housekeeping = undefined;
    if (widgetOn) uiCtx?.ui.setWidget("agents", undefined);
    widgetOn = false;
  };

  const startWidget = () => {
    if (widgetOn || uiCtx?.mode !== "tui") return;
    widgetOn = true;
    uiCtx.ui.setWidget("agents", (tui, theme) => {
      const ticker = setInterval(() => tui.requestRender(), WIDGET_TICK_MS);
      ticker.unref?.();
      return {
        render(width: number): string[] {
          const now = Date.now();
          const rows = [...agents.values()].filter((a) => isActive(a) || now - (a.endedAt ?? now) < WIDGET_LINGER_MS);
          if (rows.length === 0) return [];
          const head = theme.fg("dim", `Agents · ${semaphore.live}/${semaphore.max} running · /agents to open`);
          return [truncateToWidth(head, width), ...rows.map((a) => agentLine(a, theme, width, now))];
        },
        invalidate() {},
        dispose() {
          clearInterval(ticker);
        },
      };
    });
    housekeeping = setInterval(() => {
      const now = Date.now();
      const visible = [...agents.values()].some((a) => isActive(a) || now - (a.endedAt ?? now) < WIDGET_LINGER_MS);
      if (!visible) stopWidget();
    }, 5000);
    housekeeping.unref?.();
  };

  const publishState = () => pi.events.emit(STATE_CHANNEL, { active: activeCount() });

  /** Starts the agents and returns one promise per report. `carry` keeps the conversation of a continued agent. */
  const launch = (specs: AgentSpec[], ctx: ExtensionContext, background: boolean, carry?: AgentRecord) => {
    const options = {
      semaphore,
      command: piCommand(),
      reportDir: REPORT_DIR,
      approve: ctx.isProjectTrusted(),
      defaultModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      onChange: publishState,
    };
    const runs = specs.map((spec) => {
      const rec = createRecord(spec, ctx.cwd);
      if (carry) rec.transcript = [...carry.transcript, ...rec.transcript];
      agents.set(spec.name, rec);
      return runAgent(spec, rec, options).then((report) => {
        publishState();
        if (background) {
          const stillRunning = [...agents.values()].filter(isActive).map((a) => a.name);
          const suffix = stillRunning.length
            ? `\n\nStill running, reports will follow: ${stillRunning.join(", ")}.`
            : "";
          pi.sendMessage(
            { customType: REPORT_MESSAGE_TYPE, content: reportText(report) + suffix, display: true, details: report },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        }
        return report;
      });
    });
    publishState();
    if (background) startWidget();
    return runs;
  };

  /** A running agent gets the message after its current tool; a finished one continues in its own session. */
  const sendToAgent = (name: string, text: string, ctx: ExtensionContext): string | undefined => {
    const a = agents.get(name);
    if (!a) return `Unknown agent: ${name}`;
    if (a.steer) {
      a.steer(text);
      return undefined;
    }
    if (a.status === "queued") return `${name} has not started yet.`;
    if (isActive(a)) return `${name} is about to finish. Try again in a moment.`;
    if (!a.sessionId) return `${name} has no saved session to continue.`;
    addTranscript(a, "notice", "continuing");
    launch([{ name, brief: text, cwd: a.cwd, resume_session: a.sessionId }], ctx, true, a);
    return undefined;
  };

  const openViewer = async (name: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") return ctx.ui.notify("The live view needs the interactive terminal.", "warning");
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new AgentViewer({ requestRender: () => tui.requestRender(), rows: () => tui.terminal.rows }, theme, {
          agent: () => agents.get(name),
          send: (text) => {
            const problem = sendToAgent(name, text, ctx);
            if (problem) ctx.ui.notify(problem, "warning");
          },
          stop: () => agents.get(name)?.stop?.("stopped by user"),
          close: () => done(),
        }),
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
    );
  };

  const dispatchAgent = defineTool({
    name: "dispatch_agent",
    label: "Dispatch agent",
    description:
      "Start subagents in the background: separate pi sessions that work autonomously on a brief. Returns immediately; " +
      "each agent's final report later arrives as a message and starts a new turn, so never poll or sleep waiting for them. " +
      "Each subagent sees NOTHING of this conversation: the brief must be self-contained (role, goal, files it owns, " +
      "files it must not touch, definition of done, report format). To run agents in parallel, put them ALL in the `agents` " +
      `array of ONE call (max ${semaphore.max} live; extra agents wait for a slot). ` +
      "To give feedback to an agent that already finished, dispatch it again with resume_session set to its session_id.",
    promptSnippet: "dispatch_agent: start self-contained subagents in the background; their reports arrive as messages",
    promptGuidelines: [
      "Use dispatch_agent for independent chunks of a large task; keep integration and verification yourself.",
      "Never emit two dispatch_agent calls in one message: put every agent you want to start now in the `agents` array of a single call.",
      "After dispatching, do other useful work or end your turn. Each report arrives by itself and wakes you.",
      "Give parallel subagents disjoint file ownership; they share the working tree unless each gets its own git worktree via cwd.",
      "Treat a subagent report as a claim: verify its changes (diff, tests) before building on them.",
    ],
    parameters: Type.Object({
      agents: Type.Array(
        Type.Object({
          name: Type.String({ description: "Short unique agent name, e.g. builder-a" }),
          brief: Type.String({ description: "Complete self-contained brief for the subagent" }),
          cwd: Type.Optional(
            Type.String({ description: "Absolute working directory (e.g. a git worktree). Default: current cwd" }),
          ),
          resume_session: Type.Optional(
            Type.String({ description: "session_id of a previous run of this agent to continue it" }),
          ),
          model: Type.Optional(
            Type.String({ description: "Model pattern for the subagent. Default: the current model" }),
          ),
          thinking: Type.Optional(
            Type.String({ description: "Thinking level: off|minimal|low|medium|high|xhigh|max" }),
          ),
          timeout_minutes: Type.Optional(
            Type.Number({ description: `Hard timeout. Default ${DEFAULT_TIMEOUT_MINUTES}` }),
          ),
        }),
        { minItems: 1, description: "Every agent to start now" },
      ),
    }),
    executionMode: "parallel",
    renderShell: "self",

    renderCall(args, theme, context) {
      const pad = context.outputPad;
      // A call the bridge pruned never executes; once its arguments stop streaming it must not linger as an empty card.
      if (!context.executionStarted && context.argsComplete) return new Text("", 0, 0);
      const names = (args.agents ?? []).map((a) => a?.name).filter(Boolean);
      const label = names.length ? theme.fg("accent", names.join(", ")) : "";
      const hint = context.executionStarted ? "" : theme.fg("dim", " preparing briefs…");
      return new Text(`${theme.fg("toolTitle", theme.bold("dispatch_agent"))} ${label}${hint}`, pad, 0);
    },

    renderResult(result, _options, theme, context) {
      const block = result.content?.[0];
      const first = block?.type === "text" ? (block.text.split("\n")[0] ?? "") : "";
      return new Text(theme.fg(context.isError ? "error" : "dim", first), context.outputPad, 0);
    },

    async execute(_toolCallId, p, signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const names = p.agents.map((s) => s.name);
      if (new Set(names).size !== names.length) throw new Error("Agent names must be unique within a call.");
      const busy = names.filter((name) => {
        const known = agents.get(name);
        return known && isActive(known);
      });
      if (busy.length > 0) {
        throw new Error(`Already running: ${busy.join(", ")}. Use another name or wait for its report.`);
      }

      const background = ctx.mode === "tui" || ctx.mode === "rpc";
      const runs = launch(p.agents, ctx, background);

      if (background) {
        const text =
          `Started in the background: ${names.join(", ")}. Each final report arrives as a message and starts a new turn. ` +
          "Do not poll or sleep. Do other useful work or end your turn now.";
        return { content: [{ type: "text" as const, text }], details: { names } };
      }

      const onAbort = () => {
        for (const name of names) agents.get(name)?.stop?.("stopped: aborted by orchestrator");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const reports = await Promise.all(runs);
      signal?.removeEventListener("abort", onAbort);
      const text = reports.map(reportText).join("\n\n---\n\n");
      if (reports.some((r) => r.status !== "done")) throw new Error(text);
      return { content: [{ type: "text" as const, text }], details: { names } };
    },
  });

  pi.registerTool(dispatchAgent);

  pi.registerMessageRenderer<AgentReport>(REPORT_MESSAGE_TYPE, (message, options, theme) => {
    const r = message.details;
    if (!r) return undefined;
    const mark = r.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const stats = `${r.status} · ${formatDuration(r.duration_s * 1000)} · ${r.tool_calls} tools${r.error ? ` · ${r.error}` : ""}`;
    let text = `${mark} ${theme.bold(`agent ${r.name}`)} ${theme.fg("dim", stats)}`;
    const body = options.expanded ? r.final_text : r.final_text.split("\n").filter(Boolean).slice(0, 3).join("\n");
    if (body) text += `\n${theme.fg("muted", body)}`;
    if (options.expanded && r.report_path) text += `\n${theme.fg("dim", r.report_path)}`;
    return new Text(text, options.outputPad, 0);
  });

  pi.registerCommand("agents", {
    description: "Manage subagents: /agents | open <name> | send <name> <text> | stop <name|all> | log <name> | status",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        const items = VERBS.filter((v) => v.startsWith(parts[0] ?? "")).map((v) => ({ value: `${v} `, label: v }));
        return items.length ? items : null;
      }
      const names = [...agents.keys(), ...(parts[0] === "stop" ? ["all"] : [])];
      const items = names
        .filter((n) => n.startsWith(parts[1] ?? ""))
        .map((n) => ({ value: `${parts[0]} ${n} `, label: n }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const trimmed = args.trim();
      const [verb, target] = trimmed.split(/\s+/);

      if (verb === "stop") {
        const named = agents.get(target ?? "");
        const picked = target === "all" ? [...agents.values()] : named ? [named] : [];
        const stoppable = picked.filter((a) => isActive(a) && a.stop);
        if (stoppable.length === 0) return ctx.ui.notify("Nothing to stop. Usage: /agents stop <name|all>", "warning");
        for (const a of stoppable) a.stop?.("stopped by user");
        ctx.ui.notify(`Stopping: ${stoppable.map((a) => a.name).join(", ")}`, "info");
        return;
      }

      if (verb === "send") {
        const text = trimmed.split(/\s+/).slice(2).join(" ");
        if (!target || !text) return ctx.ui.notify("Usage: /agents send <name> <text>", "warning");
        const problem = sendToAgent(target, text, ctx);
        ctx.ui.notify(problem ?? `Sent to ${target}.`, problem ? "warning" : "info");
        return;
      }

      if (verb === "log") {
        const a = agents.get(target ?? "");
        if (!a) return ctx.ui.notify("Unknown agent. Usage: /agents log <name>", "warning");
        const header = `${a.name}: ${a.status} · ${a.cwd}${a.sessionId ? ` · session ${a.sessionId}` : ""}${a.reportPath ? ` · ${a.reportPath}` : ""}`;
        const lines = a.transcript
          .filter((entry) => entry.kind !== "thinking")
          .slice(-LOG_LINES)
          .map((entry) => `${entry.kind}: ${entry.text.replace(/\s+/g, " ").slice(0, 160)}`);
        ctx.ui.notify(`${header}\n${lines.join("\n")}`, "info");
        return;
      }

      if (verb === "open") {
        if (!target || !agents.has(target))
          return ctx.ui.notify("Unknown agent. Usage: /agents open <name>", "warning");
        return openViewer(target, ctx);
      }

      if (agents.size === 0) return ctx.ui.notify("No subagents dispatched yet.", "info");
      const now = Date.now();

      if (verb === "status" || ctx.mode !== "tui") {
        const lines = [...agents.values()].map((a) => statusRow(a, now));
        ctx.ui.notify(`Live ${semaphore.live}/${semaphore.max}\n${lines.join("\n")}`, "info");
        return;
      }

      const rows = [...agents.values()].map((a) => statusRow(a, now));
      const picked = await ctx.ui.select(`Agents · ${semaphore.live}/${semaphore.max} running`, rows);
      if (picked === undefined) return;
      const name = [...agents.values()][rows.indexOf(picked)]?.name;
      if (name) await openViewer(name, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
  });

  // Child processes must not outlive the session that is waiting for their reports.
  pi.on("session_shutdown", () => {
    for (const a of agents.values()) if (isActive(a)) a.stop?.("stopped: parent session closed");
    stopWidget();
    uiCtx = undefined;
  });
}
