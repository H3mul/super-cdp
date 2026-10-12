/* eslint-disable @typescript-eslint/no-explicit-any */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from './browser.js';
export const DEFAULT_PORT = 9222;
const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.local');
const isLocal = (u) => {
    try {
        return isLocalHost(new URL(u).hostname);
    }
    catch {
        return false;
    }
};
/**
 * Where the CDP endpoint lives. Precedence: explicit option (CLI flag) > SUPER_CDP_HOST / SUPER_CDP_PORT > 127.0.0.1:9222.
 * `host` may be a hostname/IP, `host:port`, or a full URL (https://cdp.example.com) for proxied/TLS endpoints.
 */
export function endpoint({ host, port } = {}) {
    host ??= process.env.SUPER_CDP_HOST || '127.0.0.1';
    port ??= Number(process.env.SUPER_CDP_PORT) || DEFAULT_PORT;
    const bare = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host; // bare IPv6 literal
    const base = /^\w+:\/\//.test(host)
        ? host.replace(/\/$/, '')
        : /^[^:]+:\d+$/.test(host)
            ? `http://${host}`
            : `http://${bare}:${port}`;
    const u = new URL(base);
    return { base, label: u.host, local: isLocalHost(u.hostname) };
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
/** Read-only check of the CDP HTTP endpoint. Never spawns anything. */
export async function probe(conn = {}) {
    const { base, label, local } = endpoint(conn);
    const timeout = () => AbortSignal.timeout(local ? 1000 : 4000);
    try {
        const v = await fetch(`${base}/json/version`, { signal: timeout() });
        if (!v.ok)
            throw new Error(String(v.status));
        const list = (await (await fetch(`${base}/json/list`, { signal: timeout() })).json());
        const pages = list.filter((t) => t.type === 'page');
        // Local browser: only localhost tabs are attachable (your other tabs stay untouched).
        // Remote host: choosing the host is the opt-in, so every tab is listed; narrow with --url.
        const shown = local ? pages.filter((t) => isLocal(t.url)) : pages;
        return {
            open: true,
            host: label,
            remote: !local,
            targets: shown.map((t) => ({ url: clip(t.url, 120), title: clip(t.title, 60) })),
            otherTabs: pages.length - shown.length, // never attached to; count only
        };
    }
    catch {
        return { open: false, host: label };
    }
}
/** Cap output so a runaway return value can't blow the context window. */
export function budget(v, max = 4000) {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
    return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars; narrow the scope or pass --max]` : s;
}
// Console/network events are only visible while attached, so collect for the duration of one call.
function collect(page) {
    const logs = new Map();
    const net = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning')
            bump(logs, `${m.type()}: ${clip(m.text(), 200)}`);
    });
    page.on('pageerror', (e) => bump(logs, `pageerror: ${clip(e.message, 200)}`));
    page.on('requestfailed', (r) => bump(net, `FAIL ${r.method()} ${clip(r.url(), 120)} ${r.failure()?.errorText}`));
    page.on('response', (r) => {
        if (r.status() >= 400)
            bump(net, `${r.status()} ${r.request().method()} ${clip(r.url(), 120)}`);
    });
    const dump = (m) => [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
    return { logs: () => dump(logs), net: () => dump(net) };
}
const stateDir = (key) => {
    const d = join(tmpdir(), 'super-cdp', key.replace(/\W/g, '_'));
    mkdirSync(d, { recursive: true });
    return d;
};
function api(page, key) {
    const ev = (name, ...args) => page.evaluate(([n, a]) => window.__scx[n](...a), [name, args]);
    const c = collect(page);
    return {
        /** Orientation: url/title/viewport + aria outline. Use instead of a first screenshot. */
        async snap(scope = 'body') {
            const m = await ev('meta');
            const outline = await page.locator(scope).first().ariaSnapshot();
            return `${m.url} | ${m.title} | ${m.vw}x${m.vh} | badResources:${m.bad}\n${outline}`;
        },
        state: (sel) => ev('state', sel),
        trim: (sel, opts) => ev('trim', sel, opts),
        problems: (scope) => ev('problems', scope),
        /** Filtered accessibility tree as `role "name" [states]` lines. */
        async ax(sel) {
            const cdp = await page.context().newCDPSession(page);
            try {
                const { nodes } = (await cdp.send('Accessibility.getFullAXTree'));
                let keep = null;
                if (sel) {
                    const { result } = (await cdp.send('Runtime.evaluate', {
                        expression: `document.querySelector(${JSON.stringify(sel)})`,
                    }));
                    if (!result.objectId)
                        return null;
                    const { node } = (await cdp.send('DOM.describeNode', { objectId: result.objectId, depth: -1 }));
                    keep = new Set();
                    const walk = (n) => (keep.add(n.backendNodeId), (n.children ?? []).forEach(walk));
                    walk(node);
                }
                const DROP = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'StaticText', 'LineBreak']);
                return nodes
                    .filter((n) => !n.ignored && !DROP.has(n.role?.value) && (!keep || keep.has(n.backendDOMNodeId)))
                    .map((n) => {
                    const st = (n.properties ?? [])
                        .filter((p) => p.value?.value === true || p.name === 'level')
                        .map((p) => (p.name === 'level' ? `level=${p.value.value}` : p.name));
                    return `${n.role.value} "${clip(n.name?.value ?? '', 60)}"${st.length ? ' [' + st.join(',') + ']' : ''}`;
                });
            }
            finally {
                await cdp.detach();
            }
        },
        /** First call stores a baseline; later calls report only what changed since it. `rebase` resets it. */
        async diff(label, rebase = false) {
            const file = join(stateDir(key), `${label.replace(/\W/g, '_')}.json`);
            const cur = (await ev('snapshot'));
            let base = null;
            try {
                if (!rebase)
                    base = JSON.parse(readFileSync(file, 'utf8'));
            }
            catch { }
            if (!base) {
                writeFileSync(file, JSON.stringify(cur));
                return `baseline '${label}' stored (${Object.keys(cur).length} elements)`;
            }
            const added = Object.keys(cur).filter((k) => !(k in base));
            const removed = Object.keys(base).filter((k) => !(k in cur));
            const changed = [];
            for (const k of Object.keys(cur)) {
                const a = base[k], b = cur[k];
                if (!a)
                    continue;
                if (a.x !== b.x)
                    changed.push(`${k} text "${a.x}"→"${b.x}"`);
                if (a.c !== b.c)
                    changed.push(`${k} class "${a.c}"→"${b.c}"`);
                if (a.b.some((v, i) => Math.abs(v - b.b[i]) > 2))
                    changed.push(`${k} box [${a.b}]→[${b.b}]`);
            }
            const out = {};
            if (added.length)
                out.added = added.slice(0, 30);
            if (removed.length)
                out.removed = removed.slice(0, 30);
            if (changed.length)
                out.changed = changed.slice(0, 30);
            return Object.keys(out).length ? out : 'no changes';
        },
        logs: () => c.logs(),
        net: () => c.net(),
        /** Last resort. JPEG written to a temp file; Read it only if tiers 1-3 can't answer. */
        async shot(sel, reason) {
            if (!reason)
                throw new Error('shot(sel, reason): a reason is required; prefer snap/state/problems/ax first');
            const path = join(stateDir(key), `shot-${Date.now()}.jpg`);
            const opts = { path, type: 'jpeg', quality: 50, scale: 'css' };
            if (sel)
                await page.locator(sel).first().screenshot(opts);
            else
                await page.screenshot(opts);
            return { path, reason };
        },
    };
}
/** Attach to the user's Chrome, pick a localhost page, run `code` with `page` and `$` in scope. */
export async function run(code, { host, port, max = 4000, url, timeoutMs = 15000 } = {}) {
    const ep = endpoint({ host, port });
    const browser = await chromium.connectOverCDP(ep.base);
    let timer;
    try {
        const pages = browser.contexts().flatMap((c) => c.pages());
        const page = pages.find((p) => (!ep.local || isLocal(p.url())) && (!url || p.url().includes(url)));
        if (!page)
            throw new Error(`no ${ep.local ? 'localhost ' : ''}page target on ${ep.label}${url ? ` matching '${url}'` : ''} (${pages.length} tabs open)`);
        await page.addInitScript(install); // survives navigations/reloads within this connection
        await page.evaluate(install);
        const fn = new AsyncFunction('page', '$', code);
        const timeout = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)));
        return budget(await Promise.race([fn(page, api(page, ep.label)), timeout]), max);
    }
    finally {
        clearTimeout(timer);
        await browser.close(); // for connectOverCDP this only disconnects
    }
}
