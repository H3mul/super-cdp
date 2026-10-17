/* eslint-disable @typescript-eslint/no-explicit-any */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { install } from './browser.js';

export const DEFAULT_PORT = 9222;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const isLocalHost = (h: string) =>
  h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || h.endsWith('.local');
const isLocal = (u: string) => {
  try {
    return isLocalHost(new URL(u).hostname);
  } catch {
    return false;
  }
};

// Sandbox/corporate proxy: Node fetch ignores it and Playwright's own proxying drops credentials (407),
// so read it once, strip it from the env, and tunnel via a local CONNECT forwarder instead.
const envp = (k: string) => process.env[k] ?? process.env[k.toLowerCase()];
const PROXY = envp('HTTPS_PROXY') || envp('HTTP_PROXY');
const NO_PROXY = (envp('NO_PROXY') ?? '').split(',').map((x) => x.trim().replace(/^\*?\./, '')).filter(Boolean);
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
  delete process.env[k];
  delete process.env[k.toLowerCase()];
}

/** Local plain-TCP port that CONNECTs to `base`'s host through the proxy. No-op without a proxy, for https, or when NO_PROXY matches. */
async function viaProxy(base: string) {
  const u = new URL(base);
  const skip = !PROXY || u.protocol !== 'http:' || NO_PROXY.some((n) => n === '*' || u.hostname === n || u.hostname.endsWith('.' + n));
  if (skip) return { base, close: () => {} };
  const p = new URL(PROXY!);
  const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : '';
  const target = `${u.hostname}:${u.port || 80}`;
  const server = createServer((c) => {
    const up = connect(Number(p.port) || 80, p.hostname);
    let head = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      up.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(head.toString('latin1', 0, 16))) return void (c.destroy(), up.destroy());
      c.write(head.subarray(i + 4));
      c.pipe(up);
      up.pipe(c);
    };
    up.on('data', onData).on('connect', () => up.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));
    up.on('error', () => c.destroy());
    c.on('error', () => up.destroy());
    c.on('close', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export type Conn = { host?: string; port?: number };

/**
 * Where the CDP endpoint lives. Precedence: explicit option (CLI flag) > SUPER_CDP_HOST / SUPER_CDP_PORT > 127.0.0.1:9222.
 * `host` may be a hostname/IP, `host:port`, or a full URL (https://cdp.example.com) for proxied/TLS endpoints.
 */
export function endpoint({ host, port }: Conn = {}) {
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
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Read-only check of the CDP HTTP endpoint. Never spawns anything. */
export async function probe(conn: Conn = {}) {
  const { base, label, local } = endpoint(conn);
  const timeout = () => AbortSignal.timeout(local ? 1000 : 4000);
  const t = await viaProxy(base);
  try {
    const v = await fetch(`${t.base}/json/version`, { signal: timeout() });
    if (!v.ok) throw new Error(String(v.status));
    const list = (await (await fetch(`${t.base}/json/list`, { signal: timeout() })).json()) as any[];
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
  } catch {
    return { open: false, host: label };
  } finally {
    t.close();
  }
}

/** Cap output so a runaway return value can't blow the context window. */
export function budget(v: unknown, max = 4000) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars; narrow the scope or pass --max]` : s;
}

// Console/network events are only visible while attached, so collect for the duration of one call.
function collect(page: Page) {
  const logs = new Map<string, number>();
  const net = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') bump(logs, `${m.type()}: ${clip(m.text(), 200)}`);
  });
  page.on('pageerror', (e) => bump(logs, `pageerror: ${clip(e.message, 200)}`));
  page.on('requestfailed', (r) => bump(net, `FAIL ${r.method()} ${clip(r.url(), 120)} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) bump(net, `${r.status()} ${r.request().method()} ${clip(r.url(), 120)}`);
  });
  const dump = (m: Map<string, number>) => [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  return { logs: () => dump(logs), net: () => dump(net) };
}

const stateDir = (key: string) => {
  const d = join(tmpdir(), 'super-cdp', key.replace(/\W/g, '_'));
  mkdirSync(d, { recursive: true });
  return d;
};

function api(page: Page, key: string) {
  const ev = (name: string, ...args: unknown[]) =>
    page.evaluate(([n, a]) => (window as any).__scx[n](...(a as unknown[])), [name, args] as [string, unknown[]]);
  const c = collect(page);

  return {
    /** Orientation: url/title/viewport + aria outline. Use instead of a first screenshot. */
    async snap(scope = 'body') {
      const m: any = await ev('meta');
      const outline = await page.locator(scope).first().ariaSnapshot();
      return `${m.url} | ${m.title} | ${m.vw}x${m.vh} | badResources:${m.bad}\n${outline}`;
    },
    state: (sel: string) => ev('state', sel),
    trim: (sel: string, opts?: { maxNodes?: number; maxDepth?: number }) => ev('trim', sel, opts),
    problems: (scope?: string) => ev('problems', scope),
    /** Filtered accessibility tree as `role "name" [states]` lines. */
    async ax(sel?: string) {
      const cdp = await page.context().newCDPSession(page);
      try {
        const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as any;
        let keep: Set<number> | null = null;
        if (sel) {
          const { result } = (await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector(${JSON.stringify(sel)})`,
          })) as any;
          if (!result.objectId) return null;
          const { node } = (await cdp.send('DOM.describeNode', { objectId: result.objectId, depth: -1 })) as any;
          keep = new Set();
          const walk = (n: any) => (keep!.add(n.backendNodeId), (n.children ?? []).forEach(walk));
          walk(node);
        }
        const DROP = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'StaticText', 'LineBreak']);
        return nodes
          .filter((n: any) => !n.ignored && !DROP.has(n.role?.value) && (!keep || keep.has(n.backendDOMNodeId)))
          .map((n: any) => {
            const st = (n.properties ?? [])
              .filter((p: any) => p.value?.value === true || p.name === 'level')
              .map((p: any) => (p.name === 'level' ? `level=${p.value.value}` : p.name));
            return `${n.role.value} "${clip(n.name?.value ?? '', 60)}"${st.length ? ' [' + st.join(',') + ']' : ''}`;
          });
      } finally {
        await cdp.detach();
      }
    },
    /** First call stores a baseline; later calls report only what changed since it. `rebase` resets it. */
    async diff(label: string, rebase = false) {
      const file = join(stateDir(key), `${label.replace(/\W/g, '_')}.json`);
      const cur = (await ev('snapshot')) as Record<string, any>;
      let base: Record<string, any> | null = null;
      try {
        if (!rebase) base = JSON.parse(readFileSync(file, 'utf8'));
      } catch {}
      if (!base) {
        writeFileSync(file, JSON.stringify(cur));
        return `baseline '${label}' stored (${Object.keys(cur).length} elements)`;
      }
      const added = Object.keys(cur).filter((k) => !(k in base!));
      const removed = Object.keys(base).filter((k) => !(k in cur));
      const changed: string[] = [];
      for (const k of Object.keys(cur)) {
        const a = base[k], b = cur[k];
        if (!a) continue;
        if (a.x !== b.x) changed.push(`${k} text "${a.x}"→"${b.x}"`);
        if (a.c !== b.c) changed.push(`${k} class "${a.c}"→"${b.c}"`);
        if (a.b.some((v: number, i: number) => Math.abs(v - b.b[i]) > 2)) changed.push(`${k} box [${a.b}]→[${b.b}]`);
      }
      const out: Record<string, unknown> = {};
      if (added.length) out.added = added.slice(0, 30);
      if (removed.length) out.removed = removed.slice(0, 30);
      if (changed.length) out.changed = changed.slice(0, 30);
      return Object.keys(out).length ? out : 'no changes';
    },
    logs: () => c.logs(),
    net: () => c.net(),
    /** Last resort. JPEG written to a temp file; Read it only if tiers 1-3 can't answer. */
    async shot(sel: string | null, reason: string) {
      if (!reason) throw new Error('shot(sel, reason): a reason is required; prefer snap/state/problems/ax first');
      const path = join(stateDir(key), `shot-${Date.now()}.jpg`);
      const opts = { path, type: 'jpeg' as const, quality: 50, scale: 'css' as const };
      if (sel) await page.locator(sel).first().screenshot(opts);
      else await page.screenshot(opts);
      return { path, reason };
    },
  };
}

/** Compact a script error: message + the user's failing line + a hint. Stack frames are noise. */
function explain(e: any, code: string): Error {
  const msg = String(e?.message ?? e).split('\n')[0];
  // AsyncFunction prepends 2 header lines; the user-script frame is the last "<anonymous>:L:C" not inside evaluate.
  const frame = String(e?.stack ?? '').split('\n').filter((l) => /<anonymous>:\d+:\d+/.test(l) && !/evaluate/.test(l)).pop();
  const n = frame ? Number(/<anonymous>:(\d+):/.exec(frame)![1]) - 2 : 0;
  const src = n > 0 ? `\n  line ${n}: ${code.split('\n')[n - 1]?.trim().slice(0, 120)}` : '';
  const hint = /Cannot read properties of (null|undefined)/.test(msg)
    ? `\n  hint: a lookup returned null (selector matched nothing, or element gone after a re-render). Probe first: await page.waitForSelector(sel, {timeout: 2000}) or return document.querySelector(sel) !== null.`
    : '';
  return Object.assign(new Error(msg + src + hint), { scripted: true });
}

export type RunOpts = Conn & { max?: number; url?: string; timeoutMs?: number };

/** Attach to the user's Chrome, pick a localhost page, run `code` with `page` and `$` in scope. */
export async function run(code: string, { host, port, max = 4000, url, timeoutMs = 15000 }: RunOpts = {}) {
  const ep = endpoint({ host, port });
  const t = await viaProxy(ep.base);
  const browser = await chromium.connectOverCDP(t.base).catch((e) => (t.close(), Promise.reject(e)));
  let timer: NodeJS.Timeout | undefined;
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => (!ep.local || isLocal(p.url())) && (!url || p.url().includes(url)));
    if (!page)
      throw new Error(
        `no ${ep.local ? 'localhost ' : ''}page target on ${ep.label}${url ? ` matching '${url}'` : ''} (${pages.length} tabs open)`,
      );
    await page.addInitScript(install); // survives navigations/reloads within this connection
    await page.evaluate(install);
    const fn = new AsyncFunction('page', '$', code);
    const timeout = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)));
    const result = await Promise.race([fn(page, api(page, ep.label)), timeout]).catch((e) => {
      throw explain(e, code);
    });
    return budget(result, max);
  } finally {
    clearTimeout(timer);
    await browser.close(); // for connectOverCDP this only disconnects
    t.close();
  }
}
