/**
 * Internal browser operation definitions shared by the six model-facing tools.
 * These definitions are never registered with `ctx.tools`: they provide the
 * action-level validation, execution, rendering, and UI presentation reused by
 * the domain tools without exposing one schema per operation to the model.
 */

import { constants } from "node:fs";
import { copyFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  defineTool,
  type ToolDefinition,
  type ToolResult,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { ownerSessionIds } from "./archive-cleanup";
import { trySaveScreenshot } from "./image";
import { actionForLabel, type ObservationService } from "./observation";
import { appendTabId, requireNonEmpty, requirePositive, runnerTimeout } from "./phase-one-runtime";
import { registerPhaseOneTools } from "./phase-one-tools";
import type { KeyedExecutor } from "./queue";
import {
  type BskRunner,
  bskInstallMessage,
  isCommandNotFound,
  isNavigationLifecycleTimeoutPayload,
  type ParseBskJsonOptions,
  parseBskJson,
  runWithSessionBusyRetry,
} from "./runner";
import { SessionStarts } from "./session-starts";
import type { SessionRegistry } from "./sessions";
import {
  BROWSER_PARAM,
  SESSION_PARAM,
  SESSION_STOP_PARAMS,
  TAB_ID_PARAM,
  TIMEOUT_MS_PARAM,
} from "./tool-params";

/** Plugin configuration resolved from the Schemastery schema in index.ts. */
export interface PluginConfig {
  bskPath: string;
  /** Optional durable start journal directory (isolated by host/profile when configured). */
  sessionStateDirectory?: string;
  defaultTimeoutMs: number;
  maxSessions: number;
  observationEnabled: boolean;
  thumbnailIntervalMs: number;
  idleIntervalMs: number;
  /**
   * Lazy tool-schema injection: when true (default), the bsk_* tools are
   * registered only after the `browser-skill` skill has been successfully
   * invoked (skill catalog entry advertises alone until then); when false,
   * the suite is registered at apply time (legacy always-on behavior).
   */
  lazyTools: boolean;
}

export interface ToolDeps {
  ctx: Context;
  runner: BskRunner;
  registry: SessionRegistry;
  config: PluginConfig;
  observation: ObservationService;
  /** Per-session FIFO: the daemon rejects a second command while one is unfinished. */
  queue: KeyedExecutor;
  starts?: SessionStarts;
}

type JsonValue = Parameters<ToolDefinition["output"]["render"]>[1];

/** Device presets supported by `bsk emulate --device`. */
const DEVICE_PRESETS = [
  "iphone-14",
  "iphone-14-pro-max",
  "iphone-se",
  "pixel-7",
  "galaxy-s23",
  "ipad-mini",
  "galaxy-tab-s8",
] as const;

/**
 * Run one bsk command and return its parsed JSON payload, or throw.
 * `observeSession` marks the run as model-facing work on that session: it is
 * instrumented into the observation service (action begin/end) and tagged so
 * interrupt() can kill exactly this child. Observation traffic itself never
 * passes an observeSession.
 */
async function runBsk(
  deps: ToolDeps,
  exec: ToolRunContext,
  args: string[],
  label: string,
  observeSession?: string,
  runnerTimeoutMs?: number,
  initializing = false,
  parseOptions: ParseBskJsonOptions = {},
): Promise<JsonValue> {
  const releaseForeground =
    observeSession !== undefined ? deps.observation.acquireForeground(observeSession) : undefined;
  // beginAction must fire only when the task actually starts inside the
  // per-session queue — marking it while still queued would overwrite the
  // in-flight action's label (and flash it idle on a queued abort).
  let began = false;
  let actionError: string | undefined;
  try {
    let result;
    try {
      const runOnce = () => {
        if (observeSession !== undefined) {
          began = true;
          deps.observation.beginAction(observeSession, actionForLabel(label));
        }
        return runWithSessionBusyRetry(async () => {
          if (
            observeSession !== undefined &&
            !(initializing && deps.registry.stateFor(observeSession) === "starting")
          ) {
            deps.registry.assertUsable(observeSession, label);
          }
          return deps.runner.run(args, {
            signal: exec.signal,
            timeoutMs: runnerTimeoutMs ?? deps.config.defaultTimeoutMs,
            ...(observeSession !== undefined ? { tag: observeSession } : {}),
          });
        }, exec.signal);
      };
      result =
        observeSession !== undefined
          ? await deps.queue.run(observeSession, runOnce, exec.signal)
          : await runOnce();
    } catch (error) {
      if (isCommandNotFound(error)) {
        throw new Error(bskInstallMessage(deps.config.bskPath));
      }
      throw error;
    }
    if (result.aborted) {
      const error = new Error("tool call aborted");
      error.name = "AbortError";
      throw error;
    }
    const value = parseBskJson(result, label, parseOptions) as JsonValue;
    if (args[0] === "evaluate" && (value as { ok?: boolean } | null)?.ok === false) {
      throw new Error(`evaluate failed: ${JSON.stringify(value)}`);
    }
    return value;
  } catch (error) {
    actionError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw error;
  } finally {
    if (observeSession !== undefined && began) {
      deps.observation.endAction(observeSession, actionError);
    }
    releaseForeground?.();
  }
}

/** Build the command line shown on the pending terminal card (pure). */
function cmdline(deps: ToolDeps, args: string[]): string {
  return [deps.config.bskPath, ...args].join(" ");
}

/** Shared completed-card presenter: terminal card with the rendered text. */
function presentTerminalResult(_args: never, result: ToolResult) {
  // Multi-block results (e.g. screenshot text + image) still project their
  // text block onto the terminal card.
  const block = result.content.find((b) => b.type === "text");
  if (block === undefined || block.type !== "text") return undefined;
  if (result.isError) return undefined;
  return { card: "terminal" as const, output: block.text, exitCode: 0 };
}

function abortError(): Error {
  const error = new Error("tool call aborted");
  error.name = "AbortError";
  return error;
}

type DefinitionRegistrar = (definition: ToolDefinition) => void;

/** Define the private action handlers through an injected collector. */
function defineBrowserOperations(deps: ToolDeps, register: DefinitionRegistrar): void {
  const { registry } = deps;

  register(
    defineTool({
      name: "session.start",
      description:
        "Start a new browser session: opens an Agent Window in the connected browser and returns " +
        "its session id. The new session becomes the current session for subsequent bsk_* calls. " +
        "Optionally navigate to an initial URL and/or apply a mobile device emulation preset.",
      parameters: {
        name: {
          type: "string",
          description: "Non-empty task name displayed in local browser operation history.",
        },
        url: {
          type: "string",
          description: "Initial URL to navigate to after the session starts.",
        },
        width: {
          type: "integer",
          description: "Agent Window outer width in CSS pixels (100..=7680). Requires height.",
        },
        height: {
          type: "integer",
          description: "Agent Window outer height in CSS pixels (100..=7680). Requires width.",
        },
        noFocus: {
          type: "boolean",
          description:
            "Background by default. Set false to explicitly open the Agent Window in front.",
        },
        browser: BROWSER_PARAM,
        device: {
          type: "string",
          enum: DEVICE_PRESETS,
          description: "Mobile device emulation preset applied to the tab after start.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionId: { type: "string", required: true },
            browserInstanceId: { type: "string", required: true },
            url: { type: "string" },
            device: { type: "string" },
            reached: { type: "string" },
            warning: { type: "string" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `started browser session ${value.sessionId}` +
              (value.url !== undefined ? ` and navigated to ${value.url}` : "") +
              (value.device !== undefined ? ` (device: ${value.device})` : "") +
              (value.reached === "timeout"
                ? " — initial navigation timed out before the requested lifecycle phase; session is usable"
                : ""),
          },
        ],
      },
      async execute(args, exec) {
        if (args.name !== undefined) requireNonEmpty(args.name, "name");
        if (args.url !== undefined && args.url.trim().length === 0) {
          throw new Error("url must be a non-empty string");
        }
        if ((args.width === undefined) !== (args.height === undefined)) {
          throw new Error("width and height must be given together");
        }
        // Reserve the slot BEFORE spawning: check-and-reserve is synchronous,
        // so concurrent starts can never both pass the cap and leak a session.
        const starts = (deps.starts ??= new SessionStarts(deps));
        await starts.reconcile();
        const record = starts.begin(ownerSessionIds(deps.ctx, exec.agent?.id));
        const startArgs = ["session", "start", "--request-id", record.requestId];
        if (args.name !== undefined) startArgs.push("--name", args.name);
        if (args.width !== undefined && args.height !== undefined) {
          startArgs.push("--width", String(args.width), "--height", String(args.height));
        }
        if (args.noFocus === true) startArgs.push("--no-focus");
        if (args.noFocus === false) startArgs.push("--focus");
        if (args.browser !== undefined) startArgs.push("--browser", args.browser);
        let reply: { session_id: string; browser_instance_id: string };
        try {
          await starts.prepare(record, exec.signal);
          reply = (await runBsk(deps, exec, startArgs, "session start")) as typeof reply;
        } catch (error) {
          await starts.fail(record).catch(() => {});
          throw error;
        }
        try {
          starts.register(record, reply);
          deps.observation.addSession(reply.session_id, args.url);
          if (args.device !== undefined) {
            await runBsk(
              deps,
              exec,
              ["emulate", "--session", reply.session_id, "--device", args.device],
              "emulate",
              reply.session_id,
              undefined,
              true,
            );
          }
          let navigationTimeout:
            | {
                reached: "timeout";
                url?: string;
                final_url?: string;
                error_text?: string;
              }
            | undefined;
          if (args.url !== undefined) {
            // Combined start-with-URL: a lifecycle wait timeout (exit 4 +
            // reached:"timeout") must not cancel the session that was already
            // created — the page may still be usable. Genuine navigate failures
            // still fall through to starts.fail below.
            const navigateReply = await runBsk(
              deps,
              exec,
              ["navigate", "--session", reply.session_id, args.url],
              "navigate",
              reply.session_id,
              undefined,
              true,
              { allowNavigationTimeout: true },
            );
            if (isNavigationLifecycleTimeoutPayload(navigateReply)) {
              navigationTimeout = {
                reached: "timeout",
                url: typeof navigateReply.url === "string" ? navigateReply.url : undefined,
                final_url:
                  typeof navigateReply.final_url === "string" ? navigateReply.final_url : undefined,
                error_text:
                  typeof navigateReply.error_text === "string"
                    ? navigateReply.error_text
                    : undefined,
              };
              deps.observation.setUrl(
                reply.session_id,
                navigationTimeout.final_url ?? navigationTimeout.url ?? args.url,
              );
            } else {
              const okReply = navigateReply as {
                url?: string;
                final_url?: string;
              };
              deps.observation.setUrl(
                reply.session_id,
                okReply.final_url ?? okReply.url ?? args.url,
              );
            }
          }
          await starts.claim(record, exec.signal);
          return {
            sessionId: reply.session_id,
            browserInstanceId: reply.browser_instance_id,
            ...(args.url !== undefined ? { url: args.url } : {}),
            ...(args.device !== undefined ? { device: args.device } : {}),
            ...(navigationTimeout !== undefined
              ? {
                  reached: "timeout" as const,
                  warning:
                    "Initial navigation timed out waiting for the page lifecycle; " +
                    "the session remains open — observe the page and decide how to proceed." +
                    (navigationTimeout.error_text !== undefined
                      ? ` (${navigationTimeout.error_text})`
                      : ""),
                }
              : {}),
          };
        } catch (error) {
          await starts.fail(record).catch(() => {});
          throw error;
        }
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, [
          "session",
          "start",
          ...(args.name !== undefined ? ["--name", args.name] : []),
          ...(args.device !== undefined ? ["+ emulate", args.device] : []),
          ...(args.url !== undefined ? ["+ navigate", args.url] : []),
        ]),
        description: "Start a browser session",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "session.stop",
      description:
        "Stop a browser session and close its Agent Window. Stops the given session, or the " +
        "current session when `session` is omitted. An unacknowledged stop is retried before " +
        "selecting another session; specify session or requestId if several stops are pending. " +
        "A requestId identifies the original start even if its short session ID is reused. Once accepted, " +
        "cleanup continues if this call is aborted. Only plugin-created sessions can be stopped.",
      parameters: SESSION_STOP_PARAMS,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            stopped: { type: "string", required: true },
            requestId: { type: "string", required: true },
            alreadyClosed: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `${value.alreadyClosed ? "previous stop completed for" : "stopped browser session"} ${value.stopped} (request ${value.requestId})`,
          },
        ],
      },
      async execute(args, exec) {
        try {
          const starts = (deps.starts ??= new SessionStarts(deps));
          return await starts.stop({
            sessionId: args.session,
            requestId: args.requestId,
            signal: exec.signal,
          });
        } catch (error) {
          if (isCommandNotFound(error)) {
            throw new Error(bskInstallMessage(deps.config.bskPath));
          }
          throw error;
        }
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(
          deps,
          args.requestId
            ? ["session", "request", args.requestId, "--cancel"]
            : ["session", "stop", args.session ?? "(current or pending stop)"],
        ),
        description: "Stop a browser session",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "session.list",
      description:
        "List the browser sessions created by this plugin. Sessions owned by other programs on the " +
        "shared bsk daemon are not visible here. The session marked `current` is the one bsk_* " +
        "tools act on when no explicit `session` is passed.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pendingCleanup: { type: "integer", required: true },
            sessions: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  sessionId: { type: "string", required: true },
                  browserInstanceId: { type: "string", required: true },
                  requestId: { type: "string" },
                  current: { type: "boolean", required: true },
                  state: {
                    type: "string",
                    enum: ["starting", "active", "cleanup"],
                    required: true,
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.sessions.length === 0
                ? value.pendingCleanup > 0
                  ? `${value.pendingCleanup} browser start(s) awaiting cleanup; retry list or stop`
                  : "no active browser sessions"
                : value.sessions
                    .map(
                      (s) =>
                        `${s.sessionId} (browser ${s.browserInstanceId})${s.current ? " [current]" : ""}${s.state !== "active" ? ` [${s.state}]` : ""}${s.requestId ? ` (request ${s.requestId})` : ""}`,
                    )
                    .join("\n"),
          },
        ],
      },
      isConcurrencySafe: () => true,
      // Reconcile only our journaled requests; never enumerate foreign sessions.
      async execute() {
        await deps.starts?.reconcile();
        const current = registry.current();
        return {
          pendingCleanup: deps.starts?.pendingCleanup() ?? 0,
          sessions: registry.list().map((entry) => ({
            sessionId: entry.sessionId,
            browserInstanceId: entry.browserInstanceId ?? "",
            ...(entry.requestId ? { requestId: entry.requestId } : {}),
            current: entry.sessionId === current,
            state: entry.state,
          })),
        };
      },
      presentCall: () => ({
        card: "terminal",
        title: cmdline(deps, ["session", "list"]),
        description: "List browser sessions",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "session.browsers",
      description:
        "List connected browser instances and their complete official status metadata; no session is required.",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      execute: (_args, exec) => runBsk(deps, exec, ["browsers"], "browsers"),
      presentCall: () => ({
        card: "terminal",
        title: cmdline(deps, ["browsers"]),
        description: "List connected browser instances",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "page.navigate",
      description:
        "Navigate the session's active tab to a URL and wait for a page lifecycle phase " +
        "(default: load). Returns the final URL after redirects.",
      parameters: {
        url: { type: "string", required: true, description: "Destination URL." },
        session: SESSION_PARAM,
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          description: "Lifecycle phase to wait for (default: load).",
        },
        timeoutMs: {
          type: "integer",
          description: "Navigation wait timeout in milliseconds (default 30000).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            url: { type: "string", required: true },
            finalUrl: { type: "string" },
            reached: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `[session ${value.session}] navigated to ${value.finalUrl ?? value.url} (reached: ${value.reached})` +
              (value.reached === "timeout"
                ? " — the wait timed out before the requested phase"
                : ""),
          },
        ],
      },
      async execute(args, exec) {
        if (args.url.trim().length === 0) throw new Error("url must be a non-empty string");
        const sessionId = registry.resolve(args.session, "bsk_page(action=navigate)");
        const cmdArgs = ["navigate", "--session", sessionId];
        if (args.waitUntil !== undefined) cmdArgs.push("--wait-until", args.waitUntil);
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        cmdArgs.push(args.url);
        const reply = (await runBsk(deps, exec, cmdArgs, "navigate", sessionId)) as {
          tab_id: number;
          url: string;
          final_url?: string;
          reached: string;
        };
        deps.observation.setUrl(sessionId, reply.final_url ?? reply.url);
        return {
          session: sessionId,
          tabId: reply.tab_id,
          url: reply.url,
          ...(reply.final_url !== undefined ? { finalUrl: reply.final_url } : {}),
          reached: reply.reached,
        };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["navigate", "--session", args.session ?? "(current)", args.url]),
        description: "Navigate to a URL",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  const registerObservationTool = (kind: "snapshot" | "observe") => {
    const isSnapshot = kind === "snapshot";
    const name = isSnapshot ? "inspect.snapshot" : "inspect.observe";
    const description = isSnapshot
      ? "Capture an indented aria-tree snapshot of the session's active tab. Interactive elements " +
        "carry @eN refs for bsk_interact actions. Prefer bsk_inspect action=observe for a richer semantic view."
      : "Produce a semantic VOM observation of the session's active tab (roles, states, perception " +
        "probes) with @eN refs for bsk_interact actions. Active hover probing is opt-in and moves the real cursor.";
    register(
      defineTool({
        name,
        description,
        parameters: {
          session: SESSION_PARAM,
          tabId: TAB_ID_PARAM,
          ...(kind === "observe"
            ? {
                cursor: {
                  type: "string" as const,
                  description:
                    "Continue omitted content; incompatible with maxDepth and active probe flags.",
                },
                probeHover: {
                  type: "boolean" as const,
                  description:
                    "Actively hover controls to reveal hidden content (default false); moves the real cursor.",
                },
                debugSurfaces: {
                  type: "boolean" as const,
                  description: "Include surface probe diagnostics (default false).",
                },
              }
            : {}),
          maxDepth: { type: "integer", description: "Cap on tree depth before truncating." },
          maxTokens: {
            type: "integer",
            description: "Soft cap on rendered tokens (~4 chars/token).",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              session: { type: "string", required: true },
              tabId: { type: "integer", required: true },
              text: { type: "string", required: true },
              refCount: { type: "integer", required: true },
              truncated: { type: "boolean", required: true },
              nextCursor: { type: "string" },
              hoverProbe: { type: "json" },
              debug: { type: "json" },
              dialogs: { type: "json" },
            },
          },
          render: (_args, value) => [
            {
              type: "text",
              text:
                (value.text.length > 0
                  ? value.text +
                    (value.truncated && !value.nextCursor
                      ? "\n(truncated — re-run with looser caps)"
                      : "")
                  : "(empty observation — page may still be loading)") +
                (value.nextCursor ? `\nnextCursor=${value.nextCursor}` : "") +
                (value.hoverProbe !== undefined
                  ? `\nhoverProbe=${JSON.stringify(value.hoverProbe)}`
                  : "") +
                (value.debug !== undefined ? `\ndebug=${JSON.stringify(value.debug)}` : "") +
                (value.dialogs !== undefined ? `\ndialogs=${JSON.stringify(value.dialogs)}` : ""),
            },
          ],
        },
        isConcurrencySafe: (args) => isSnapshot || args.probeHover !== true,
        async execute(args, exec) {
          if (kind === "observe" && args.cursor !== undefined) {
            requireNonEmpty(args.cursor, "cursor");
            if (
              args.maxDepth !== undefined ||
              args.probeHover === true ||
              args.debugSurfaces === true
            ) {
              throw new Error(
                "cursor is mutually exclusive with maxDepth/probeHover/debugSurfaces",
              );
            }
          }
          const sessionId = registry.resolve(args.session, name);
          const cmdArgs = [kind, "--session", sessionId];
          appendTabId(cmdArgs, args.tabId);
          if (kind === "observe" && args.cursor !== undefined)
            cmdArgs.push("--cursor", args.cursor);
          if (kind === "observe" && args.probeHover === true) cmdArgs.push("--probe-hover");
          if (kind === "observe" && args.debugSurfaces === true) cmdArgs.push("--debug-surfaces");
          if (args.maxDepth !== undefined) cmdArgs.push("--max-depth", String(args.maxDepth));
          if (args.maxTokens !== undefined) cmdArgs.push("--max-tokens", String(args.maxTokens));
          const reply = (await runBsk(deps, exec, cmdArgs, kind, sessionId)) as {
            text: string;
            ref_count: number;
            tab_id: number;
            truncated?: boolean;
            next_cursor?: string;
            hover_probe?: JsonValue;
            debug?: JsonValue;
            dialogs?: JsonValue;
          };
          return {
            session: sessionId,
            tabId: reply.tab_id,
            text: reply.text,
            refCount: reply.ref_count,
            truncated: reply.truncated ?? false,
            ...(reply.next_cursor ? { nextCursor: reply.next_cursor } : {}),
            ...(reply.hover_probe !== undefined ? { hoverProbe: reply.hover_probe } : {}),
            ...(reply.debug !== undefined ? { debug: reply.debug } : {}),
            ...(reply.dialogs !== undefined ? { dialogs: reply.dialogs } : {}),
          };
        },
        presentCall: (args) => ({
          card: "terminal",
          title: cmdline(deps, [kind, "--session", args.session ?? "(current)"]),
          description: isSnapshot ? "Capture an aria snapshot" : "Observe the page semantically",
        }),
        presentResult: presentTerminalResult,
      }),
    );
  };
  registerObservationTool("snapshot");
  registerObservationTool("observe");

  register(
    defineTool({
      name: "interact.click",
      description:
        "Click an element in the session's active tab. Target is a snapshot ref (@e3) from the " +
        "last bsk_inspect observation, or a CSS selector.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Snapshot ref (@e3 / e3) or CSS selector of the element to click.",
        },
        session: SESSION_PARAM,
        captureId: {
          type: "string",
          description: "Single-use capture from a Canvas screenshot; requires imageX/imageY.",
        },
        imageX: { type: "number", description: "X in the original screenshot PNG pixels." },
        imageY: { type: "number", description: "Y in the original screenshot PNG pixels." },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["alt", "ctrl", "meta", "shift"] },
        },
        button: {
          type: "string",
          enum: ["left", "middle", "right"],
          description: "Mouse button (default: left).",
        },
        clickCount: {
          type: "integer",
          description: "Number of consecutive presses (double-click = 2).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            x: { type: "number", required: true },
            y: { type: "number", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] clicked at (${value.x}, ${value.y}) on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.target.trim().length === 0) throw new Error("target must be a non-empty string");
        const sessionId = registry.resolve(args.session, "bsk_interact(action=click)");
        const cmdArgs = ["click", "--session", sessionId];
        if (args.button !== undefined) cmdArgs.push("--button", args.button);
        if (args.clickCount !== undefined) cmdArgs.push("--click-count", String(args.clickCount));
        if (
          args.captureId !== undefined ||
          args.imageX !== undefined ||
          args.imageY !== undefined
        ) {
          if (!args.captureId || !Number.isFinite(args.imageX) || !Number.isFinite(args.imageY))
            throw new Error("Canvas click requires captureId, imageX and imageY");
          cmdArgs.push(
            "--capture",
            args.captureId,
            "--image-x",
            String(args.imageX),
            "--image-y",
            String(args.imageY),
          );
        }
        if (args.modifiers?.length) cmdArgs.push("--modifiers", args.modifiers.join(","));
        cmdArgs.push(args.target);
        const reply = (await runBsk(deps, exec, cmdArgs, "click", sessionId)) as {
          tab_id: number;
          x: number;
          y: number;
        };
        return { session: sessionId, tabId: reply.tab_id, x: reply.x, y: reply.y };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["click", args.target, "--session", args.session ?? "(current)"]),
        description: "Click an element",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "interact.fill",
      description:
        "Fill an editable text input, textarea, or contenteditable editor root, clearing it first by default. Internal paragraphs and spans are not supported. " +
        "Target is a snapshot ref (@e3) or a CSS selector.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Snapshot ref (@e3 / e3) or CSS selector of the field.",
        },
        value: { type: "string", required: true, description: "Text to type into the element." },
        session: SESSION_PARAM,
        noClear: {
          type: "boolean",
          description:
            "Append to the end of the existing value instead of clearing it. " +
            "The tool moves the caret automatically; no prior click or selection is needed.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            valueLength: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] filled field on tab ${value.tabId} (${value.valueLength} chars)`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.target.trim().length === 0) throw new Error("target must be a non-empty string");
        const sessionId = registry.resolve(args.session, "bsk_interact(action=fill)");
        const cmdArgs = ["fill", "--session", sessionId, "--value", args.value];
        if (args.noClear === true) cmdArgs.push("--no-clear");
        cmdArgs.push(args.target);
        const reply = (await runBsk(deps, exec, cmdArgs, "fill", sessionId)) as {
          tab_id: number;
          value_length: number;
        };
        return { session: sessionId, tabId: reply.tab_id, valueLength: reply.value_length };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["fill", args.target, "--session", args.session ?? "(current)"]),
        description: `Fill a field with ${args.value.length} chars`,
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "interact.press",
      description:
        "Dispatch a keyboard key or combo (Enter, Escape, ArrowDown, Ctrl+A, …) to the session's " +
        "active tab, optionally focusing a target element first.",
      parameters: {
        key: {
          type: "string",
          required: true,
          description: "Key spec: a CDP key name (Enter, a, ArrowLeft) or a combo (Ctrl+A).",
        },
        session: SESSION_PARAM,
        target: {
          type: "string",
          description: "Snapshot ref (@e3) or CSS selector to focus before pressing.",
        },
        holdMs: {
          type: "integer",
          description: "Hold the key down for N milliseconds between keyDown and keyUp.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            key: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `[session ${value.session}] pressed ${value.key} on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        if (args.key.trim().length === 0) throw new Error("key must be a non-empty string");
        const sessionId = registry.resolve(args.session, "bsk_interact(action=press)");
        const cmdArgs = ["press", "--session", sessionId];
        if (args.target !== undefined) {
          if (args.target.trim().length === 0) throw new Error("target must be a non-empty string");
          // bsk distinguishes ref vs selector via flags; positional detection is CLI-side for
          // click/fill only, so pass the explicit flag that matches the target's shape.
          if (/^@?e\d+$/.test(args.target)) {
            cmdArgs.push("--ref", args.target);
          } else {
            cmdArgs.push("--selector", args.target);
          }
        }
        if (args.holdMs !== undefined) cmdArgs.push("--hold-ms", String(args.holdMs));
        cmdArgs.push(args.key);
        const reply = (await runBsk(deps, exec, cmdArgs, "press", sessionId)) as {
          tab_id: number;
          key: string;
        };
        return { session: sessionId, tabId: reply.tab_id, key: reply.key };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, ["press", args.key, "--session", args.session ?? "(current)"]),
        description: "Press a key",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "inspect.screenshot",
      description:
        "Capture a viewport, ref crop or full-page PNG. Full-page capture may scroll the page. " +
        "Returns an image preview when supported. An explicit output is a new file and remains saved.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        ref: {
          type: "string",
          description:
            "Snapshot ref (@e3) from the last snapshot/observe; incompatible with fullPage.",
        },
        fullPage: {
          type: "boolean",
          description: "Scroll and stitch the full page (default false).",
        },
        scope: {
          type: "string",
          enum: ["current", "follow"],
          description: "Full-page range; requires fullPage=true.",
        },
        timeoutMs: TIMEOUT_MS_PARAM,
        output: {
          type: "string",
          description: "New PNG destination on this host; existing files are never overwritten.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            path: { type: "string", required: true },
            width: { type: "integer", required: true },
            height: { type: "integer", required: true },
            byteSize: { type: "integer", required: true },
            captureId: { type: "string" },
            captureUnavailable: { type: "string" },
            savedTo: { type: "string" },
            scope: { type: "string" },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string", required: true },
                mediaType: {
                  type: "string",
                  required: true,
                  enum: ["image/png", "image/jpeg", "image/webp", "image/gif"],
                },
                bytes: { type: "integer", required: true },
                width: { type: "integer", required: true },
                height: { type: "integer", required: true },
                name: { type: "string" },
              },
            },
          },
        },
        render: (_args, value) => {
          const text =
            value.image !== undefined
              ? `[session ${value.session}] screenshot of tab ${value.tabId} (${value.width}x${value.height}px)`
              : `[session ${value.session}] screenshot saved to ${value.path} (${value.width}x${value.height}px, ${value.byteSize} bytes) — this deployment cannot inline images; read the file to view it`;
          const captureText = value.captureId
            ? `; captureId=${value.captureId}, single-use click with original PNG imageX/imageY`
            : value.captureUnavailable
              ? `; capture unavailable: ${value.captureUnavailable}`
              : "";
          const blocks: ContentBlock[] = [
            {
              type: "text",
              text: text + captureText + (value.savedTo ? `; saved to ${value.savedTo}` : ""),
            },
          ];
          if (value.image !== undefined) {
            blocks.push({
              type: "image",
              // Structurally an ImageAttachmentRef; branded without a runtime import.
              attachment: {
                attachmentId: value.image.attachmentId,
                mediaType: value.image.mediaType,
                bytes: value.image.bytes,
                width: value.image.width,
                height: value.image.height,
                ...(value.image.name !== undefined ? { name: value.image.name } : {}),
              } as never,
            });
          }
          return blocks;
        },
      },
      isConcurrencySafe: (args) => args.fullPage !== true,
      async execute(args, exec) {
        if (args.ref !== undefined) requireNonEmpty(args.ref, "ref");
        if (args.output !== undefined) requireNonEmpty(args.output, "output");
        if (args.fullPage === true && args.ref !== undefined) {
          throw new Error("fullPage is mutually exclusive with ref");
        }
        if (args.fullPage !== true && (args.scope !== undefined || args.timeoutMs !== undefined)) {
          throw new Error("scope/timeoutMs require fullPage=true");
        }
        requirePositive(args.timeoutMs, "timeoutMs");
        const sessionId = registry.resolve(args.session, "bsk_inspect(action=screenshot)");
        const outPath = join(
          tmpdir(),
          `bsk-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
        );
        const cmdArgs = ["screenshot", "--session", sessionId, "--out", outPath];
        appendTabId(cmdArgs, args.tabId);
        if (args.ref !== undefined) cmdArgs.push("--ref", args.ref);
        if (args.fullPage === true) cmdArgs.push("--full-page");
        if (args.scope !== undefined) cmdArgs.push("--scope", args.scope);
        if (args.timeoutMs !== undefined) cmdArgs.push("--timeout", `${args.timeoutMs}ms`);
        // The scratch PNG is only kept when it IS the model-facing artifact
        // (no attachment store to inline through); once the bytes are saved
        // into the store — and on every failure/abort path — it is deleted.
        let keepFile = false;
        let writtenPath: string | undefined;
        try {
          const reply = (await runBsk(
            deps,
            exec,
            cmdArgs,
            "screenshot",
            sessionId,
            args.fullPage === true ? runnerTimeout(deps, args.timeoutMs ?? 120_000) : undefined,
          )) as {
            tab_id: number;
            width: number;
            height: number;
            path: string;
            byte_size: number;
            capture_id?: string;
            capture_unavailable?: string;
            scope?: string;
          };
          writtenPath = reply.path;
          const data = await readFile(reply.path);
          if (exec.signal.aborted) throw abortError();
          const ref = await trySaveScreenshot(deps.ctx, exec, data, `screenshot-${sessionId}.png`);
          if (exec.signal.aborted) throw abortError();
          const savedTo = args.output === undefined ? undefined : resolve(args.output);
          if (savedTo !== undefined) await copyFile(reply.path, savedTo, constants.COPYFILE_EXCL);
          keepFile = savedTo === undefined && ref === undefined;
          return {
            session: sessionId,
            tabId: reply.tab_id,
            path: savedTo ?? reply.path,
            ...(savedTo !== undefined ? { savedTo } : {}),
            ...(reply.scope !== undefined ? { scope: reply.scope } : {}),
            width: reply.width,
            height: reply.height,
            byteSize: reply.byte_size,
            ...(reply.capture_id ? { captureId: reply.capture_id } : {}),
            ...(reply.capture_unavailable ? { captureUnavailable: reply.capture_unavailable } : {}),
            ...(ref !== undefined
              ? {
                  image: {
                    attachmentId: String(ref.attachmentId),
                    mediaType: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...(ref.name !== undefined ? { name: ref.name } : {}),
                  },
                }
              : {}),
          };
        } finally {
          if (!keepFile) await unlink(writtenPath ?? outPath).catch(() => {});
        }
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, [
          "screenshot",
          "--session",
          args.session ?? "(current)",
          ...(args.ref !== undefined ? ["--ref", args.ref] : []),
        ]),
        description: "Capture a screenshot",
      }),
      presentResult: presentTerminalResult,
    }),
  );

  register(
    defineTool({
      name: "assist.emulate",
      description:
        "Apply (or clear) mobile device emulation on the session's active tab: viewport metrics, " +
        "user agent, and touch. Overrides are per-tab and not inherited by new tabs.",
      parameters: {
        session: SESSION_PARAM,
        tabId: TAB_ID_PARAM,
        device: {
          type: "string",
          enum: DEVICE_PRESETS,
          description:
            "Built-in preset; manual values override it and may supply only one dimension.",
        },
        width: { type: "integer", description: "Viewport width in CSS pixels (1..7680)." },
        height: { type: "integer", description: "Viewport height in CSS pixels (1..7680)." },
        mobile: {
          type: "boolean",
          description: "Mobile viewport, including explicit false; requires dimensions or device.",
        },
        dpr: {
          type: "number",
          description: "Positive finite pixel ratio; requires dimensions or device.",
        },
        ua: { type: "string", description: "User-Agent override; dimensions are optional." },
        acceptLanguage: {
          type: "string",
          description: "Accept-Language override; requires ua or device.",
        },
        touch: { type: "boolean", description: "Touch emulation, including explicit false." },
        maxTouchPoints: {
          type: "integer",
          description: "Positive touch point count (implies touch unless explicitly false).",
        },
        off: {
          type: "boolean",
          description: "Clear overrides; mutually exclusive with every emulation option.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            session: { type: "string", required: true },
            tabId: { type: "integer", required: true },
            cleared: { type: "boolean", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.cleared
              ? `[session ${value.session}] cleared emulation on tab ${value.tabId}`
              : `[session ${value.session}] applied emulation on tab ${value.tabId}`,
          },
        ],
      },
      async execute(args, exec) {
        const sessionId = registry.resolve(args.session, "bsk_assist(action=emulate)");
        const overrides = [
          args.device,
          args.width,
          args.height,
          args.mobile,
          args.dpr,
          args.ua,
          args.acceptLanguage,
          args.touch,
          args.maxTouchPoints,
        ];
        if (args.off === true && overrides.some((value) => value !== undefined)) {
          throw new Error("off is mutually exclusive with emulation overrides");
        }
        if (args.off !== true && overrides.every((value) => value === undefined)) {
          throw new Error("nothing to apply: pass device, manual emulation options, or off");
        }
        for (const [name, value] of [
          ["width", args.width],
          ["height", args.height],
        ] as const) {
          if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 7680)) {
            throw new Error(`${name} must be an integer in 1..7680`);
          }
        }
        if (args.dpr !== undefined && (!Number.isFinite(args.dpr) || args.dpr <= 0)) {
          throw new Error("dpr must be positive and finite");
        }
        if (
          args.maxTouchPoints !== undefined &&
          (!Number.isInteger(args.maxTouchPoints) ||
            args.maxTouchPoints < 1 ||
            args.maxTouchPoints > 4_294_967_295)
        ) {
          throw new Error("maxTouchPoints must be an integer in 1..4294967295");
        }
        if (args.device === undefined) {
          if ((args.width === undefined) !== (args.height === undefined)) {
            throw new Error("width and height must be given together unless device supplies them");
          }
          if (args.width === undefined && (args.dpr !== undefined || args.mobile !== undefined)) {
            throw new Error("dpr/mobile require width/height or device");
          }
          if (args.acceptLanguage !== undefined && args.ua === undefined) {
            throw new Error("acceptLanguage requires ua or device");
          }
        }
        const cmdArgs = ["emulate", "--session", sessionId];
        appendTabId(cmdArgs, args.tabId);
        if (args.off === true) {
          cmdArgs.push("--off");
        } else {
          for (const [flag, value] of [
            ["device", args.device],
            ["width", args.width],
            ["height", args.height],
            ["dpr", args.dpr],
            ["ua", args.ua],
            ["accept-language", args.acceptLanguage],
            ["max-touch-points", args.maxTouchPoints],
          ] as const) {
            if (value !== undefined) cmdArgs.push(`--${flag}`, String(value));
          }
          if (args.mobile !== undefined) cmdArgs.push(args.mobile ? "--mobile" : "--no-mobile");
          if (args.touch !== undefined) cmdArgs.push(args.touch ? "--touch" : "--no-touch");
        }
        const reply = (await runBsk(deps, exec, cmdArgs, "emulate", sessionId)) as {
          tab_id: number;
          cleared: boolean;
        };
        return { session: sessionId, tabId: reply.tab_id, cleared: reply.cleared };
      },
      presentCall: (args) => ({
        card: "terminal",
        title: cmdline(deps, [
          "emulate",
          "--session",
          args.session ?? "(current)",
          ...(args.off === true ? ["--off"] : []),
          ...(args.device !== undefined ? ["--device", args.device] : []),
        ]),
        description: "Emulate a device environment",
      }),
      presentResult: presentTerminalResult,
    }),
  );
  registerPhaseOneTools(deps, register, {
    run: (exec, args, label, observeSession, runnerTimeoutMs) =>
      runBsk(deps, exec, args, label, observeSession, runnerTimeoutMs),
    commandLine: (args) => cmdline(deps, args),
    presentTerminalResult,
  });
}

/**
 * Build the private action handlers without publishing them to the model. The
 * six browser tools dispatch through these handlers, preserving validation,
 * rendering, cancellation, ownership, UI presentation, and attachments.
 */
export function createBrowserOperationDefinitions(deps: ToolDeps): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  defineBrowserOperations(deps, (definition) => {
    definitions.push(definition);
  });
  return definitions;
}
