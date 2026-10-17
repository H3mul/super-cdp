// probe() must reach the CDP port through an authenticated CONNECT proxy (sandbox case). No Chrome needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcp, connect } from 'node:net';
import { execFileSync } from 'node:child_process';

test('probe tunnels through authed proxy', async () => {
  const cdp = createServer((q, r) => r.end(q.url === '/json/list' ? '[{"type":"page","url":"http://localhost:3000/","title":"t"}]' : '{}'));
  await new Promise((r) => cdp.listen(9444, '127.0.0.1', r));
  let seen;
  const proxy = tcp((c) =>
    c.once('data', (d) => {
      const head = d.toString();
      seen = head;
      if (!head.includes('Proxy-Authorization: Basic ' + Buffer.from('u:p').toString('base64'))) return void c.end('HTTP/1.1 407 no\r\n\r\n');
      const up = connect(9444, '127.0.0.1', () => {
        c.write('HTTP/1.1 200 OK\r\n\r\n');
        c.pipe(up);
        up.pipe(c);
      });
    }),
  );
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const code = `import {probe} from './dist/core.js'; console.log(JSON.stringify(await probe({port:9444})))`;
  const out = await new Promise((res, rej) =>
    import('node:child_process').then(({ execFile }) =>
      execFile('node', ['--input-type=module', '-e', code], { env: { ...process.env, HTTP_PROXY: `http://u:p@127.0.0.1:${proxy.address().port}`, NO_PROXY: '' } }, (e, o) => (e ? rej(e) : res(o))),
    ),
  );
  cdp.close();
  proxy.close();
  assert.match(seen, /^CONNECT 127\.0\.0\.1:9444/);
  assert.equal(JSON.parse(out).targets.length, 1);
});
