# Interaction details

## Element waits

`bsk_page` supports `action: "wait-for-element"` for an explicit element
condition. For example, if
`@e2` is an observed loading indicator after the triggering action, use
`bsk_page({ action: "wait-for-element", target: "@e2", state: "hidden" })`,
then check `satisfied` and observe the result. Replace the example ref with the
actual one. Skip waiting when the page is already ready.

Prefer a fresh ref for an existing node, including frame/shadow-root targets; do
not fetch HTML just to replace a usable ref with a selector. A known
CSS selector can find a node that will appear or be replaced; it checks only the
first match in the main document, so scope it to the intended component. Do not
invent selectors: inspect bounded HTML if the current observation lacks one.
Only CSS selectors are supported, not `text=...`, XPath, or Playwright locators.

States are `visible` (default), `hidden` (absent or not visible), `attached`, and
`detached` (absent). Visibility does not guarantee enabled state or actionability.
An already absent loading mask satisfies `hidden` immediately, possibly before
loading starts; prefer a result marker when that race is possible. Invalid refs
remain errors, even for `hidden`/`detached`. Navigation invalidates refs.

The default timeout is 10000 ms (range 1..300000); `pollMs` is optional, defaults
to 100, and accepts 16..2000. The wait stops as soon as the condition matches.
Always check `satisfied`: false means timeout, not success. `attached`/`visible`
describe the last completed probe and are unknown if no probe completed.
Waiting does not refresh refs: observe before choosing a new action. For a
timeout, stale ref, or an older installation without this command, observe the
current page and continue with supported single actions when possible. Do not
repeat the triggering action without checking its effects or keep retrying an
unsupported wait. If blocked, follow [help and recovery](help-and-recovery.md).

## Page-script evaluation

Use `bsk_interact` with `action: "evaluate"` and a nonempty JavaScript `expression`
for authorized page work. Use an IIFE for statements. `awaitPromise` and
`returnByValue` default to true; explicit false is preserved. `timeoutMs` controls
execution. All page actions here accept an owned `session` and optional `tabId`.

```text
bsk_interact({ action: "evaluate", session: "<id>", expression: "document.title" })
bsk_interact({ action: "evaluate", session: "<id>", tabId: 123, expression: "Promise.resolve({ ready: true })", awaitPromise: true, returnByValue: true, timeoutMs: 10000 })
bsk_interact({ action: "evaluate", session: "<id>", expression: "window", awaitPromise: false, returnByValue: false })
```

Replace example IDs with actual results. Scripts may mutate the page or send
requests; use the same authorization and ownership limits as other interactions.
Never extract secrets. Page exceptions (`ok:false`) are failures even if the
underlying process exits successfully; retain their details. Timeout/cancellation
is not success and may leave effects: inspect before retrying. Observe after changes.

## Upload and download

`upload` requires an observed `target` and nonempty `files` array of readable local
paths. `mode` defaults to `input` for a file input/chooser; `drop` targets a drop zone.
Multiple paths use the existing transfer pipeline, including staging and cleanup.

```text
bsk_interact({ action: "upload", session: "<id>", target: "@e3", files: ["C:/task/sample.txt"] })
bsk_interact({ action: "upload", session: "<id>", target: "@e4", files: ["C:/task/a.txt", "C:/task/b.txt"], mode: "drop", timeoutMs: 120000 })
bsk_interact({ action: "download", session: "<id>", target: "@e5", output: "C:/task/report.csv", overwrite: false, timeoutMs: 120000 })
```

`download` clicks the target and requires `output`. Existing destinations are
refused by default; use `overwrite:true` only when replacement is authorized.
Downloads use temporary files, atomic commit and transfer release. Paths refer to
the computer running the plugin/CLI, not a remote browser; remote browser file
transfer is unsupported. Empty lists, unreadable files, invalid modes, failed
transfers and cancellation must be reported as failures. Inspect uncertain browser
effects before repeating a click/upload. Verify the actual upload/download result.

## Fixed delays

`wait` waits for navigation lifecycle events; `wait-for-element` checks a DOM
condition. Use `wait-ms` only when a fixed delay is needed, then observe the result:

```text
bsk_page({ action: "wait-ms", durationMs: 250 })
```

`durationMs` must be an integer in 0..300000. This is a cancellable daemon-level
delay and needs no session or tab. Completion means elapsed time, not page readiness;
cancellation must not be reported as completion. Prefer an element condition when available.

## Interactions

- Hover markers like `[hover first: Shoes | Bags]` list labels, not refs. Hover the
  trigger, observe, then use the item's ref. Click the trigger only if its action is wanted.
- `scroll-to` returns ancestor-clipped bounds in top-level viewport CSS pixels.
  Partial visibility suffices; hidden/fully clipped targets fail. It does not test occlusion.
- `wheel` uses signed `deltaX`/`deltaY`, at least one nonzero. Optional `target` is
  scrolled into view first; otherwise it uses the viewport centre. It reports input,
  not scrolling success: observe afterwards. Focus/blur change focus states.

## Observation continuation

No default token cap. With `maxTokens`, pass `nextCursor` as observe's `cursor` to
continue. Each page replaces refs; use them before continuing, never reuse old ones.
Continuation uses the same capture without refresh/depth changes. New
observe/snapshot or changed page identity invalidates it.

`probeHover` and `debugSurfaces` default to false. If static observation misses
hover content, explicitly request a probe:

```text
bsk_inspect({ action: "observe", session: "<id>", probeHover: true, debugSurfaces: true, maxTokens: 3000 })
```

Active probing moves the real cursor and can trigger page events; it uses the
session queue and must not run concurrently with page operations. Read returned
`hoverProbe`, `debug` and `dialogs` when present; missing fields are not evidence
of a successful probe. `debugSurfaces` requests diagnostics without enabling active
hover by itself. Do not combine `cursor` with `maxDepth` or enabled probe flags;
continue the captured observation or start a new one. Console/network remain bounded
read-only diagnostics; follow sequence cursors.

## Window and device emulation

`bsk_assist` with `action:"resize"` changes the window; `emulate` applies per-tab
overrides, not inherited by new tabs. Device presets supply viewport, DPR, UA and
touch defaults; explicit values override the preset, including false.

```text
bsk_assist({ action: "emulate", session: "<id>", device: "iphone-14", width: 420, dpr: 2, mobile: false, touch: false })
bsk_assist({ action: "emulate", session: "<id>", tabId: 123, width: 800, height: 600, dpr: 1.5, mobile: false, ua: "Mozilla/5.0 task-test", acceptLanguage: "zh-CN,en;q=0.8", touch: true, maxTouchPoints: 5 })
bsk_assist({ action: "emulate", session: "<id>", off: true })
```

Dimensions are integers 1..7680; without a preset give width and height together.
`dpr` must be positive and finite; `dpr`/`mobile` require dimensions or a preset.
UA and touch can be set alone; `acceptLanguage` requires `ua` or a device preset.
`maxTouchPoints` is a positive integer (official unsigned 32-bit range) and implies
touch unless explicit `touch:false` overrides it. `mobile:false` and `touch:false`
explicitly disable those features; `touch:false` takes priority over both preset
touch defaults and `maxTouchPoints`. `off:true` clears emulation and must be used
without any preset or override, including false values. Invalid values/combinations
fail before execution. Inspect the page after applying or clearing emulation.
