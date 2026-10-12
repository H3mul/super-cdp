# super-cdp

Claude Code plugin for analytical web UI debugging over Chrome DevTools Protocol. A small CLI (`playwright-core`, attach-only) plus a skill that makes the agent ask specific questions of the live page (state, layout problems, DOM/AX diffs, console/network) instead of reading screenshots. No MCP server, no daemon, nothing added to context until the skill triggers.

## Install
```
/plugin marketplace add <path-or-git-url-of-this-repo>
/plugin install super-cdp@super-cdp
```
First session start runs `npm install --omit=dev` inside the plugin dir (only `playwright-core`; no browser download).

## Give the agent a CDP port
super-cdp never starts Chrome. Run your own with a debug port (a dedicated profile is safer, since CDP exposes the whole browser):
```
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/super-cdp-profile http://localhost:5173
# macOS:   open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/super-cdp-profile
# Windows: chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\super-cdp-profile
```
Or let the agent add a `dev:cdp` script to your project when it asks. A local browser only exposes localhost tabs; remote hosts are covered below.

## Make it trigger reliably
The skill description targets web-dev phrasing and a SessionStart hook hints in web projects. For the strongest trigger add to your project's `CLAUDE.md`:
```
For UI changes, verify with the super-cdp skill before claiming done.
```

## Remote CDP
Point at any reachable CDP endpoint with flags or env vars (flags win):
```
SUPER_CDP_HOST=dev.box SUPER_CDP_PORT=9222 super-cdp probe
super-cdp snap --host https://cdp.example.com      # full URL for TLS / reverse-proxied endpoints
```
`--host` accepts `name`, `name:port` or a full URL. A remote host is **not** origin-filtered (picking the host is the opt-in; narrow tabs with `--url`). CDP has no authentication, so don't expose the port publicly; the safe way is an SSH tunnel (`ssh -L 9222:localhost:9222 dev.box`), after which it's just a local port. Note that Chrome only serves CDP to `Host` headers that are an IP or `localhost`, so a hostname behind a reverse proxy may need the proxy to rewrite `Host`. No auth headers are sent.

## CLI
```
super-cdp probe [--host H] [--port N]   # read-only; exit 0 open / 3 closed
super-cdp snap [selector]
super-cdp run <<'JS' ... JS     # `page` + `$` helpers in scope
```
Flags: `--host`, `--port`, `--max` (output char cap, default 4000), `--url` (pick tab by substring). See `skills/super-cdp/SKILL.md` for the helpers.

## Develop
`npm test` builds and runs the suite against a real Chromium (`CHROME=/path/to/chrome`, default `/usr/sbin/chromium`; the test spawns its own on :9333). `dist/` is committed because plugins install straight from git.

Core lives in `src/core.ts` + `src/browser.ts` (injected page code, must stay self-contained); `src/entry/` holds per-platform entrypoints (Claude CLI today).
