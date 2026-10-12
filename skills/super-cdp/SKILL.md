---
name: super-cdp
description: Use when building, styling, debugging or verifying a web UI (HTML/CSS/React/Vue/Svelte/Next/Vite, localhost dev server) - layout/spacing/overflow/responsive bugs, "button not clickable", console or network errors, accessibility, "does it look right", verifying a UI change. Inspects the live page over Chrome DevTools Protocol with compact structured output instead of screenshots. Use even if the user doesn't mention a browser.
---

# super-cdp: analytical web UI inspection

Ask the page a specific question, get a small answer. **Never start with a screenshot.**

`CDP="node ${CLAUDE_PLUGIN_ROOT}/dist/entry/cli.js"` (all commands below are `$CDP <cmd>`).

## Step 1: probe (once per session; remember the answer)
Only when runtime inspection would beat reading the source. Skip for pure logic/backend work.

`$CDP probe` prints `{"open":true,"host":...,"targets":[...]}` (exit 0) or `{"open":false}` (exit 3). It is read-only and never starts a browser.

- **open** → AskUserQuestion: "A Chrome DevTools port is open on :9222. May I attach to inspect your page?" (Yes / Not this session). Note CDP exposes the whole browser (tabs, cookies); a dedicated debug profile is safer. Do not attach without a yes.
- **closed** → AskUserQuestion: "No CDP port on :9222. Setting one up lets me inspect your UI directly instead of guessing from source or screenshots." Options:
  1. *I'll set it up myself*: give `google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/super-cdp-profile http://localhost:<dev-port>` (macOS: `open -a "Google Chrome" --args ...`), then re-probe when they say ready.
  2. *Configure my project*: inspect package.json scripts / vite, next config / launch.json; propose an **additive** script (e.g. `dev:cdp`) that opens Chrome with those flags; show the diff, edit only after approval, never replace their `dev` script. They run it.
  3. *Skip*: continue from source; don't ask again this session.
- Never launch or kill Chrome yourself. Several tabs? `--url <substring>`. A local browser only exposes localhost tabs.
- **Remote CDP** (`--host H` / `SUPER_CDP_HOST`, `--port N` / `SUPER_CDP_PORT`; flags beat env; host may be `name`, `name:port` or `https://url`): use it only when the user asked for it or the env vars are already set. Remote hosts are not origin-filtered, so the host choice is the opt-in: confirm the host with the user once (AskUserQuestion) since CDP is unauthenticated and gives full control of that browser. Prefer an SSH tunnel (`ssh -L 9222:localhost:9222 <host>`), which makes it a plain local port.

## Step 2: ask the cheapest question that works (tiers)
1. **Outline**: `$CDP snap [selector]` (url, title, viewport, aria outline, bad-resource count)
2. **Facts**: `$.state`, `$.problems`, `$.diff`, `$.logs`, `$.net`
3. **Structure**: `$.ax`, `$.trim`
4. **Pixels**: `$.shot(sel, reason)` only when 1-3 can't decide (canvas, image content, "is this pretty"). Writes a JPEG; Read it.

## Scratchpad
```bash
$CDP run <<'JS'
// `page` (Playwright Page, already attached) and `$` are in scope; don't redeclare. `return` small JSON/string.
return await $.state('#buy')
JS
```
Everything Playwright (`page.click`, `page.fill`, `page.setViewportSize`, `page.reload`, `getByRole`...) works as usual; no helper wraps those. Output is capped at ~4000 chars (`--max N` to raise; prefer narrowing the selector).

| helper | answers |
|---|---|
| `$.snap(scope?)` | what's on the page (aria outline) |
| `$.state(sel)` | count, box, visible, inViewport, **occludedBy** (what blocks a click), disabled, overflow |
| `$.problems(scope?)` | page h-scroll, clipped text, tiny tap targets, overlapping controls, broken/alt-less imgs, unlabeled inputs, nameless buttons, low contrast |
| `$.diff(label, rebase?)` | first call stores baseline; later calls list only added/removed/changed/moved elements. Use around every edit |
| `$.logs()` / `$.net()` | console errors/warnings, pageerrors / failed or 4xx-5xx requests, **only events during this call**, so do `await page.reload()` inside the same run |
| `$.ax(sel?)` | accessibility tree lines `role "name" [states]` |
| `$.trim(sel, {maxNodes, maxDepth})` | pruned DOM structure of one container |
| `$.shot(sel\|null, reason)` | last-resort screenshot path |

## Patterns
- **Orient**: `$CDP snap`, then `$.problems()`.
- **Verify a fix**: `$.diff('fix')` before editing → edit → reload → `$.diff('fix')`; also check `$.logs()` after the reload.
- **Not clickable**: `$.state(sel)` → `occludedBy`, `disabled`, `inViewport`.
- **Responsive sweep**: `for (const w of [360,768,1280]) { await page.setViewportSize({width:w,height:800}); out[w] = await $.problems() }`
- **Computed style**: `await page.evaluate(s => { const c = getComputedStyle(document.querySelector(s)); return {display:c.display, gap:c.gap} }, '#x')`

## Rules
- Return the specific number/bool/list you need, not whole trees.
- Report findings from the data (selectors, numbers), not from imagined visuals.
- If it fails with "no localhost page target", the tab isn't open or isn't on localhost; ask the user.
