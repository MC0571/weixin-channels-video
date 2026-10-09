import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = join(root, 'skills/weixin-channels-video');
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'weixin-channels-video/scripts'), { recursive: true });
for (const file of ['SKILL.md', 'requirements.txt']) {
  await cp(join(skill, file), join(dist, 'weixin-channels-video', file));
}
await cp(join(root, 'LICENSE'), join(dist, 'weixin-channels-video/LICENSE'));
await cp(join(skill, 'scripts/cookie_reader.py'), join(dist, 'weixin-channels-video/scripts/cookie_reader.py'));
await build({
  entryPoints: [join(skill, 'scripts/cli.mjs')],
  outfile: join(dist, 'weixin-channels-video/scripts/cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
});
await build({
  entryPoints: [join(skill, 'scripts/codex-browser.mjs')],
  outfile: join(dist, 'weixin-channels-video/scripts/browser.mjs'),
  bundle: true, platform: 'neutral', format: 'esm',
});
await build({
  entryPoints: [join(root, 'extension/app.mjs')],
  outfile: join(root, 'extension/app.js'),
  bundle: true, platform: 'browser', format: 'esm',
});
await cp(join(root, 'extension'), join(dist, 'extension'), { recursive: true });
await cp(join(root, 'LICENSE'), join(dist, 'extension/LICENSE'));
console.log('Built standalone Skill and Chrome extension in dist/.');
