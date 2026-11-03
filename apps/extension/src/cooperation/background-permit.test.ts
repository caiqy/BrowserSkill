import { afterEach, describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { ToolDispatcher } from "@/tools/dispatcher";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame, RequestFrame } from "@/transport/types";
import { CooperationController } from "./controller";
import type { FrameState } from "./types";

vi.mock("@/tools/observation", () => ({
  handleSnapshot: vi.fn(async () => ({
    text: "fixture",
    ref_count: 0,
    tab_id: 7,
    truncated: false,
  })),
  captureVomObservation: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(policy?: "strict" | "target") {
  const events = new Set<(source: { tabId: number }, method: string, params: unknown) => void>();
  const detaches = new Set<(source: { tabId: number }, reason: string) => void>();
  const native = vi.fn(
    async (_target: unknown, method: string, _params?: object): Promise<unknown> =>
      method === "Runtime.evaluate" ? { result: { type: "number", value: 7 } } : {},
  );
  const api = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: native,
    onEvent: {
      addListener: (fn: typeof events extends Set<infer T> ? T : never) => events.add(fn),
      removeListener: (fn: typeof events extends Set<infer T> ? T : never) => events.delete(fn),
    },
    onDetach: {
      addListener: (fn: typeof detaches extends Set<infer T> ? T : never) => detaches.add(fn),
      removeListener: (fn: typeof detaches extends Set<infer T> ? T : never) => detaches.delete(fn),
    },
  } as unknown as CdpDebuggerApi;
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  await sessions.start("owner");
  vi.stubGlobal("chrome", {
    tabs: {
      get: async () => ({ id: 7, windowId: 100, active: false, url: "https://fixture.test" }),
      query: async () => [],
    },
  });
  let frame: FrameState = {
    document: "fixture-document",
    revision: 0,
    structure: 0,
    human: 0,
    focusIsDocument: true,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    events: [],
  };
  const controller = new CooperationController({
    sessions,
    changed: () => {},
    readFrames: async () => new Map([[0, structuredClone(frame)]]),
    resumeFrames: async () => {},
    now: () => 10000,
  });
  const cdp = new ChromiumCdp(api, {
    onDocumentChanged: (tabId, event) => controller.invalidate(tabId, event),
  });
  await cdp.ensureAttached(7);
  const signal = new AbortController().signal;
  await controller.run(
    { id: "start", method: "tool.session_start", params: { session_id: "owner" } },
    cdp,
    signal,
    async () => ({ agent_window_id: 100 }),
  );
  const sync = (policy?: "strict" | "target") =>
    controller.command(
      { session_id: "owner", tab_id: 7, action: "sync", timeout_ms: 0, control_policy: policy },
      cdp,
      signal,
    ) as Promise<{ context_id: string }>;
  const first = await sync(policy);
  const handlers = new Set<FrameHandler>();
  const sent: ProtocolFrame[] = [];
  const transport = {
    state: "connected",
    connect: async () => {},
    disconnect: async () => {},
    send: (frame: ProtocolFrame) => sent.push(frame),
    onMessage: (fn: FrameHandler) => {
      handlers.add(fn);
      return { dispose: () => handlers.delete(fn) };
    },
    onConnectionStateChange: () => ({ dispose: () => {} }),
  } as Transport;
  const dispatcher = new ToolDispatcher({ transport, sessions, cdp, cooperation: controller });
  dispatcher.start();
  const deliver = (request: RequestFrame) => {
    for (const fn of handlers) fn(request);
  };
  const act = (context = first.context_id, extra: Record<string, unknown> = {}) => {
    deliver({
      id: "action",
      method: "tool.evaluate",
      params: { session_id: "owner", tab_id: 7, context_id: context, expression: "7", ...extra },
    });
    return vi.waitFor(
      () => {
        const reply = sent.find((item) => "id" in item && item.id === "action");
        expect(reply).toBeDefined();
        return reply;
      },
      { timeout: 3000 },
    );
  };
  native.mockClear();
  return {
    cdp,
    api,
    native,
    controller,
    dispatcher,
    act,
    deliver,
    sent,
    sync,
    human: () => {
      frame = { ...frame, human: frame.human + 1, lastInput: 10000 };
      controller.receive(7, 0, frame);
    },
    event: (method: string) => {
      for (const fn of events) fn({ tabId: 7 }, method, {});
    },
    detach: () => {
      for (const fn of detaches) fn({ tabId: 7 }, "canceled_by_user");
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("request background permit through cooperation dispatcher", () => {
  it("enables the inactive owned tab for one valid request and releases it", async () => {
    const f = await fixture();
    try {
      expect(await f.act()).toMatchObject({ result: { ok: true, value: 7 } });
      expect(
        f.native.mock.calls
          .filter(([, method]) => method === "Emulation.setFocusEmulationEnabled")
          .map(([, , params]) => params),
      ).toEqual([{ enabled: true }, { enabled: false }]);
      expect(
        f.native.mock.calls.filter(([, method]) => method === "Runtime.evaluate"),
      ).toHaveLength(1);
    } finally {
      f.dispatcher.stop();
    }
  });
});

it.each([
  "context",
  "expect",
])("refuses invalid %s before acquiring background execution", async (kind) => {
  const f = await fixture();
  try {
    const reply = await f.act(
      kind === "context" ? "foreign" : undefined,
      kind === "expect" ? { expect: [{ target: "#missing", field: "exists", equals: true }] } : {},
    );
    expect(reply).toHaveProperty("error");
    expect(
      f.native.mock.calls.some(
        ([, method]) =>
          method === "Emulation.setFocusEmulationEnabled" || method === "Runtime.evaluate",
      ),
    ).toBe(false);
  } finally {
    f.dispatcher.stop();
  }
});

it.each([
  "human",
  "hold",
  "cancel",
  "navigation",
  "detach",
  "stop",
])("revokes an acquire waiting for native acknowledgement: %s", async (kind) => {
  const f = await fixture();
  const gate = deferred();
  f.native.mockImplementation(async (_target, method, params) => {
    if (method === "Emulation.setFocusEmulationEnabled" && (params as { enabled: boolean }).enabled)
      await gate.promise;
    return {};
  });
  try {
    const action = f.act();
    await vi.waitFor(() =>
      expect(
        f.native.mock.calls.some(([, method]) => method === "Emulation.setFocusEmulationEnabled"),
      ).toBe(true),
    );
    if (kind === "human") f.human();
    if (kind === "hold") await f.controller.control(7, f.controller.view(7)!.revision, "hold");
    if (kind === "cancel")
      f.deliver({ id: "cancel", method: "cancel", params: { rpc_id: "action" } });
    if (kind === "navigation") f.controller.invalidate(7, "Page.frameNavigated");
    if (kind === "detach") f.detach();
    if (kind === "stop") f.controller.stopSession("owner");
    gate.resolve();
    expect(await action).toHaveProperty("error");
    expect(f.native.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(
      0,
    );
    expect(f.api.attach).toHaveBeenCalledTimes(1);
    if (kind !== "detach")
      expect(
        f.native.mock.calls
          .filter(([, method]) => method === "Emulation.setFocusEmulationEnabled")
          .at(-1)?.[2],
      ).toEqual({ enabled: false });
  } finally {
    gate.resolve();
    f.dispatcher.stop();
  }
});

it("runs the last authority fence immediately before native enable", async () => {
  const f = await fixture();
  const send = f.cdp.sendGuarded.bind(f.cdp);
  vi.spyOn(f.cdp, "sendGuarded").mockImplementation(async (target, method, params, guard) => {
    if (method === "Emulation.setFocusEmulationEnabled" && (params as { enabled: boolean }).enabled)
      f.human();
    return send(target, method, params, guard);
  });
  try {
    expect(await f.act()).toHaveProperty("error");
    expect(
      f.native.mock.calls.some(
        ([, method, params]) =>
          method === "Emulation.setFocusEmulationEnabled" &&
          (params as { enabled: boolean }).enabled,
      ),
    ).toBe(false);
    expect(f.native.mock.calls.some(([, method]) => method === "Runtime.evaluate")).toBe(false);
  } finally {
    f.dispatcher.stop();
  }
});

it("releases only its request while a persistent preview owner remains", async () => {
  const f = await fixture();
  try {
    await f.cdp.acquireBackgroundExecution("preview", 7);
    f.native.mockClear();
    expect(await f.act()).toHaveProperty("result");
    expect(f.cdp.ownsBackgroundExecution("preview", 7)).toBe(true);
    expect(
      f.native.mock.calls.some(([, method]) => method === "Emulation.setFocusEmulationEnabled"),
    ).toBe(false);
    await f.cdp.releaseBackgroundExecution("preview", 7);
    expect(f.native.mock.calls.at(-1)?.[2]).toEqual({ enabled: false });
    expect(f.cdp.getSessionClaimId("owner", 7)).toBeUndefined();
  } finally {
    f.dispatcher.stop();
  }
});

it("keeps a human intervention after native script dispatch uncertain and never replays", async () => {
  const f = await fixture();
  f.native.mockImplementation(async (_target, method) => {
    if (method === "Runtime.evaluate") {
      f.human();
      return { result: { type: "number", value: 7 } };
    }
    return {};
  });
  try {
    expect(await f.act()).toMatchObject({ error: { data: { effect_state: "unknown" } } });
    expect(f.native.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(
      1,
    );
  } finally {
    f.dispatcher.stop();
  }
});

it("bounds a cancelled acquire with a late enable acknowledgement to its original attachment", async () => {
  const f = await fixture();
  const gate = deferred();
  f.native.mockImplementation(async (_target, method, params) => {
    if (method === "Emulation.setFocusEmulationEnabled" && (params as { enabled: boolean }).enabled)
      await gate.promise;
    return {};
  });
  try {
    const action = f.act();
    await vi.waitFor(() =>
      expect(
        f.native.mock.calls.some(([, method]) => method === "Emulation.setFocusEmulationEnabled"),
      ).toBe(true),
    );
    f.deliver({ id: "cancel", method: "cancel", params: { rpc_id: "action" } });
    expect(await action).toMatchObject({
      error: { code: "cancelled", data: { cleanup: "pending" } },
    });
    expect(f.api.detach).toHaveBeenCalledTimes(1);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.api.attach).toHaveBeenCalledTimes(1);
    expect(f.native.mock.calls.some(([, method]) => method === "Runtime.evaluate")).toBe(false);
  } finally {
    gate.resolve();
    f.dispatcher.stop();
  }
});

it.each([
  false,
  true,
])("keeps acquire idempotent and fences an explicit restore, revoke=%s", async (revoke) => {
  const f = await fixture();
  const create = f.cdp.requestBackgroundExecution.bind(f.cdp);
  vi.spyOn(f.cdp, "requestBackgroundExecution").mockImplementation((...args) => {
    const permit = create(...args);
    return {
      ...permit,
      acquire: async (session, tab) => {
        await expect(permit.acquire("foreign", tab)).rejects.toThrow("another session");
        await permit.acquire(session, tab);
        await permit.acquire(session, tab);
        if (revoke) f.human();
        await permit.restore(session, tab);
      },
    };
  });
  try {
    const reply = await f.act();
    expect(reply).toHaveProperty(revoke ? "error" : "result");
    const enables = f.native.mock.calls.filter(
      ([, method, params]) =>
        method === "Emulation.setFocusEmulationEnabled" && (params as { enabled: boolean }).enabled,
    );
    expect(enables).toHaveLength(revoke ? 1 : 2);
    expect(f.native.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(
      revoke ? 0 : 1,
    );
  } finally {
    f.dispatcher.stop();
  }
});

it("exposes neither background ownership nor a permit factory to supplemental reads", async () => {
  const f = await fixture();
  try {
    await f.controller.run(
      { id: "read", method: "tool.snapshot", params: { session_id: "owner", tab_id: 7 } },
      f.cdp,
      new AbortController().signal,
      async (runner) => {
        expect(runner.acquireBackgroundExecution).toBeUndefined();
        expect(runner.requestBackgroundExecution).toBeUndefined();
        expect(runner.restoreBackgroundExecution).toBeUndefined();
        return {};
      },
    );
    expect(
      f.native.mock.calls.some(([, method]) => method === "Emulation.setFocusEmulationEnabled"),
    ).toBe(false);
  } finally {
    f.dispatcher.stop();
  }
});

it("retains the original upload outcome and exact document invalidation event in narrow error data", async () => {
  const f = await fixture();
  try {
    const first = await f.sync();
    const result = await f.controller.run(
      {
        id: "upload-diagnostic",
        method: "tool.upload",
        params: { session_id: "owner", tab_id: 7, context_id: first.context_id },
      },
      f.cdp,
      new AbortController().signal,
      async (runner) => {
        await runner.acquireBackgroundExecution!("owner", 7);
        await runner.send(7, "DOM.setFileInputFiles", { backendNodeId: 1, files: [] });
        f.event("DOM.documentUpdated");
        return { code: "cdp_failed", message: "original handler failure" };
      },
    );
    expect(result).toMatchObject({
      code: "permission_denied",
      data: {
        effect_state: "unknown",
        compat_diagnostic: {
          request: "upload-diagnostic",
          tab: 7,
          last_method: "DOM.setFileInputFiles",
          invalidation: { event: "DOM.documentUpdated" },
          handler: { code: "cdp_failed" },
          final: { code: "permission_denied", effect_state: "unknown" },
          cleanup: "complete",
          initial_frames: [{ frameId: 0, document: "fixture-document", human: 0 }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fixture.test");
    expect(
      f.native.mock.calls.filter(([, method]) => method === "DOM.setFileInputFiles"),
    ).toHaveLength(1);
  } finally {
    f.dispatcher.stop();
  }
});

it("prepares a targeted action and restore with real CDP reads outside the toggle queue", async () => {
  const f = await fixture("target");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("targeted action deadlocked")), 500);
  f.native.mockImplementation(async (_target, method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelectorAll") return { nodeIds: [2] };
    if (method === "DOM.querySelector") return { nodeId: 2 };
    if (method === "DOM.describeNode") return { node: { backendNodeId: 2 } };
    if (method === "DOM.resolveNode") return { object: { objectId: "target" } };
    if (method === "Runtime.callFunctionOn")
      return {
        result: {
          value: {
            connected: true,
            visible: true,
            disabled: false,
            readOnly: false,
            focused: true,
          },
        },
      };
    return {};
  });
  try {
    const context = await f.sync();
    const result = await f.controller.run(
      {
        id: "targeted",
        method: "tool.click",
        params: {
          session_id: "owner",
          tab_id: 7,
          context_id: context.context_id,
          selector: "#target",
        },
      },
      f.cdp,
      abort.signal,
      async (runner) => {
        await runner.acquireBackgroundExecution!("owner", 7);
        await runner.restoreBackgroundExecution!("owner", 7);
        await runner.send(7, "Runtime.evaluate", { expression: "7" });
        return { clicked: true };
      },
    );
    expect(result).toMatchObject({ clicked: true });
    expect(
      f.native.mock.calls.filter(([, method]) => method === "DOM.resolveNode").length,
    ).toBeGreaterThan(2);
    expect(
      f.native.mock.calls
        .filter(([, method]) => method === "Emulation.setFocusEmulationEnabled")
        .map(([, , params]) => params),
    ).toEqual([{ enabled: true }, { enabled: true }, { enabled: false }]);
  } finally {
    clearTimeout(timer);
    f.dispatcher.stop();
  }
});

it("lets a video owner enable natively after joining a request's pending disable", async () => {
  const f = await fixture();
  const gate = deferred();
  f.native.mockImplementation(async (_target, method, params) => {
    if (method === "Runtime.evaluate") return { result: { type: "number", value: 7 } };
    if (
      method === "Emulation.setFocusEmulationEnabled" &&
      !(params as { enabled: boolean }).enabled
    )
      await gate.promise;
    return {};
  });
  try {
    const action = f.act();
    await vi.waitFor(() =>
      expect(
        f.native.mock.calls.some(
          ([, method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" &&
            !(params as { enabled: boolean }).enabled,
        ),
      ).toBe(true),
    );
    const video = f.cdp.acquireBackgroundExecution("video", 7);
    gate.resolve();
    await video;
    await action;
    expect(
      f.native.mock.calls
        .filter(([, method]) => method === "Emulation.setFocusEmulationEnabled")
        .map(([, , params]) => params),
    ).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }]);
    expect(f.cdp.ownsBackgroundExecution("video", 7)).toBe(true);
  } finally {
    gate.resolve();
    await f.cdp.detachSession("video");
    f.dispatcher.stop();
  }
});

it.each([
  true,
  false,
])("confirms a queued video owner's native enable after a rejected %s toggle", async (failedEnable) => {
  const f = await fixture();
  const gate = deferred();
  let failed = false;
  let actualEnabled = false;
  f.native.mockImplementation(async (_target, method, params) => {
    if (method === "Runtime.evaluate") return { result: { type: "number", value: 7 } };
    if (method === "Emulation.setFocusEmulationEnabled") {
      const enabled = (params as { enabled: boolean }).enabled;
      if (enabled === failedEnable && !failed) {
        failed = true;
        actualEnabled = false;
        await gate.promise;
        throw new Error("native focus acknowledgement lost");
      }
      actualEnabled = enabled;
    }
    return {};
  });
  try {
    const action = f.act();
    await vi.waitFor(() => expect(failed).toBe(true));
    const video = f.cdp.acquireBackgroundExecution("video", 7);
    gate.resolve();
    await video;
    await action;
    expect(actualEnabled).toBe(true);
    expect(
      f.native.mock.calls.filter(
        ([, method, params]) =>
          method === "Emulation.setFocusEmulationEnabled" &&
          (params as { enabled: boolean }).enabled,
      ),
    ).toHaveLength(2);
    expect(f.native.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(
      failedEnable ? 0 : 1,
    );
  } finally {
    gate.resolve();
    await f.cdp.detachSession("video");
    f.dispatcher.stop();
  }
});

it("never lets a passive raw read re-enable an unconfirmed scoped owner", async () => {
  const f = await fixture();
  const gate = deferred();
  let failed = false;
  f.native.mockImplementation(async (_target, method, params) => {
    if (
      method === "Emulation.setFocusEmulationEnabled" &&
      (params as { enabled: boolean }).enabled
    ) {
      if (!failed) {
        failed = true;
        await gate.promise;
        throw new Error("native focus acknowledgement lost");
      }
    }
    return {};
  });
  try {
    const action = f.act();
    await vi.waitFor(() => expect(failed).toBe(true));
    const read = f.cdp.ensureAttached(7);
    gate.resolve();
    await read;
    await action;
    expect(
      f.native.mock.calls.filter(
        ([, method, params]) =>
          method === "Emulation.setFocusEmulationEnabled" &&
          (params as { enabled: boolean }).enabled,
      ),
    ).toHaveLength(1);
    expect(f.native.mock.calls.filter(([, method]) => method === "Runtime.evaluate")).toHaveLength(
      0,
    );
  } finally {
    gate.resolve();
    f.dispatcher.stop();
  }
});
