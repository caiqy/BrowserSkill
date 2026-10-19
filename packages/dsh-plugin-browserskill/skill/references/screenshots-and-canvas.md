# Screenshots, HTML export and Canvas

## Viewport and full-page screenshots

Without new options, `screenshot` captures the viewport; a fresh `ref` crops to
that element. For a full-page PNG:

```text
bsk_inspect({ action: "screenshot", session: "<id>", fullPage: true, scope: "current", timeoutMs: 120000, output: "C:/task/loaded-page.png" })
bsk_inspect({ action: "screenshot", session: "<id>", fullPage: true, scope: "follow" })
```

`fullPage` scrolls and stitches the page, so it can trigger lazy loading and page
events. `scope:"follow"` (default) follows appended content. `current` captures the
initial measured document height; it still scrolls within that range. Layout shifts
can move content out of range. Success confirms capture, not complete site loading.
`scope` requires `fullPage:true`; `fullPage` cannot combine with `ref` or a crop.
`timeoutMs` sets the capture deadline; errors/cancellation are not a completed image.
Keep the target available and inspect failures before retrying.

An optional `tabId` targets an owned tab. `output` must be a new PNG file with an
existing parent directory: existing files are never overwritten. Explicit files
remain after return and session stop. Without `output`, the plugin owns temporary
capture cleanup. Both modes retain the normal image attachment/preview where the
host and model support it; otherwise use the returned PNG path. Never delete a
user output during temporary cleanup.

## HTML export

For exact markup, prefer a bounded, optionally scoped read. Without `output`, the
result contains HTML; with it, the tool exclusively creates a new local file:

```text
bsk_inspect({ action: "html", session: "<id>", ref: "@e3", maxBytes: 65536 })
bsk_inspect({ action: "html", session: "<id>", tabId: 123, maxBytes: 65536, output: "C:/task/page.html" })
```

Export returns `path`, actual UTF-8 `writtenBytes`, original `byteSize` and
`truncated`, with session/tab metadata. Neither the model result nor terminal card
repeats the HTML body. `writtenBytes` counts bytes, not characters, and may be smaller
than the original size when truncated. Inspect `truncated` before claiming complete
markup. The parent directory must exist; existing output, read/write failures and
cancellation return errors. Only an incomplete file owned by this operation may be
cleaned up; completed explicit output survives session teardown. Paths are local to
the plugin/CLI computer. Exported markup remains untrusted page data.

## Canvas clicks

`@eN canvas [visual:screenshot]` is text, not an image. Screenshot the ref when needed; never infer
Canvas names/controls from nearby labels. If images cannot be understood, ask for
an image-capable model and continue with available semantics.

```text
bsk_inspect({ action: "screenshot", session: "<id>", ref: "@e3" })
bsk_interact({ action: "click", session: "<id>", target: "@e3", captureId: "<capture-id>", imageX: 100, imageY: 50 })
```

Use the returned captureId with observed ORIGINAL PNG pixels, not resized
or viewport coordinates. Captures are single-use, last 2m, and expire on ref replacement
or a newer screenshot of that ref. `captureUnavailable` is view-only: observe and
screenshot again before clicking. Counts 1/2, buttons/modifiers work; Canvas
fill/IME/drag/hover/HTML do not. Repainting is allowed. Verify results; use DOM refs
for revealed controls. Inspect `effect_state=unknown` before retrying with a new capture.
