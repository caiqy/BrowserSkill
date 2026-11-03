// Opt-in smoke: node scripts/test-enhancement-live.mjs <candidate.tgz> <results-dir> <chrome-id> <edge-id> [chrome|edge] [features|all] <extension-proof.json>
// Browser actions use only the packed plugin's six public tools and its real shared runner.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_PLUGIN_SHA256 = "746a44878c2b42635d39fcf2ce443aa459f44d4ac470e773fff339f53483580c";
const EXPECTED_PLUGIN_BYTES = 140958;
const EXPECTED_EXTENSION_VERSION = "0.4.1-dsh.1";
const EXPECTED_MANIFEST_VERSION = "0.4.1.1";
const [archiveArg, resultsArg, chrome, edge, only, featureArg, proofArg] = process.argv.slice(2);
const requestedFeatures = !featureArg || featureArg === "all" ? undefined : featureArg.split(",");
const knownFeatures = ["wait", "control", "evaluate", "evaluateCancel", "evaluateTimeout", "uploadSingle", "uploadMultiple", "uploadDrop", "missingUpload", "download", "screenshot", "html", "emulate", "hover", "drag", "step", "view", "incognito", "dialog", "background"];
assert(!requestedFeatures || requestedFeatures.every((feature) => knownFeatures.includes(feature)), "Unknown feature filter");
assert(archiveArg && resultsArg && chrome && edge && proofArg, "Usage: node scripts/test-enhancement-live.mjs <candidate.tgz> <results-dir> <chrome-id> <edge-id> [chrome|edge] [features|all] <extension-proof.json>");
assert(only === undefined || only === "chrome" || only === "edge", "Optional browser filter must be chrome or edge");
const requestedBrowsers = [["chrome", chrome], ["edge", edge]].filter(([label]) => only === undefined || label === only);
if (requestedBrowsers.some(([label]) => label === "edge")) {
  const uploadModes = (requestedFeatures ?? knownFeatures).filter((feature) => ["uploadSingle", "uploadMultiple", "uploadDrop"].includes(feature));
  assert(uploadModes.length <= 1, "Edge upload modes must run in separate script invocations with a fresh Agent session each");
}
const archive = resolve(archiveArg);
const results = resolve(resultsArg);
const extensionProofPath = resolve(proofArg);
const extensionProof = JSON.parse(await readFile(extensionProofPath, "utf8"));
const archiveBytes = (await stat(archive)).size;
const archiveHash = createHash("sha256").update(await readFile(archive)).digest("hex");
assert.equal(archiveBytes, EXPECTED_PLUGIN_BYTES, "Candidate plugin tgz byte size mismatch");
assert.equal(archiveHash, EXPECTED_PLUGIN_SHA256, "Candidate plugin tgz SHA-256 mismatch");
assert.match(extensionProof.pluginSha256 ?? "", /^[a-f0-9]{64}$/i, "Extension proof pluginSha256 is required");
assert.equal(extensionProof.pluginSha256.toLowerCase(), archiveHash, "Extension proof must bind the exact candidate plugin tgz");
assert.equal(extensionProof.applicationVersion, EXPECTED_EXTENSION_VERSION, "Extension proof application version mismatch");
assert.equal(extensionProof.manifestVersion, EXPECTED_MANIFEST_VERSION, "Extension manifest version mismatch");
assert.match(extensionProof.versionName ?? "", /0\.4\.1-dsh\.1/i, "Extension version_name must identify the candidate");
assert.match(extensionProof.versionName ?? "", /compat/i, "Extension version_name must identify this as a compatibility build");
assert(typeof extensionProof.buildId === "string" && extensionProof.buildId.length > 0, "Extension buildId is required");
assert(typeof extensionProof.sourceRevision === "string" && extensionProof.sourceRevision.length > 0, "Extension sourceRevision is required");
assert(typeof extensionProof.zipPath === "string" && extensionProof.zipPath.length > 0, "Extension ZIP path is required");
assert.match(extensionProof.zipSha256 ?? "", /^[a-f0-9]{64}$/i, "Extension ZIP SHA-256 is required");
const extensionZipPath = resolve(dirname(extensionProofPath), extensionProof.zipPath);
assert((extensionProof.sourceDiffSha256 === undefined) === (extensionProof.dirtyPatchPath === undefined), "sourceDiffSha256 and dirtyPatchPath must be supplied together");
if (extensionProof.sourceDiffSha256 !== undefined) assert.match(extensionProof.sourceDiffSha256, /^[a-f0-9]{64}$/i, "Extension sourceDiffSha256 must be SHA-256");
if (extensionProof.dirtyPatchPath !== undefined) {
  const dirtyPatchPath = resolve(dirname(extensionProofPath), extensionProof.dirtyPatchPath);
  const actualDiffSha256 = createHash("sha256").update(await readFile(dirtyPatchPath)).digest("hex");
  assert.equal(actualDiffSha256, extensionProof.sourceDiffSha256.toLowerCase(), "Extension dirty source diff SHA-256 mismatch");
}
const extensionZipSha256 = createHash("sha256").update(await readFile(extensionZipPath)).digest("hex");
assert.equal(extensionZipSha256, extensionProof.zipSha256.toLowerCase(), "Extension ZIP SHA-256 mismatch");
const manifestPaths = execFileSync("tar", ["-tf", extensionZipPath], { encoding: "utf8", timeout: 15000 }).split(/\r?\n/).filter((path) => /(?:^|\/)manifest\.json$/i.test(path));
assert.equal(manifestPaths.length, 1, "Extension ZIP must contain exactly one manifest.json");
const extensionManifest = JSON.parse(execFileSync("tar", ["-xOf", extensionZipPath, manifestPaths[0]], { encoding: "utf8", timeout: 15000 }));
assert.equal(extensionManifest.version, EXPECTED_MANIFEST_VERSION, "Loaded candidate ZIP manifest version mismatch");
assert.equal(extensionManifest.version_name, extensionProof.versionName, "Extension proof version_name does not match ZIP manifest");
await mkdir(results, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "bsk-candidate-live-"));
const originalCwd = process.cwd();
const disposers = [];
const tools = new Map();
const targetTabBySession = new Map();
const report = { candidate: archive, bytes: archiveBytes, sha256: archiveHash, extensionProof: { path: extensionProofPath, applicationVersion: extensionProof.applicationVersion, manifestVersion: extensionProof.manifestVersion, versionName: extensionProof.versionName, buildId: extensionProof.buildId, sourceRevision: extensionProof.sourceRevision, sourceDiffSha256: extensionProof.sourceDiffSha256, dirtyPatchPath: extensionProof.dirtyPatchPath, zipPath: extensionZipPath, zipSha256: extensionZipSha256 }, startedAt: new Date().toISOString(), calls: [], browsers: [], failures: [], cleanup: [] };
report.fixtureBoundary = "Packed apply and all six public tools use the unmodified real runner/CLI/daemon/extensions. Context registration, image-capable model metadata and the durable local attachment store are host fixtures; no desktop GUI or actual DSH attachment service is claimed.";
report.extensionProofBoundary = "The supplied GE ZIP and manifest are hash-verified; browser metadata verifies the live handshake app version/protocol/skew. Exact loaded-ZIP association requires parent confirmation before run; this script never installs or reloads extensions.";
const downloadContent = "BrowserSkill 下载测试\n";
const fixtureWindowMarker = `bsk-fixture-${randomUUID()}`;
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>BrowserSkill candidate smoke ${fixtureWindowMarker}</title>
<style>body{font:18px sans-serif;margin:24px}input,a,button{display:block;margin:16px}#drop{border:2px dashed;padding:24px;width:300px}.menu button{display:none}.menu:hover button{display:block}.spacer{height:1800px}</style>
<h1>BrowserSkill 本地候选测试 💡</h1><label>Single file<input id="single" type="file"></label><label>Multiple files<input id="multi" type="file" multiple></label>
<div id="drop">Drop test files</div><a id="download" href="/download" download="bsk-smoke.txt">Download test file</a>
<div class="menu" role="button" tabindex="0" aria-haspopup="menu">Hover test menu<button>Hidden action</button></div>
<button id="step-button" onclick="document.querySelector('#step-done').hidden=false">Run step</button><p id="step-done" hidden>Step completed</p>
<button id="dialog-accept" onclick="window.dialogAnswer=prompt('Candidate prompt','default')">Open prompt</button>
<button id="dialog-cancel" onclick="window.cancelAnswer=confirm('Candidate cancel')">Open confirm</button>
<div id="drag-source" draggable="true">Drag source</div><div id="drag-target">Drop target</div><output id="drag-result"></output>
<div class="spacer">Full-page test spacer</div><p id="fixture-end">End of test page</p>
<script>const drop=document.querySelector('#drop');drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();window.dropped=Promise.all([...e.dataTransfer.files].map(async f=>({name:f.name,text:await f.text()})));});
document.querySelector('#drag-target').addEventListener('dragover',e=>e.preventDefault());document.querySelector('#drag-source').addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','source'));document.querySelector('#drag-target').addEventListener('drop',e=>{e.preventDefault();document.querySelector('#drag-result').value=e.dataTransfer.getData('text/plain');});</script></html>`;
const server = createServer((req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="bsk-smoke.txt"' });
    res.end(downloadContent);
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  }
});
let sequence = 0;
const exec = (signal = new AbortController().signal) => ({
  callId: `live-${++sequence}`, name: "candidate-live", signal,
  agent: { id: "bsk-candidate-live", options: { provider: "local-fixture", model: "image-capable" }, session: { requestHeader: () => ({ config: { provider: "local-fixture", model: "image-capable" } }) } },
});
const sanitizeReportValue = (value, key = "") => {
  if (key === "url" || key === "title") return undefined;
  if (typeof value === "string") return value.replace(/https?:\/\/127\.0\.0\.1:\d+(?:\/[^\s"')}]*)?/g, "<fixture-url>");
  if (Array.isArray(value)) return value.map((item) => sanitizeReportValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([field]) => field !== "url" && field !== "title").map(([field, item]) => [field, sanitizeReportValue(item, field)]));
  return value;
};
const errorRecord = (error) => ({
  message: sanitizeReportValue(String(error)),
  code: error?.code,
  data: sanitizeReportValue(error?.data),
  timedOut: error?.timedOut,
});
const foregroundProbeScript = String.raw`
$ErrorActionPreference = 'Stop'
$native = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BskForegroundProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  public static string Read(string marker) {
    IntPtr owned = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      var title = new StringBuilder(512);
      if (GetWindowText(hWnd, title, title.Capacity) > 0 && title.ToString().IndexOf(marker, StringComparison.Ordinal) >= 0) {
        owned = hWnd;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    IntPtr foreground = GetForegroundWindow();
    return string.Format("{0}|{1}", owned != IntPtr.Zero, owned != IntPtr.Zero && foreground == owned);
  }
}
"@
Add-Type -TypeDefinition $native
[BskForegroundProbe]::Read($env:BSK_FIXTURE_WINDOW_MARKER)
`;
const readAgentForeground = (marker) => {
  if (process.platform !== "win32") return { available: false, reason: "Windows-only foreground evidence" };
  try {
    const raw = execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", foregroundProbeScript], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, BSK_FIXTURE_WINDOW_MARKER: marker },
    }).trim();
    const [found, foreground] = raw.split("|");
    assert(["True", "False"].includes(found) && ["True", "False"].includes(foreground));
    return { available: true, agentWindowFound: found === "True", foregroundIsAgentWindow: foreground === "True" };
  } catch {
    return { available: false, reason: "Read-only foreground probe unavailable; no window title or process details recorded" };
  }
};
const findString = (value, keys) => {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found) return found;
  }
};
const assertToolRejection = async (name, args, pattern) => {
  let failure;
  try { await invoke(name, args, exec()); }
  catch (error) { failure = error; }
  assert(failure, `${name} unexpectedly accepted the invalid action`);
  assert.doesNotMatch(String(failure), /unexpected argument|unknown (?:argument|option)|unrecognized option|usage:/i, "rejection must come from the browser action guard, not CLI argument parsing");
  assert.match(String(failure), pattern);
  return failure;
};
const invoke = async (name, args, context) => {
  const started = Date.now();
  try {
    const result = await tools.get(name).execute(args, context);
    report.calls.push({ name, args: sanitizeReportValue(args), elapsedMs: Date.now() - started, ok: true, result: sanitizeReportValue(result) });
    console.log(`PASS ${name} ${args.action} (${Date.now() - started}ms)`);
    return result;
  } catch (error) {
    report.calls.push({ name, args: sanitizeReportValue(args), elapsedMs: Date.now() - started, ok: false, error: errorRecord(error) });
    console.log(`ERROR ${name} ${args.action}: ${sanitizeReportValue(String(error))}`);
    throw error;
  }
};
const call = async (name, args, context = exec()) => {
  const targetTools = ["bsk_page", "bsk_inspect", "bsk_interact", "bsk_assist"];
  const targetTabId = args.session ? targetTabBySession.get(args.session) : undefined;
  const effectiveArgs = targetTools.includes(name) && args.tabId === undefined && targetTabId !== undefined
    ? { ...args, tabId: targetTabId }
    : args;
  const guardedAction = name === "bsk_interact" ||
    (name === "bsk_assist" && ["emulate", "resize"].includes(effectiveArgs.action)) ||
    (name === "bsk_inspect" && ((effectiveArgs.action === "observe" && effectiveArgs.probeHover === true) || (effectiveArgs.action === "screenshot" && effectiveArgs.fullPage === true))) ||
    (name === "bsk_tabs" && ["create", "select", "close", "borrow", "return"].includes(effectiveArgs.action));
  if (!guardedAction || !effectiveArgs.session || effectiveArgs.contextId !== undefined) return invoke(name, effectiveArgs, context);
  const sync = await invoke("bsk_session", { action: "sync", session: effectiveArgs.session, ...(effectiveArgs.tabId !== undefined ? { tabId: effectiveArgs.tabId } : {}), policy: "auto" }, exec());
  assert.equal(sync.control_policy, "target", "sync must acknowledge target policy");
  assert.equal(typeof sync.context_id, "string", "sync must return the control context");
  const observationId = sync.observation_id ?? sync.observation?.observation_id;
  assert.equal(typeof observationId, "string", "sync must return an observation id");
  let targets = effectiveArgs.action === "drag" ? [effectiveArgs.target, effectiveArgs.to].filter(Boolean) : effectiveArgs.target ? [effectiveArgs.target] : [];
  if (effectiveArgs.action === "step") {
    const params = JSON.parse(effectiveArgs.params);
    targets = [params.selector, params.ref].filter(Boolean);
  }
  const guarded = {
    ...effectiveArgs,
    contextId: sync.context_id,
    ...(targets.length ? { expect: targets.map((target) => ({ target, field: "exists", equals: true })) } : { observationId }),
  };
  return invoke(name, guarded, context);
};
const reject = async (name, args, pattern, context) => assert.rejects(() => call(name, args, context), pattern);
const canceledWait = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try { await reject("bsk_page", { action: "wait-ms", durationMs: 10_000 }, /abort|cancel/i, exec(controller.signal)); }
  finally { clearTimeout(timer); }
};
let attachmentSequence = 0;
const attachments = {
  imageLimits: { mediaTypes: ["image/png"], maxImageBytes: 50_000_000, maxMessageImageBytes: 50_000_000 },
  async saveImage({ data, mediaType, name }) {
    const bytes = Buffer.from(data);
    assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a", "real screenshot must contain PNG bytes");
    const attachmentId = `live-${++attachmentSequence}`;
    await writeFile(join(results, `${attachmentId}.png`), bytes, { flag: "wx" });
    return { attachmentId, mediaType, name, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  },
};
try {
  execFileSync("tar", ["-xzf", archive, "-C", scratch]);
  const candidate = join(scratch, "package");
  const sourcePackage = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await symlink(join(sourcePackage, "node_modules"), join(candidate, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  process.chdir(scratch);
  const { apply } = await import(pathToFileURL(join(candidate, "lib/index.mjs")).href);
  report.package = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
  assert.equal(report.package.name, "@caiqy/browser-skill-dsh-plugin");
  assert.equal(report.package.version, "0.4.1-dsh.1");
  apply({
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    get: (name) => name === "attachments" ? attachments : name === "llm" ? { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) } : undefined,
    inject() {}, effect: (factory) => disposers.push(factory()),
  }, { lazyTools: false, observationEnabled: false, sessionStateDirectory: join(scratch, "journal") });
  assert.deepEqual([...tools.keys()].sort(), ["bsk_assist", "bsk_inspect", "bsk_interact", "bsk_page", "bsk_session", "bsk_tabs"]);
  let runtimeBlocked;
  try {
    const cli = execFileSync("bsk", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    const runtime = JSON.parse(execFileSync("bsk", ["--json", "status"], { encoding: "utf8", timeout: 10000 }));
    report.runtime = { cli, daemon_version: runtime.daemon_version, protocol_version: runtime.protocol_version };
    const reasons = [];
    if (!/^bsk 0\.4\.1(?:\s|$)/.test(cli)) reasons.push(`CLI version=${cli}, required bsk 0.4.1`);
    if (runtime.daemon_version !== "0.4.1") reasons.push(`daemon_version=${runtime.daemon_version ?? "missing"}, required 0.4.1`);
    if (runtime.protocol_version !== "1.8") reasons.push(`protocol_version=${runtime.protocol_version ?? "missing"}, required 1.8`);
    if (reasons.length) runtimeBlocked = reasons;
  } catch (error) {
    runtimeBlocked = [`Unable to verify bsk CLI/daemon version without browser actions: ${String(error)}`];
  }
  const connected = await call("bsk_session", { action: "browsers" });
  report.connected = connected;
  assert.equal((await call("bsk_session", { action: "list" })).sessions.length, 0);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  const inputFiles = [join(scratch, "a.txt"), join(scratch, "b.txt")];
  const texts = ["上传甲\n", "upload B\n"];
  await Promise.all(inputFiles.map((file, i) => writeFile(file, texts[i])));
  for (const [label, browser] of requestedBrowsers) {
    let session;
    const run = { label, browser, results: {}, passed: false };
    report.browsers.push(run);
    const browserResults = join(results, label);
    await mkdir(browserResults, { recursive: true });
    if (runtimeBlocked) {
      run.blocked = true;
      run.results.preflight = { blocked: true, reasons: runtimeBlocked };
      report.blocked ??= [];
      report.blocked.push({ browser, reasons: runtimeBlocked });
      continue;
    }
    try {
      const currentBrowsers = await call("bsk_session", { action: "browsers" });
      const entry = currentBrowsers.find((connected) => connected.instance_id === browser);
      if (!entry) {
        run.blocked = true;
        run.results.preflight = { blocked: true, reason: `Required browser ${browser} is unavailable; no substitution is permitted` };
        report.blocked ??= [];
        report.blocked.push({ browser, reason: run.results.preflight.reason, actualBrowsers: currentBrowsers });
        continue;
      }
      run.connection = entry;
      const mismatches = [];
      if (entry.instance_id !== browser) mismatches.push(`instance_id=${entry.instance_id ?? "missing"}, required ${browser}`);
      if (entry.browser_name !== label) mismatches.push(`browser_name=${entry.browser_name ?? "missing"}, required ${label}`);
      if (entry.extension_version !== extensionProof.applicationVersion) mismatches.push(`extension_version=${entry.extension_version ?? "missing"}, required ${extensionProof.applicationVersion}`);
      if (entry.extension_protocol_version !== "1.8") mismatches.push(`extension_protocol_version=${entry.extension_protocol_version ?? "missing"}, required 1.8`);
      if (entry.unresponsive !== false) mismatches.push(`unresponsive=${entry.unresponsive ?? "missing"}, required false`);
      if (entry.version_skew !== false) mismatches.push(`version_skew=${entry.version_skew ?? "missing"}, required false`);
      if (mismatches.length) {
        run.results.preflight = { blocked: true, reasons: mismatches };
        run.blocked = true;
        report.blocked ??= [];
        report.blocked.push({ browser, reasons: mismatches, actual: entry });
        continue;
      }
      const args = { action: "start", browser, name: `bsk-candidate-${label}`, url, width: 1000, height: 800, noFocus: true };
      const start = await call("bsk_session", args);
      session = start.sessionId;
      run.session = session;
      run.nameRequested = args.name;
      run.startNoFocus = true;
      assert.equal(start.browserInstanceId, browser);
      assert.match(tools.get("bsk_session").presentCall(args).title, /bsk-candidate-/);
      const initialTabs = await call("bsk_tabs", { action: "list", session, scope: "agent" });
      assert(initialTabs.tabs.length > 0 && initialTabs.tabs.every((tab) => tab.scope === "agent"));
      const targetTabId = initialTabs.tabs[0].tabId;
      targetTabBySession.set(session, targetTabId);
      const sibling = await call("bsk_tabs", { action: "create", session, url: `${url}?sibling=${randomUUID()}`, active: true });
      const tabs = await call("bsk_tabs", { action: "list", session, scope: "agent" });
      const targetTab = tabs.tabs.find((tab) => tab.tabId === targetTabId);
      const siblingTab = tabs.tabs.find((tab) => tab.tabId === sibling.tabId);
      assert(targetTab && siblingTab, "both fixture tabs must remain inside the owned Agent Window");
      assert.equal(targetTab.scope, "agent");
      assert.equal(siblingTab.scope, "agent");
      assert.equal(targetTab.active, false, "the tested fixture tab must be non-active");
      assert.equal(siblingTab.active, true, "the owned sibling fixture tab must be active");
      assert.equal(targetTab.windowId, siblingTab.windowId, "fixture and sibling must share the owned Agent Window");
      run.targetTabId = targetTabId;
      run.siblingTabId = sibling.tabId;
      run.agentWindowId = targetTab.windowId;
      const baselinePath = join(browserResults, "baseline.json");
      const baseline = await invoke("bsk_session", { action: "sync", session, tabId: targetTabId, policy: "auto", saveFull: baselinePath }, exec());
      assert.equal(typeof baseline.context_id, "string");
      assert.equal(typeof (baseline.observation_id ?? baseline.observation?.observation_id), "string");
      const observed = await call("bsk_inspect", { action: "observe", session });
      assert.match(observed.text, /BrowserSkill/);
      const evaluate = (expression, options = {}) => call("bsk_interact", { action: "evaluate", session, ...options, expression });
      const readUploadFixture = async (feature) => {
        const expected = feature === "uploadSingle"
          ? [{ name: "a.txt", text: texts[0] }]
          : texts.map((text, index) => ({ name: index === 0 ? "a.txt" : "b.txt", text }));
        const selector = feature === "uploadSingle" ? "#single" : feature === "uploadMultiple" ? "#multi" : undefined;
        const expression = selector
          ? `Promise.all([...document.querySelector('${selector}').files].map(async f=>({name:f.name,text:await f.text()})))`
          : "window.dropped";
        try {
          const syncArgs = { action: "sync", session, tabId: targetTabId, policy: "auto" };
          const syncStartedAt = Date.now();
          let sync;
          try {
            sync = await tools.get("bsk_session").execute(syncArgs, exec());
            const observationId = sync.observation_id ?? sync.observation?.observation_id;
            report.calls.push({ name: "bsk_session", args: syncArgs, elapsedMs: Date.now() - syncStartedAt, ok: true, result: { control_policy: sync.control_policy, contextIdPresent: typeof sync.context_id === "string", observationIdPresent: typeof observationId === "string" } });
          } catch (error) {
            report.calls.push({ name: "bsk_session", args: syncArgs, elapsedMs: Date.now() - syncStartedAt, ok: false, error: errorRecord(error) });
            return { status: "readbackBlocked", reason: "Fresh sync failed; no readback or upload replay attempted", error: errorRecord(error) };
          }
          const observationId = sync.observation_id ?? sync.observation?.observation_id;
          if (sync.control_policy !== "target" || typeof sync.context_id !== "string" || typeof observationId !== "string") {
            return { status: "readbackBlocked", reason: "Fresh sync did not return current target control/evidence tokens" };
          }
          const args = { action: "evaluate", session, tabId: targetTabId, contextId: sync.context_id, observationId, expression, awaitPromise: true, returnByValue: true };
          const safeArgs = { action: "evaluate", session, tabId: targetTabId, contextIdPresent: true, observationIdPresent: true, expression: "<fixture file readback>", awaitPromise: true, returnByValue: true };
          const startedAt = Date.now();
          try {
            const result = await tools.get("bsk_interact").execute(args, exec());
            if (result.ok === false) {
              report.calls.push({ name: "bsk_interact", args: safeArgs, elapsedMs: Date.now() - startedAt, ok: false, result: { ok: false, error: sanitizeReportValue(result.error) } });
              return { status: "readbackBlocked", reason: "Evaluate returned the official ok:false error result", error: sanitizeReportValue(result.error) };
            }
            const actual = Array.isArray(result.value) ? result.value : [];
            const names = actual.map((entry) => typeof entry?.name === "string" ? entry.name : "<missing>");
            const contentsMatch = actual.length === expected.length && actual.every((entry, index) => entry?.name === expected[index].name && entry?.text === expected[index].text);
            report.calls.push({ name: "bsk_interact", args: safeArgs, elapsedMs: Date.now() - startedAt, ok: result.ok !== false, result: { ok: result.ok, names, contentsMatch } });
            return { status: contentsMatch ? "verified" : "mismatch", names, contentsMatch };
          } catch (error) {
            report.calls.push({ name: "bsk_interact", args: { action: "evaluate", session, tabId: targetTabId, expression: "<fixture file readback>" }, elapsedMs: Date.now() - startedAt, ok: false, error: errorRecord(error) });
            return { status: "readbackBlocked", reason: "Read-only fixture readback failed after fresh sync", error: errorRecord(error) };
          }
        } catch (error) {
          return { status: "readbackBlocked", reason: "Fresh sync failed; no readback or upload replay attempted", error: errorRecord(error) };
        }
      };
      const collectBackgroundEvidence = async () => {
        const currentTabs = await call("bsk_tabs", { action: "list", session, scope: "agent" });
        const target = currentTabs.tabs.find((tab) => tab.tabId === targetTabId);
        const activeSibling = currentTabs.tabs.find((tab) => tab.tabId === sibling.tabId);
        const pageState = (await evaluate("({hidden:document.hidden,visibilityState:document.visibilityState,hasFocus:document.hasFocus()})")).value;
        return {
          targetTab: target ? { tabId: target.tabId, windowId: target.windowId, scope: target.scope, active: target.active } : null,
          siblingTab: activeSibling ? { tabId: activeSibling.tabId, windowId: activeSibling.windowId, scope: activeSibling.scope, active: activeSibling.active } : null,
          sameAgentWindow: Boolean(target && activeSibling && target.windowId === activeSibling.windowId),
          pageState,
          foreground: readAgentForeground(fixtureWindowMarker),
        };
      };
      const isBackgroundProof = (proof) => proof.targetTab?.scope === "agent" && proof.targetTab.active === false && proof.siblingTab?.scope === "agent" && proof.siblingTab.active === true && proof.sameAgentWindow && proof.foreground?.available === true && proof.foreground.agentWindowFound === true && proof.foreground.foregroundIsAgentWindow === false;
      let backgroundBlockedReason;
      const verifyStillBackground = async (phase) => {
        const proof = await collectBackgroundEvidence();
        run.backgroundEvidence[phase] = proof;
        if (!isBackgroundProof(proof)) {
          backgroundBlockedReason = `Background ownership proof failed at ${phase}; no focus/help retry was attempted`;
          throw Object.assign(new Error(backgroundBlockedReason), { blocked: true, data: proof });
        }
        return proof;
      };
      try {
        run.backgroundEvidence = { beforeActions: await collectBackgroundEvidence() };
        if (!isBackgroundProof(run.backgroundEvidence.beforeActions)) backgroundBlockedReason = "Could not prove the owned Agent Window is non-foreground with a non-active target tab";
      } catch (error) {
        run.backgroundEvidence = { beforeActionsError: errorRecord(error), foreground: readAgentForeground(fixtureWindowMarker) };
        backgroundBlockedReason = "Background target probe failed before page tests; no focus or retry was attempted";
      }
      if (backgroundBlockedReason) {
        run.blocked = true;
        run.results.background = { blocked: true, reason: backgroundBlockedReason, evidence: run.backgroundEvidence };
        report.blocked ??= [];
        report.blocked.push({ browser, feature: "background", reason: backgroundBlockedReason, evidence: run.backgroundEvidence });
      }
      let uncertainAction;
      const check = async (feature, action) => {
        if (requestedFeatures && !requestedFeatures.includes(feature)) return;
        if (backgroundBlockedReason) {
          run.results[feature] = { blocked: true, reason: backgroundBlockedReason };
          return;
        }
        if (uncertainAction) {
          run.results[feature] = { blocked: true, reason: `Skipped after ${uncertainAction.feature} returned effect_state=unknown` };
          return;
        }
        try { run.results[feature] = { passed: true, value: await action() }; }
        catch (error) {
          if (error.blocked === true) {
            run.results[feature] = { blocked: true, error: errorRecord(error) };
            run.blocked = true;
            report.blocked ??= [];
            report.blocked.push({ browser, feature, error: errorRecord(error) });
          } else {
            const failure = errorRecord(error);
            const effectUnknown = failure.data?.effect_state === "unknown";
            const uploadFeature = ["uploadSingle", "uploadMultiple", "uploadDrop"].includes(feature);
            if (effectUnknown && uploadFeature) {
              failure.readback = await readUploadFixture(feature);
              failure.compatDiagnostic = sanitizeReportValue(error.data?.compat_diagnostic ?? error.data?.compatDiagnostic ?? null);
            }
            run.results[feature] = { passed: false, error: failure };
            report.failures.push({ browser, feature, error: failure, stack: sanitizeReportValue(error.stack) });
            if (effectUnknown) {
              uncertainAction = { feature, error: failure };
              run.blocked = true;
              report.blocked ??= [];
              report.blocked.push({ browser, feature, reason: "effect_state=unknown; only fresh-sync readback was attempted and subsequent actions are skipped", compatDiagnostic: failure.compatDiagnostic ?? null, readback: failure.readback ?? null, error: failure });
            }
          }
        }
      };
      const withIsolatedEvaluation = async (suffix, action) => {
        let isolatedSession;
        try {
          const isolatedStart = await call("bsk_session", { action: "start", browser, name: `bsk-eval-${suffix}-${label}`, url, noFocus: true, width: 900, height: 700 });
          isolatedSession = isolatedStart.sessionId;
          assert.equal(isolatedStart.browserInstanceId, browser);
          const isolatedTabs = await call("bsk_tabs", { action: "list", session: isolatedSession, scope: "agent" });
          assert(isolatedTabs.tabs.length > 0 && isolatedTabs.tabs.every((tab) => tab.scope === "agent"));
          const isolatedTabId = isolatedTabs.tabs[0].tabId;
          targetTabBySession.set(isolatedSession, isolatedTabId);
          const isolatedObserved = await call("bsk_inspect", { action: "observe", session: isolatedSession });
          assert.match(isolatedObserved.text, /BrowserSkill/);
          const sync = await invoke("bsk_session", { action: "sync", session: isolatedSession, tabId: isolatedTabId, policy: "auto" }, exec());
          assert.equal(sync.control_policy, "target");
          assert.equal(typeof sync.context_id, "string");
          assert.equal(typeof (sync.observation_id ?? sync.observation?.observation_id), "string");
          return await action(isolatedSession);
        } finally {
          if (isolatedSession) {
            await call("bsk_session", { action: "stop", session: isolatedSession }).catch((error) => report.failures.push({ browser, feature: `${suffix}-cleanup`, error: errorRecord(error) }));
            targetTabBySession.delete(isolatedSession);
          }
        }
      };
      await check("control", async () => {
        const sync = await invoke("bsk_session", { action: "sync", session, tabId: targetTabId, policy: "auto" }, exec());
        const guarded = { action: "click", session, tabId: targetTabId, target: "#step-button", contextId: sync.context_id, observationId: sync.observation_id ?? sync.observation?.observation_id };
        await assertToolRejection("bsk_interact", { ...guarded, expect: [{ target: "#step-button", field: "text", equals: "not the button label" }] }, /expect|condition|changed|guard/i);
        await assertToolRejection("bsk_interact", { ...guarded, contextId: "stale-context-from-fixture", expect: [{ target: "#step-button", field: "exists", equals: true }] }, /context|sync|control|stale/i);
        await assertToolRejection("bsk_interact", { ...guarded, target: "--literal-target", expect: [{ target: "--literal-target", field: "exists", equals: true }] }, /expect|condition|not found|not exist|target/i);
        const stillThere = await evaluate("document.querySelector('#step-done').hidden");
        assert.equal(stillThere.value, true, "guard refusals must happen before the click dispatch");
        return { policy: sync.control_policy, contextIdIssued: true, expectRejected: true, staleContextRejected: true };
      });
      await check("wait", async () => {
        await call("bsk_page", { action: "wait-ms", durationMs: 0 });
        await call("bsk_page", { action: "wait-ms", durationMs: 20 });
        await reject("bsk_page", { action: "wait-ms", durationMs: -1 }, /durationMs/);
        await reject("bsk_page", { action: "wait-ms", durationMs: 300001 }, /durationMs/);
        await canceledWait();
        return { min: 0, max: 300000, cancellation: "aborted" };
      });
      await check("evaluate", async () => {
        assert.equal((await evaluate("-1")).value, -1);
        assert.equal((await evaluate("Promise.resolve(42)")).value, 42);
        const flags = await evaluate("Promise.resolve(7)", { awaitPromise: false, returnByValue: false });
        assert.equal(flags.value.className, "Promise");
        assert.equal(typeof flags.value.objectId, "string", "explicit false returns the official CDP remote-object descriptor");
        const pageError = await evaluate("(()=>{throw new Error('candidate-smoke-error')})()");
        assert.equal(pageError.ok, false);
        assert.match(JSON.stringify(pageError.error), /candidate-smoke-error/);
        if (pageError.dialogs !== undefined) assert.ok(Array.isArray(pageError.dialogs));
        return flags;
      });
      await check("evaluateCancel", () => withIsolatedEvaluation("cancel", async (isolatedSession) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 400);
        try {
          await reject("bsk_interact", { action: "evaluate", session: isolatedSession, expression: "new Promise(resolve=>setTimeout(()=>resolve(1),10000))" }, /abort|cancel/i, exec(controller.signal));
          return { aborted: true };
        } finally { clearTimeout(timer); }
      }));
      await check("evaluateTimeout", () => withIsolatedEvaluation("timeout", async (isolatedSession) => {
        let result;
        try { result = await call("bsk_interact", { action: "evaluate", session: isolatedSession, expression: "new Promise(()=>{})", timeoutMs: 150 }); }
        catch (error) { result = errorRecord(error); }
        assert(result.ok === false || result.code === "timeout" || result.timedOut === true, "evaluate timeout must report the official structured timeout/failure result");
        return result;
      }));
      await check("uploadSingle", async () => {
        await call("bsk_interact", { action: "upload", session, target: "#single", files: [inputFiles[0]] });
        await verifyStillBackground("after-uploadSingle");
        const readback = await readUploadFixture("uploadSingle");
        assert.equal(readback.status, "verified");
        return readback;
      });
      await check("uploadMultiple", async () => {
        await call("bsk_interact", { action: "upload", session, target: "#multi", files: inputFiles, mode: "input" });
        await verifyStillBackground("after-uploadMultiple");
        const readback = await readUploadFixture("uploadMultiple");
        assert.equal(readback.status, "verified");
        return readback;
      });
      await check("uploadDrop", async () => {
        await call("bsk_interact", { action: "upload", session, target: "#drop", files: inputFiles, mode: "drop" });
        await verifyStillBackground("after-uploadDrop");
        const readback = await readUploadFixture("uploadDrop");
        assert.equal(readback.status, "verified");
        return readback;
      });
      await check("missingUpload", () => reject("bsk_interact", { action: "upload", session, target: "#single", files: [join(scratch, "missing.txt")] }, /file|read|found/i));
      await check("download", async () => {
        const download = join(browserResults, "download.txt");
        await call("bsk_interact", { action: "download", session, target: "#download", output: download });
        assert.equal(await readFile(download, "utf8"), downloadContent);
        await writeFile(download, "do not replace");
        await reject("bsk_interact", { action: "download", session, target: "#download", output: download }, /exist|overwrite/i);
        assert.equal(await readFile(download, "utf8"), "do not replace");
        await call("bsk_interact", { action: "download", session, target: "#download", output: download, overwrite: true });
        assert.equal(await readFile(download, "utf8"), downloadContent);
      });
      await check("screenshot", async () => {
        const screenshot = join(browserResults, "full.png");
        const followPath = join(browserResults, "follow.png");
        const shotArgs = { action: "screenshot", session, tabId: targetTabId, fullPage: true, scope: "current", output: screenshot, timeoutMs: 30_000 };
        run.screenshotDiagnostic = {};
        await verifyStillBackground("beforeCurrentCapture");
        const shot = await call("bsk_inspect", shotArgs);
        assert(shot.height > 1500 && shot.width > 0 && shot.byteSize > 0);
        assert(shot.image, "current screenshot must return a durable fixture attachment");
        assert(tools.get("bsk_inspect").output.render(shotArgs, shot).some((block) => block.type === "image"));
        const screenshotHash = createHash("sha256").update(await readFile(screenshot)).digest("hex");
        await reject("bsk_inspect", shotArgs, /exist/i);
        assert.equal(createHash("sha256").update(await readFile(screenshot)).digest("hex"), screenshotHash);
        run.screenshotDiagnostic.afterCurrent = await verifyStillBackground("afterCurrentCapture");
        const followArgs = { action: "screenshot", session, tabId: targetTabId, fullPage: true, scope: "follow", output: followPath, timeoutMs: 30_000 };
        const follow = await call("bsk_inspect", followArgs);
        assert(follow.height > 1500 && follow.width > 0 && follow.byteSize > 0);
        assert(follow.image, "follow screenshot must return a durable fixture attachment");
        assert(tools.get("bsk_inspect").output.render(followArgs, follow).some((block) => block.type === "image"));
        run.screenshotDiagnostic.afterFollow = await verifyStillBackground("afterFollowCapture");
        assert((await stat(followPath)).size > 0);
        return {
          current: { path: screenshot, width: shot.width, height: shot.height, byteSize: shot.byteSize, attachment: shot.image },
          follow: { path: followPath, width: follow.width, height: follow.height, byteSize: follow.byteSize, attachment: follow.image },
          background: run.screenshotDiagnostic,
        };
      });
      await check("html", async () => {
        const html = await call("bsk_inspect", { action: "html", session });
        assert.match(html.html, /本地候选测试 💡/);
        const htmlPath = join(browserResults, "page.html");
        const exported = await call("bsk_inspect", { action: "html", session, output: htmlPath });
        const written = await readFile(htmlPath, "utf8");
        assert.equal(exported.html, undefined);
        assert.equal(exported.writtenBytes, Buffer.byteLength(written, "utf8"));
        assert.equal(exported.writtenBytes, (await stat(htmlPath)).size);
        assert(exported.byteSize >= exported.writtenBytes);
        assert.match(written, /本地候选测试 💡/);
        const truncatedPath = join(browserResults, "page-truncated.html");
        const truncated = await call("bsk_inspect", { action: "html", session, output: truncatedPath, maxBytes: 1024 });
        assert.equal(truncated.truncated, true);
        assert(truncated.byteSize > truncated.writtenBytes);
        assert.equal(truncated.writtenBytes, (await stat(truncatedPath)).size);
        await reject("bsk_inspect", { action: "html", session, output: htmlPath }, /exist/i);
        return { ...exported, truncated: { ...truncated, path: truncatedPath } };
      });
      await check("emulate", async () => {
        const tabId = targetTabId;
        const baselineTouch = (await evaluate("navigator.maxTouchPoints")).value;
        assert(Number.isInteger(baselineTouch) && baselineTouch >= 0);
        try {
          const params = { action: "emulate", session, tabId, device: "iphone-14", width: 430, height: 932, mobile: false, dpr: 2, ua: "BrowserSkillSmoke/1.0", acceptLanguage: "en-US", maxTouchPoints: 5 };
          const applied = await call("bsk_assist", { ...params, touch: true });
          const emulated = (await evaluate("({ua:navigator.userAgent,dpr:devicePixelRatio,touch:navigator.maxTouchPoints,language:navigator.language,width:innerWidth,height:innerHeight})")).value;
          assert.equal(applied.tabId, tabId);
          assert.equal(emulated.ua, "BrowserSkillSmoke/1.0");
          assert.equal(emulated.dpr, 2);
          assert.equal(emulated.touch, 5);
          assert.equal(emulated.language, "en-US");
          assert.equal(emulated.width, 430);
          assert.equal(emulated.height, 932);
          const disabled = await call("bsk_assist", { ...params, touch: false });
          const afterDisabled = (await evaluate("navigator.maxTouchPoints")).value;
          assert.equal(afterDisabled, baselineTouch, "touch:false must restore the device's native maxTouchPoints");
          await reject("bsk_assist", { action: "emulate", session, off: true, touch: false }, /mutually exclusive/);
          const cleared = await call("bsk_assist", { action: "emulate", session, tabId, off: true });
          assert.equal(cleared.cleared, true);
          const afterOff = (await evaluate("navigator.maxTouchPoints")).value;
          assert.equal(afterOff, baselineTouch, "off must restore the device's native maxTouchPoints");
          return { baselineTouch, applied, emulated, disabled, afterDisabled, cleared, afterOff };
        } finally { await call("bsk_assist", { action: "emulate", session, tabId, off: true }); }
      });
      await check("hover", async () => {
        const hoverArgs = { action: "observe", session, probeHover: true, debugSurfaces: true };
        const hovered = await call("bsk_inspect", hoverArgs);
        assert(hovered.hoverProbe && hovered.debug, "official hover/debug diagnostics must survive candidate output mapping");
        assert.match(tools.get("bsk_inspect").output.render(hoverArgs, hovered)[0].text, /hoverProbe=/);
        return { hoverProbe: hovered.hoverProbe, debug: hovered.debug };
      });
      await check("drag", async () => {
        const result = await call("bsk_interact", { action: "drag", session, target: "#drag-source", to: "#drag-target", durationMs: 250 });
        const dropped = await evaluate("document.querySelector('#drag-result').value");
        assert.equal(dropped.value, "source");
        return { result, dropped: dropped.value };
      });
      await check("step", async () => {
        const saved = join(browserResults, "step.json");
        const result = await call("bsk_interact", { action: "step", session, stepAction: "click", params: JSON.stringify({ selector: "#step-button" }), untilVisible: "#step-done", saveFull: saved, waitTimeoutMs: 4000 });
        assert.equal(result.ok, true);
        assert.equal(result.action_replayed, false);
        assert.equal(result.readiness.satisfied, true);
        assert.equal(typeof result.post.context_id, "string");
        assert.equal((await stat(saved)).size > 0, true);
        return result;
      });
      await check("view", async () => {
        const viewed = await call("bsk_inspect", { action: "view", file: baselinePath, find: "BrowserSkill" });
        assert.match(JSON.stringify(viewed), /BrowserSkill/);
        await reject("bsk_inspect", { action: "view", file: baselinePath, contextId: baseline.context_id }, /historical|does not accept|unknown/i);
        return viewed;
      });
      if (backgroundBlockedReason && (!requestedFeatures || requestedFeatures.includes("incognito"))) {
        run.results.incognito = { blocked: true, reason: backgroundBlockedReason };
      } else if (uncertainAction && (!requestedFeatures || requestedFeatures.includes("incognito"))) {
        run.results.incognito = { blocked: true, reason: `Skipped after ${uncertainAction.feature} returned effect_state=unknown` };
      } else if (!requestedFeatures || requestedFeatures.includes("incognito")) {
        let privateSession;
        let privateTabsSummary = [];
        try {
          const started = await call("bsk_session", { action: "start", browser, name: `bsk-incognito-${label}`, incognito: true, url, noFocus: true, width: 900, height: 700 });
          privateSession = started.sessionId;
          assert.equal(started.browserInstanceId, browser);
          const privateTabs = await call("bsk_tabs", { action: "list", session: privateSession, scope: "agent" });
          privateTabsSummary = privateTabs.tabs.map(({ tabId, windowId, scope, active }) => ({ tabId, windowId, scope, active }));
          assert(privateTabs.tabs.length > 0);
          assert(privateTabs.tabs.every((tab) => tab.scope === "agent"));
          const privateTabId = privateTabs.tabs[0].tabId;
          targetTabBySession.set(privateSession, privateTabId);
          const privateObserved = await call("bsk_inspect", { action: "observe", session: privateSession });
          assert.match(privateObserved.text, /BrowserSkill/);
          const privateSync = await invoke("bsk_session", { action: "sync", session: privateSession, tabId: privateTabId, policy: "auto" }, exec());
          assert.equal(privateSync.control_policy, "target");
          assert.equal(typeof privateSync.context_id, "string");
          assert.equal(typeof (privateSync.observation_id ?? privateSync.observation?.observation_id), "string");
          const regularTabIds = new Set(tabs.tabs.map((tab) => tab.tabId));
          assert(privateTabs.tabs.every((tab) => !regularTabIds.has(tab.tabId)), "incognito agent tabs must be separate from the regular session");
          await reject("bsk_tabs", { action: "borrow", session: privateSession, tabId: targetTabId }, /incognito|borrow/i);
          run.results.incognito = { passed: true, value: { session: privateSession, tabs: privateTabsSummary, borrowedUserTab: false } };
        } catch (error) {
          const message = String(error);
          const permissionBlocked = error.code === "permission_denied" && /incognito|allow in incognito|extension permission/i.test(message);
          const explicitIncognitoDisabled = /Incognito access is disabled\. Open chrome:\/\/extensions/i.test(message);
          if (permissionBlocked || explicitIncognitoDisabled) {
            const boundary = explicitIncognitoDisabled
              ? "The browser explicitly reports Allow in incognito is disabled; user action is required and the script does not change browser settings."
              : "The browser explicitly denied incognito access; the script does not change browser settings.";
            run.results.incognito = { blocked: true, session: privateSession, browser, tabs: privateTabsSummary, error: errorRecord(error) };
            run.blocked = true;
            report.blocked ??= [];
            report.blocked.push({ browser, feature: "incognito", error: errorRecord(error), boundary });
          } else {
            run.results.incognito = { passed: false, error: errorRecord(error) };
            report.failures.push({ browser, feature: "incognito", error: errorRecord(error) });
          }
        } finally {
          if (privateSession) {
            await call("bsk_session", { action: "stop", session: privateSession }).catch((error) => report.failures.push({ browser, feature: "incognito-cleanup", error: errorRecord(error) }));
            targetTabBySession.delete(privateSession);
          }
        }
      }
      await check("dialog", async () => {
        const dispatchPending = async (target) => {
          try {
            await call("bsk_interact", { action: "click", session, target });
            assert.fail("native dialog trigger should return dialog_pending");
          } catch (error) {
            assert.equal(error.code, "dialog_pending");
            const data = error.data;
            const dialogId = findString(data, ["id", "dialog_id"]);
            const operationId = findString(data, ["operation_id", "operationId"]);
            assert(dialogId && operationId, "dialog_pending must identify its dialog and original operation");
            return { data, dialogId, operationId };
          }
        };
        const first = await dispatchPending("#dialog-accept");
        const status = await invoke("bsk_assist", { action: "dialog-status", session });
        const pendingDialog = status.dialogs?.find((dialog) => dialog.id === first.dialogId);
        assert.equal(pendingDialog?.type, "prompt");
        await invoke("bsk_assist", { action: "dialog-accept", session, dialogId: first.dialogId, text: "accepted" });
        const original = await invoke("bsk_assist", { action: "operation-await", session, operationId: first.operationId, waitMs: 0 });
        assert.equal(original.method, "tool.click");
        const accepted = await evaluate("window.dialogAnswer");
        assert.equal(accepted.value, "accepted");
        const second = await dispatchPending("#dialog-cancel");
        await invoke("bsk_assist", { action: "operation-cancel", session, operationId: second.operationId });
        return { acceptedOperation: original, cancelledOperation: second.operationId };
      });
      await check("background", async () => {
        const finalEvidence = await collectBackgroundEvidence();
        run.backgroundEvidence.afterActions = finalEvidence;
        assert(isBackgroundProof(finalEvidence), "owned Agent Window must remain non-foreground and target tab must remain non-active");
        return { startNoFocus: run.startNoFocus, beforeActions: run.backgroundEvidence.beforeActions, afterActions: finalEvidence };
      });
      run.passed = !run.blocked && Object.values(run.results).every((feature) => feature.passed === true);
    } catch (error) {
      run.error = sanitizeReportValue(String(error));
      report.failures.push({ browser, error: sanitizeReportValue(String(error)), stack: sanitizeReportValue(error.stack) });
    } finally {
      if (session) {
        try {
          await call("bsk_session", { action: "stop", session });
          const owned = await call("bsk_session", { action: "list" });
          assert(!owned.sessions.some((entry) => entry.sessionId === session));
          const screenshotPassed = run.results.screenshot?.passed === true;
          const currentRetained = screenshotPassed && (await stat(join(browserResults, "full.png"))).size > 0;
          const followRetained = screenshotPassed && (await stat(join(browserResults, "follow.png"))).size > 0;
          if (screenshotPassed) assert(currentRetained && followRetained, "current and follow screenshots must survive session stop");
          report.cleanup.push({ browser, session, stopped: true, currentScreenshotRetained: currentRetained, followScreenshotRetained: followRetained });
        } catch (error) { report.cleanup.push({ browser, session, stopped: false, error: sanitizeReportValue(String(error)) }); report.failures.push({ browser, cleanup: errorRecord(error) }); }
        targetTabBySession.delete(session);
      }
    }
  }
} catch (error) {
  report.failures.push({ error: sanitizeReportValue(String(error)), stack: sanitizeReportValue(error.stack) });
} finally {
  try { await Promise.all(disposers.map((dispose) => dispose())); }
  catch (error) { report.failures.push({ disposal: sanitizeReportValue(String(error)) }); }
  if (server.listening) {
    const closed = new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
    server.closeAllConnections();
    await closed;
  }
  process.chdir(originalCwd);
  // scratch is the exact directory returned by mkdtemp above; retained evidence lives separately.
  await rm(scratch, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.requestedBrowsers = requestedBrowsers;
  report.requestedFeatures = requestedFeatures ?? knownFeatures;
  report.passed = report.failures.length === 0 && report.browsers.length === requestedBrowsers.length && report.browsers.every((browser) => browser.passed && (requestedFeatures ?? knownFeatures).every((feature) => browser.results[feature]?.passed));
  const output = join(results, "report.json");
  await writeFile(output, JSON.stringify(sanitizeReportValue(report), null, 2));
  console.log(`${report.passed ? "PASS" : "FAIL"} candidate live smoke: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
