import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserTools } from "../src/browser-tools";
import { KeyedExecutor } from "../src/queue";
import { type BskRunOptions, type BskRunResult, createBskRunner } from "../src/runner";
import { SessionRegistry } from "../src/sessions";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const json = (value: unknown): BskRunResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
  timedOut: false,
  aborted: false,
});
const exec = (signal = new AbortController().signal) =>
  ({ signal, callId: "enhancement", name: "test" }) as ToolRunContext;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockClear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "bsk-enhancement-"));
  directories.push(path);
  return path;
}

function setup(
  run = async (_args: string[], _options?: BskRunOptions) =>
    json({ ok: true, tab_id: 7, value: 3 }),
) {
  const tools = new Map<string, ToolDefinition>();
  const registry = new SessionRegistry(5);
  registry.completeStart({ sessionId: "s1", startedAtMs: 0 });
  const observation = {
    acquireForeground: vi.fn(() => vi.fn()),
    beginAction: vi.fn(),
    endAction: vi.fn(),
  };
  const runner = { run: vi.fn(run), killAll() {}, killFor: () => 0 };
  registerBrowserTools({
    ctx: {
      tools: {
        register: (definition: ToolDefinition) => {
          tools.set(definition.name, definition);
          return () => {};
        },
      },
    } as never,
    runner,
    registry,
    observation: observation as never,
    queue: new KeyedExecutor(),
    config: {
      bskPath: "bsk",
      defaultTimeoutMs: 1000,
      maxSessions: 5,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  });
  const tool = (name: string) => tools.get(name)!;
  const call = (name: string, args: Record<string, unknown>, context = exec()) =>
    tool(name).execute(
      Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)) as never,
      context,
    );
  return { tool, call, registry, runner, observation };
}

describe("enhanced public routes", () => {
  it.each([
    {},
    { awaitPromise: false, returnByValue: false },
  ])("maps evaluate defaults and explicit false: %j", async (options) => {
    const { call, runner, tool } = setup();
    await expect(
      call("bsk_interact", {
        action: "evaluate",
        expression: "Promise.resolve(3)",
        session: "s1",
        tabId: 7,
        timeoutMs: 2000,
        ...options,
      }),
    ).resolves.toMatchObject({ session: "s1", ok: true, value: 3 });
    expect(runner.run.mock.calls[0]).toEqual([
      [
        "evaluate",
        "--session",
        "s1",
        "--await-promise",
        String(options.awaitPromise ?? true),
        "--return-by-value",
        String(options.returnByValue ?? true),
        "--timeout",
        "2000ms",
        "--tab-id",
        "7",
        "--",
        "Promise.resolve(3)",
      ],
      expect.objectContaining({ timeoutMs: 17_000, tag: "s1", signal: expect.any(AbortSignal) }),
    ]);
    expect(tool("bsk_interact").isConcurrencySafe?.({ action: "evaluate" } as never)).toBe(false);
  });

  it("rejects a page exception at exit zero before observation reports completion", async () => {
    const error = { text: "Error: page boom", line: 2, column: 4, stack: "at page.js:2:4" };
    const { call, observation } = setup(async () => json({ ok: false, tab_id: 7, error }));
    await expect(
      call("bsk_interact", { action: "evaluate", expression: "throwing()" }),
    ).rejects.toThrow("page boom");
    expect(observation.endAction).toHaveBeenCalledWith("s1", expect.stringContaining("page boom"));
  });

  it.each([
    { action: "evaluate", expression: "   " },
    { action: "upload", target: "#files", files: [] },
    { action: "upload", target: "#files", files: [" "] },
    { action: "upload", target: "#files", files: ["a.txt"], mode: "invalid" },
    { action: "download", target: "#save" },
    { action: "download", target: "#save", output: " " },
  ])("rejects invalid input before invoking the CLI: %j", async (args) => {
    const { call, runner } = setup();
    await expect(call("bsk_interact", args)).rejects.toThrow();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each(["evaluate", "upload", "download"])("rejects foreign sessions for %s", async (action) => {
    const { call, runner } = setup();
    await expect(
      call("bsk_interact", {
        action,
        expression: "1",
        target: "#target",
        files: ["a.txt"],
        output: "out.txt",
        session: "foreign",
      }),
    ).rejects.toThrow(/does not belong to this plugin/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "input",
    "drop",
  ])("maps upload files and mode %s to the official pipeline", async (mode) => {
    const files = mode === undefined ? ["a.txt"] : ["a.txt", "b.txt"];
    const { call, runner } = setup(async () => json({ tab_id: 7, file_names: files }));
    await expect(
      call("bsk_interact", { action: "upload", target: "#files", files, tabId: 7, mode }),
    ).resolves.toMatchObject({ session: "s1", file_names: files });
    expect(runner.run.mock.calls[0][0]).toEqual([
      "upload",
      "--session",
      "s1",
      "--timeout",
      "120000ms",
      "--tab-id",
      "7",
      ...files.flatMap((file) => ["--file", file]),
      ...(mode === undefined ? [] : ["--mode", mode]),
      "--",
      "#files",
    ]);
    expect(runner.run.mock.calls[0][1]).toMatchObject({ timeoutMs: 135_000, tag: "s1" });
  });

  it.each([
    undefined,
    false,
    true,
  ])("only permits download overwrite when true: %s", async (overwrite) => {
    const { call, runner } = setup(async () => json({ tab_id: 7, path: "out.txt", byte_size: 10 }));
    await expect(
      call("bsk_interact", {
        action: "download",
        target: "#save",
        output: "out.txt",
        timeoutMs: 5000,
        overwrite,
      }),
    ).resolves.toMatchObject({ path: "out.txt", session: "s1" });
    expect(runner.run.mock.calls[0][0]).toEqual([
      "download",
      "--session",
      "s1",
      "--timeout",
      "5000ms",
      "--out",
      "out.txt",
      ...(overwrite === true ? ["--overwrite"] : []),
      "--",
      "#save",
    ]);
  });

  it.each([
    "upload",
    "download",
  ])("preserves CLI transfer failure details for %s", async (action) => {
    const { call, observation } = setup(async () => ({
      ...json({ code: "local", message: "file operation failed", hint: "check local path" }),
      code: 2,
    }));
    await expect(
      call("bsk_interact", {
        action,
        target: "#target",
        files: ["missing.txt"],
        output: "out.txt",
      }),
    ).rejects.toThrow(/file operation failed[\s\S]*check local path/);
    expect(observation.endAction).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("file operation failed"),
    );
  });

  it("serializes evaluation and transfer calls through the shared session FIFO", async () => {
    let finish!: (result: BskRunResult) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { call, runner } = setup(async (args) => {
      if (args[0] === "evaluate") {
        started();
        return new Promise<BskRunResult>((resolve) => {
          finish = resolve;
        });
      }
      return json({ tab_id: 7, file_names: ["a.txt"] });
    });
    const first = call("bsk_interact", { action: "evaluate", expression: "1" });
    await running;
    const second = call("bsk_interact", { action: "upload", target: "#files", files: ["a.txt"] });
    expect(runner.run).toHaveBeenCalledTimes(1);
    finish(json({ ok: true, value: 1 }));
    await Promise.all([first, second]);
    expect(runner.run.mock.calls.map(([args]) => args[0])).toEqual(["evaluate", "upload"]);
  });

  it.each([
    "evaluate",
    "upload",
    "download",
    "wait-ms",
  ])("passes cancellation through the shared runtime for %s", async (action) => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { call } = setup(
      async (_args, options) =>
        new Promise<BskRunResult>((resolve) => {
          started();
          options!.signal!.addEventListener(
            "abort",
            () => resolve({ ...json({}), code: null, aborted: true }),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const result = call(
      action === "wait-ms" ? "bsk_page" : "bsk_interact",
      {
        action,
        expression: "1",
        target: "#target",
        files: ["a.txt"],
        output: "out.txt",
        durationMs: 5000,
      },
      exec(controller.signal),
    );
    await running;
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
  });

  it.each([0, 1, 300_000])("wait-ms needs no owned session at %i ms", async (durationMs) => {
    const { call, registry, runner } = setup(async () => json({ waited_ms: durationMs }));
    registry.remove("s1");
    await expect(call("bsk_page", { action: "wait-ms", durationMs })).resolves.toEqual({
      waitedMs: durationMs,
    });
    expect(runner.run.mock.calls[0]).toEqual([
      ["wait-ms", `${durationMs}ms`],
      expect.objectContaining({ timeoutMs: Math.max(1000, durationMs + 15_000) }),
    ]);
    expect(runner.run.mock.calls[0][1]).not.toHaveProperty("tag");
  });

  it.each([
    -1,
    300_001,
    0.5,
    NaN,
    Infinity,
    undefined,
  ])("rejects invalid wait duration %s before CLI", async (durationMs) => {
    const { call, runner } = setup();
    await expect(call("bsk_page", { action: "wait-ms", durationMs })).rejects.toThrow("durationMs");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("gives evaluate timeout failures the existing runner error", async () => {
    const { call } = setup(async () => ({ ...json({}), code: null, timedOut: true }));
    await expect(
      call("bsk_interact", { action: "evaluate", expression: "never()", timeoutMs: 1 }),
    ).rejects.toThrow("timed out");
  });

  it("keeps --json out of positional expression/target arguments in the actual runner", async () => {
    const argv: string[][] = [];
    const runner = createBskRunner("bsk", (_command, args) => {
      argv.push(args);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        exitCode: number | null;
        signalCode: null;
        unref(): void;
      };
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        exitCode: null,
        signalCode: null,
        unref() {},
      });
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child as unknown as ChildProcess;
    });
    const { call } = setup((args, options) => runner.run(args, options));
    for (const action of ["evaluate", "upload", "download"]) {
      await call("bsk_interact", {
        action,
        expression: "-1",
        target: "--target",
        files: ["a.txt"],
        output: "out.txt",
      });
      const args = argv.at(-1)!;
      expect(args[0]).toBe("--json");
      expect(args.indexOf("--json")).toBeLessThan(args.indexOf("--"));
      expect(args.slice(args.indexOf("--") + 1)).toEqual([
        action === "evaluate" ? "-1" : "--target",
      ]);
    }
  });
});

describe("HTML export", () => {
  const html = "<main>你好🌍</main>";
  const reply = { tab_id: 7, html, byte_size: 4096, truncated: true };
  it("keeps inline HTML and returns only metadata in export results and terminal cards", async () => {
    const { call, runner, tool } = setup(async () => json(reply));
    const inline = await call("bsk_inspect", { action: "html" });
    expect(inline).toEqual({ session: "s1", tabId: 7, html, byteSize: 4096, truncated: true });
    const output = join(await directory(), "page.html");
    const args = { action: "html", output, tabId: 7, ref: "@e2", maxBytes: 2048 };
    const value = await call("bsk_inspect", args);
    expect(value).toEqual({
      session: "s1",
      tabId: 7,
      path: output,
      writtenBytes: Buffer.byteLength(html, "utf8"),
      byteSize: 4096,
      truncated: true,
    });
    expect(await readFile(output, "utf8")).toBe(html);
    expect(runner.run.mock.calls[1][0]).toEqual([
      "get-html",
      "--session",
      "s1",
      "--tab-id",
      "7",
      "--ref",
      "@e2",
      "--max-bytes",
      "2048",
    ]);
    const content = tool("bsk_inspect").output.render(
      args as never,
      value as Parameters<ToolDefinition["output"]["render"]>[1],
    );
    expect(JSON.stringify(content)).not.toContain(html);
    expect(
      tool("bsk_inspect").presentResult?.(args as never, { content, isError: false } as never),
    ).toMatchObject({ card: "terminal", output: expect.stringContaining(output), exitCode: 0 });
    expect(tool("bsk_inspect").isConcurrencySafe?.(args as never)).toBe(false);
  });

  it("never overwrites an existing output, and reports a missing parent directory", async () => {
    const { call } = setup(async () => json(reply));
    const root = await directory();
    const output = join(root, "existing.html");
    await writeFile(output, "keep");
    await expect(call("bsk_inspect", { action: "html", output })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(output, "utf8")).toBe("keep");
    await expect(
      call("bsk_inspect", { action: "html", output: join(root, "missing", "page.html") }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans its new file after a write failure and preserves the original error", async () => {
    const { call } = setup(async () => json(reply));
    const output = join(await directory(), "failed.html");
    const handle = await open(output, "wx");
    const failure = new Error("disk full");
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
    vi.mocked(open).mockResolvedValueOnce(handle);
    await expect(call("bsk_inspect", { action: "html", output })).rejects.toBe(failure);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans its new file when closing fails", async () => {
    const { call } = setup(async () => json(reply));
    const output = join(await directory(), "close-failed.html");
    const handle = await open(output, "wx");
    const close = handle.close.bind(handle);
    const failure = new Error("close failed");
    vi.spyOn(handle, "close").mockRejectedValueOnce(failure).mockImplementation(close);
    vi.mocked(open).mockResolvedValueOnce(handle);
    await expect(call("bsk_inspect", { action: "html", output })).rejects.toBe(failure);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the owned partial file on cancellation during writing", async () => {
    const { call } = setup(async () => json(reply));
    const output = join(await directory(), "cancelled.html");
    const handle = await open(output, "wx");
    const write = handle.writeFile.bind(handle);
    const controller = new AbortController();
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      controller.abort();
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    await expect(
      call("bsk_inspect", { action: "html", output }, exec(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
