// Needs a Chromium binary: CHROME=/path/to/chrome npm test (defaults to /usr/sbin/chromium).
// The test owns the browser it spawns on :9333; super-cdp itself never launches one.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, run, budget, endpoint } from '../dist/core.js';

const PORT = 9333;
let server, chrome, remote;
const RPORT = 9334;
const r = (code, o = {}) => run(code, { port: PORT, ...o });

before(async () => {
  assert.equal((await probe({ port: PORT })).open, false, 'port must start closed (probe spawns nothing)');
  server = createServer((req, res) => {
    if (req.url === '/') res.end(readFileSync(new URL('./broken.html', import.meta.url)));
    else (res.statusCode = 404), res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  chrome = spawn(
    process.env.CHROME ?? '/usr/sbin/chromium',
    ['--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
     `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scdp-'))}`, '--window-size=1000,800',
     `http://127.0.0.1:${server.address().port}/`],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 50 && !(await probe({ port: PORT })).targets?.length; i++) await new Promise((ok) => setTimeout(ok, 200));
});
// "Remote" browser: a second Chromium (loopback-only, new headless ignores --remote-debugging-address) reached
// through a TCP forwarder on 127.0.0.2, like an SSH tunnel. 127.0.0.2 isn't a "local" hostname, so this takes the remote path.
let proxy;
before(async () => {
  remote = spawn(
    process.env.CHROME ?? '/usr/sbin/chromium',
    ['--headless=new', '--no-sandbox', `--remote-debugging-port=${RPORT + 1}`,
     `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scdp-r-'))}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  proxy = tcpServer((c) => {
    const up = connect(RPORT + 1, '127.0.0.1');
    c.pipe(up).pipe(c);
    c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
  }).listen(RPORT, '127.0.0.2');
  for (let i = 0; i < 50 && !(await probe({ host: '127.0.0.2', port: RPORT })).open; i++) await new Promise((ok) => setTimeout(ok, 200));
});
after(() => { chrome?.kill(); remote?.kill(); proxy?.close(); server?.close(); });

test('probe lists localhost targets', async () => {
  const p = await probe({ port: PORT });
  assert.equal(p.open, true);
  assert.equal(p.targets.length, 1);
});

test('state reports the occluding element', async () => {
  const s = JSON.parse(await r(`return await $.state('#buy')`));
  assert.match(s.items[0].occludedBy, /overlay/);
});

test('problems finds each seeded defect', async () => {
  const out = (await r(`return await $.problems()`, { max: 20000 }));
  for (const k of ['page-hscroll', 'unlabeled-input', 'img-no-alt', 'broken-img', 'small-target', 'low-contrast', 'no-accessible-name'])
    assert.ok(out.includes(k), `missing ${k} in ${out}`);
});

test('diff reports only what changed', async () => {
  const label = 't' + Date.now();
  assert.match(await r(`return await $.diff('${label}')`), /baseline/);
  await r(`await page.evaluate(() => { document.querySelector('#title').textContent = 'Changed'; })`);
  const d = JSON.parse(await r(`return await $.diff('${label}')`));
  assert.ok(d.changed.some((c) => c.startsWith('#title text')), JSON.stringify(d));
});

test('logs and net capture a reload', async () => {
  const out = JSON.parse(await r(`await page.reload(); return { l: $.logs(), n: $.net() }`));
  assert.ok(out.l.some((l) => l.includes('boom-fixture')));
  assert.ok(out.n.some((n) => n.startsWith('404')));
});

test('snap is small; trim and ax work', async () => {
  const snap = await r(`return await $.snap()`);
  assert.ok(snap.length < 1500, `snap ${snap.length} chars`);
  const t = JSON.parse(await r(`return await $.trim('body')`));
  assert.ok(t.tree.k.length > 3);
  assert.ok((await r(`return await $.ax('body')`)).includes('heading'));
});

test('budget truncates', async () => {
  const out = await r(`return 'x'.repeat(100000)`, { max: 100 });
  assert.ok(out.length < 300 && out.includes('truncated'));
  assert.ok(budget('short').length === 5);
});

test('endpoint: flag > env > default; host forms', () => {
  const keep = { h: process.env.SUPER_CDP_HOST, p: process.env.SUPER_CDP_PORT };
  delete process.env.SUPER_CDP_HOST; delete process.env.SUPER_CDP_PORT;
  assert.deepEqual(endpoint(), { base: 'http://127.0.0.1:9222', label: '127.0.0.1:9222', local: true });
  process.env.SUPER_CDP_HOST = 'dev.box'; process.env.SUPER_CDP_PORT = '9300';
  assert.equal(endpoint().base, 'http://dev.box:9300');
  assert.equal(endpoint().local, false);
  assert.equal(endpoint({ host: 'other', port: 1 }).base, 'http://other:1'); // flags win over env
  assert.equal(endpoint({ host: 'h:9555' }).base, 'http://h:9555');
  assert.equal(endpoint({ host: 'https://cdp.example.com/' }).base, 'https://cdp.example.com');
  assert.equal(endpoint({ host: '::1', port: 9222 }).base, 'http://[::1]:9222');
  assert.equal(endpoint({ host: '::1' }).local, true);
  for (const [k, v] of [['SUPER_CDP_HOST', keep.h], ['SUPER_CDP_PORT', keep.p]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

test('remote host: probe lists all tabs and run attaches', async () => {
  const p = await probe({ host: '127.0.0.2', port: RPORT });
  assert.equal(p.open, true);
  assert.equal(p.remote, true);
  assert.equal(p.targets.length, 1); // about:blank is not localhost, but remote hosts aren't origin-filtered
  assert.match(await run(`return page.url()`, { host: '127.0.0.2', port: RPORT }), /about:blank/);
});

test('remote host via env vars', async () => {
  process.env.SUPER_CDP_HOST = '127.0.0.2'; process.env.SUPER_CDP_PORT = String(RPORT);
  try { assert.equal((await probe()).host, `127.0.0.2:${RPORT}`); } finally { delete process.env.SUPER_CDP_HOST; delete process.env.SUPER_CDP_PORT; }
});

test('unreachable remote reports closed', async () => {
  assert.equal((await probe({ host: '127.0.0.2', port: 9399 })).open, false);
});
