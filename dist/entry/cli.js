#!/usr/bin/env node
import { probe, run } from '../core.js';
const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf('--' + name);
    return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const host = flag('host');
const portFlag = flag('port');
const port = portFlag === undefined ? undefined : Number(portFlag);
const max = Number(flag('max') ?? 4000);
const url = flag('url');
const [cmd, arg] = argv;
const stdin = async () => {
    const chunks = [];
    for await (const c of process.stdin)
        chunks.push(c);
    return Buffer.concat(chunks).toString();
};
try {
    if (cmd === 'probe') {
        const r = await probe({ host, port });
        console.log(JSON.stringify(r));
        process.exit(r.open ? 0 : 3);
    }
    else if (cmd === 'snap') {
        console.log(await run(`return await $.snap(${JSON.stringify(arg ?? 'body')})`, { host, port, max, url }));
    }
    else if (cmd === 'run') {
        console.log(await run(await stdin(), { host, port, max, url }));
    }
    else {
        console.error('usage: super-cdp probe|snap [selector]|run (code on stdin)  [--host H] [--port N] [--max N] [--url substr]   (env: SUPER_CDP_HOST, SUPER_CDP_PORT)');
        process.exit(2);
    }
}
catch (e) {
    console.error(String(e?.stack ?? e).split('\n').slice(0, 5).join('\n'));
    process.exit(1);
}
process.exit(0);
