// Plugins are copied from git without `npm install`; fetch the one runtime dep once.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.env.CLAUDE_PLUGIN_ROOT;
if (root && !existsSync(join(root, 'node_modules', 'playwright-core'))) {
  // shell:true so Windows resolves npm.cmd; stdout -> stderr keeps hook output clean
  spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent', '--prefix', root], {
    stdio: ['ignore', 2, 2],
    shell: process.platform === 'win32',
  });
}
