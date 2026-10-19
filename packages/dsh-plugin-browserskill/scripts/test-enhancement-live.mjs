// Opt-in smoke: node scripts/test-enhancement-live.mjs <candidate.tgz> <results-dir> <chrome-id> <edge-id> [chrome|edge] [comma-separated-features]
// Browser actions use only the packed plugin's six public tools and its real shared runner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [archiveArg, resultsArg, chrome, edge, only, featureArg] = process.argv.slice(2);
const requestedFeatures = featureArg?.split(",");
const knownFeatures = ["evaluate", "uploadSingle", "uploadMultiple", "uploadDrop", "missingUpload", "download", "screenshot", "html", "emulate", "hover"];
assert(!requestedFeatures || requestedFeatures.every((feature) => knownFeatures.includes(feature)), "Unknown feature filter");
assert(archiveArg && resultsArg && chrome && edge, "Usage: node scripts/test-enhancement-live.mjs <candidate.tgz> <results-dir> <chrome-id> <edge-id> [chrome|edge] [comma-separated-features]");
assert(only === undefined || only === "chrome" || only === "edge", "Optional browser filter must be chrome or edge");
const requestedBrowsers = [["chrome", chrome], ["edge", edge]].filter(([label]) => only === undefined || label === only);
const archive = resolve(archiveArg);
const results = resolve(resultsArg);
await mkdir(results, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "bsk-candidate-live-"));
const originalCwd = process.cwd();
const disposers = [];
const tools = new Map();
const report = { candidate: archive, sha256: createHash("sha256").update(await readFile(archive)).digest("hex"), startedAt: new Date().toISOString(), calls: [], browsers: [], failures: [], cleanup: [] };
report.fixtureBoundary = "Packed apply and all six public tools use the unmodified real runner/CLI/daemon/extensions. Context registration, image-capable model metadata and the durable local attachment store are host fixtures; no desktop GUI or actual DSH attachment service is claimed.";
const downloadContent = "BrowserSkill 下载测试\n";
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>BrowserSkill candidate smoke</title>
<style>body{font:18px sans-serif;margin:24px}input,a,button{display:block;margin:16px}#drop{border:2px dashed;padding:24px;width:300px}.menu button{display:none}.menu:hover button{display:block}.spacer{height:1800px}</style>
<h1>BrowserSkill 本地候选测试</h1><label>Single file<input id="single" type="file"></label><label>Multiple files<input id="multi" type="file" multiple></label>
<div id="drop">Drop test files</div><a id="download" href="/download" download="bsk-smoke.txt">Download test file</a>
<div class="menu" role="button" tabindex="0" aria-haspopup="menu">Hover test menu<button>Hidden action</button></div><div class="spacer">Full-page test spacer</div><p>End of test page</p>
<script>const drop=document.querySelector('#drop');drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',e=>{e.preventDefault();window.dropped=Promise.all([...e.dataTransfer.files].map(async f=>({name:f.name,text:await f.text()})));});</script></html>`;
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
const call = async (name, args, context = exec()) => {
  const started = Date.now();
  try {
    const result = await tools.get(name).execute(args, context);
    report.calls.push({ name, args, elapsedMs: Date.now() - started, ok: true, result });
    console.log(`PASS ${name} ${args.action} (${Date.now() - started}ms)`);
    return result;
  } catch (error) {
    report.calls.push({ name, args, elapsedMs: Date.now() - started, ok: false, error: String(error) });
    console.log(`ERROR ${name} ${args.action}: ${String(error)}`);
    throw error;
  }
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
  apply({
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    get: (name) => name === "attachments" ? attachments : name === "llm" ? { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) } : undefined,
    inject() {}, effect: (factory) => disposers.push(factory()),
  }, { lazyTools: false, observationEnabled: false, sessionStateDirectory: join(scratch, "journal") });
  assert.deepEqual([...tools.keys()].sort(), ["bsk_assist", "bsk_inspect", "bsk_interact", "bsk_page", "bsk_session", "bsk_tabs"]);
  const connected = await call("bsk_session", { action: "browsers" });
  report.connected = connected;
  assert.equal((await call("bsk_session", { action: "list" })).sessions.length, 0);
  if (!requestedFeatures) {
    await call("bsk_page", { action: "wait-ms", durationMs: 0 });
    await call("bsk_page", { action: "wait-ms", durationMs: 20 });
    await reject("bsk_page", { action: "wait-ms", durationMs: -1 }, /durationMs/);
    await canceledWait();
  }
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
    try {
      const currentBrowsers = await call("bsk_session", { action: "browsers" });
      const entry = currentBrowsers.find((connected) => connected.instance_id === browser);
      assert(entry, `Required browser ${browser} is unavailable; no substitution is permitted`);
      assert(!entry.unresponsive && !entry.version_skew, `Browser ${browser} is unresponsive or has version skew`);
      assert.equal(entry.extension_version, "0.3.3");
      run.connection = entry;
      const args = { action: "start", browser, name: `bsk-candidate-${label}`, url, width: 1000, height: 800 };
      const start = await call("bsk_session", args);
      session = start.sessionId;
      run.session = session;
      run.nameRequested = args.name;
      assert.equal(start.browserInstanceId, browser);
      assert.match(tools.get("bsk_session").presentCall(args).title, /bsk-candidate-/);
      const tabs = await call("bsk_tabs", { action: "list", session });
      assert(tabs.tabs.length > 0);
      const observed = await call("bsk_inspect", { action: "observe", session });
      assert.match(observed.text, /BrowserSkill/);
      const evaluate = (expression, options = {}) => call("bsk_interact", { action: "evaluate", session, expression, ...options });
      const check = async (feature, action) => {
        if (requestedFeatures && !requestedFeatures.includes(feature)) return;
        try { run.results[feature] = { passed: true, value: await action() }; }
        catch (error) {
          run.results[feature] = { passed: false, error: String(error) };
          report.failures.push({ browser, feature, error: String(error), stack: error.stack });
        }
      };
      await check("evaluate", async () => {
        assert.equal((await evaluate("-1")).value, -1);
        assert.equal((await evaluate("Promise.resolve(42)")).value, 42);
        const flags = await evaluate("Promise.resolve(7)", { awaitPromise: false, returnByValue: false });
        assert.equal(flags.value.className, "Promise");
        assert.equal(typeof flags.value.objectId, "string", "explicit false returns the official CDP remote-object descriptor");
        await reject("bsk_interact", { action: "evaluate", session, expression: "(()=>{throw new Error('candidate-smoke-error')})()" }, /candidate-smoke-error/);
        await reject("bsk_interact", { action: "evaluate", session, expression: "new Promise(()=>{})", timeoutMs: 150 }, /timed.?out|timeout|terminated|evaluate failed/i);
        const canceled = new AbortController();
        const cancelTimer = setTimeout(() => canceled.abort(), 400);
        try { await reject("bsk_interact", { action: "evaluate", session, expression: "new Promise(resolve=>setTimeout(()=>resolve(1),10000))" }, /abort|cancel/i, exec(canceled.signal)); }
        finally { clearTimeout(cancelTimer); }
        return flags;
      });
      await check("uploadSingle", async () => {
        await call("bsk_interact", { action: "upload", session, target: "#single", files: [inputFiles[0]] });
        assert.deepEqual((await evaluate("Promise.all([...document.querySelector('#single').files].map(async f=>({name:f.name,text:await f.text()})))")).value, [{ name: "a.txt", text: texts[0] }]);
      });
      await check("uploadMultiple", async () => {
        await call("bsk_interact", { action: "upload", session, target: "#multi", files: inputFiles, mode: "input" });
        assert.deepEqual((await evaluate("Promise.all([...document.querySelector('#multi').files].map(async f=>({name:f.name,text:await f.text()})))")).value, inputFiles.map((_, i) => ({ name: i ? "b.txt" : "a.txt", text: texts[i] })));
      });
      await check("uploadDrop", async () => {
        await call("bsk_interact", { action: "upload", session, target: "#drop", files: inputFiles, mode: "drop" });
        assert.deepEqual((await evaluate("window.dropped")).value, inputFiles.map((_, i) => ({ name: i ? "b.txt" : "a.txt", text: texts[i] })));
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
        const shotArgs = { action: "screenshot", session, fullPage: true, scope: "current", output: screenshot, timeoutMs: 30_000 };
        const shot = await call("bsk_inspect", shotArgs);
        assert(shot.height > 1500 && shot.width > 0 && shot.byteSize > 0);
        assert(shot.image, "candidate screenshot must return a durable fixture attachment");
        assert(tools.get("bsk_inspect").output.render(shotArgs, shot).some((block) => block.type === "image"));
        const screenshotHash = createHash("sha256").update(await readFile(screenshot)).digest("hex");
        await reject("bsk_inspect", shotArgs, /exist/i);
        assert.equal(createHash("sha256").update(await readFile(screenshot)).digest("hex"), screenshotHash);
        await call("bsk_inspect", { action: "screenshot", session, fullPage: true, scope: "follow", output: join(browserResults, "follow.png"), timeoutMs: 30_000 });
        return { path: screenshot, width: shot.width, height: shot.height, attachment: shot.image };
      });
      await check("html", async () => {
        const html = await call("bsk_inspect", { action: "html", session });
        assert.match(html.html, /本地候选测试/);
        const htmlPath = join(browserResults, "page.html");
        const exported = await call("bsk_inspect", { action: "html", session, output: htmlPath });
        assert.equal(exported.html, undefined);
        assert.equal(exported.writtenBytes, (await stat(htmlPath)).size);
        assert.match(await readFile(htmlPath, "utf8"), /本地候选测试/);
        await reject("bsk_inspect", { action: "html", session, output: htmlPath }, /exist/i);
        return exported;
      });
      await check("emulate", async () => {
        try {
          await call("bsk_assist", { action: "emulate", session, device: "iphone-14", width: 430, mobile: false, dpr: 2, touch: false, ua: "BrowserSkillSmoke/1.0", acceptLanguage: "en-US" });
          const emulated = (await evaluate("({ua:navigator.userAgent,dpr:devicePixelRatio,touch:navigator.maxTouchPoints})")).value;
          assert.equal(emulated.ua, "BrowserSkillSmoke/1.0");
          assert.equal(emulated.dpr, 2);
          assert.equal(emulated.touch, 0);
          await reject("bsk_assist", { action: "emulate", session, off: true, touch: false }, /mutually exclusive/);
          return emulated;
        } finally { await call("bsk_assist", { action: "emulate", session, off: true }); }
      });
      await check("hover", async () => {
        const hoverArgs = { action: "observe", session, probeHover: true, debugSurfaces: true };
        const hovered = await call("bsk_inspect", hoverArgs);
        assert(hovered.hoverProbe && hovered.debug, "official hover/debug diagnostics must survive candidate output mapping");
        assert.match(tools.get("bsk_inspect").output.render(hoverArgs, hovered)[0].text, /hoverProbe=/);
        return { hoverProbe: hovered.hoverProbe, debug: hovered.debug };
      });
      run.passed = Object.values(run.results).every((feature) => feature.passed);
    } catch (error) {
      run.error = String(error);
      report.failures.push({ browser, error: String(error), stack: error.stack });
    } finally {
      if (session) {
        try {
          await call("bsk_session", { action: "stop", session });
          const owned = await call("bsk_session", { action: "list" });
          assert(!owned.sessions.some((entry) => entry.sessionId === session));
          const screenshotPassed = run.results.screenshot?.passed === true;
          if (screenshotPassed) assert((await stat(join(browserResults, "full.png"))).size > 0, "explicit screenshot survives stop");
          report.cleanup.push({ browser, session, stopped: true, explicitScreenshotRetained: screenshotPassed });
        } catch (error) { report.cleanup.push({ browser, session, stopped: false, error: String(error) }); report.failures.push({ browser, cleanup: String(error) }); }
      }
    }
  }
} catch (error) {
  report.failures.push({ error: String(error), stack: error.stack });
} finally {
  try { await Promise.all(disposers.map((dispose) => dispose())); }
  catch (error) { report.failures.push({ disposal: String(error) }); }
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
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`${report.passed ? "PASS" : "FAIL"} candidate live smoke: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
