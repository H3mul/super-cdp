// One-line nudge, only in web projects. Silent elsewhere.
import { existsSync, readFileSync } from 'node:fs';

const FRAMEWORKS = /"(react|vue|svelte|next|nuxt|astro|vite|webpack|parcel|solid-js|preact|@angular\/core)"/;
const isWeb =
  existsSync('index.html') || (existsSync('package.json') && FRAMEWORKS.test(readFileSync('package.json', 'utf8')));

if (isWeb)
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'Web project detected. For runtime UI verification (layout, clickability, console/network errors, a11y) use the super-cdp skill instead of screenshots.',
      },
    }),
  );
