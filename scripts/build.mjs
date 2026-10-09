import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = join(root, 'skills/weixin-channels-video');
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'weixin-channels-video/scripts'), { recursive: true });
await cp(join(skill, 'SKILL.md'), join(dist, 'weixin-channels-video/SKILL.md'));
await cp(join(root, 'LICENSE'), join(dist, 'weixin-channels-video/LICENSE'));
await build({
  entryPoints: [join(skill, 'scripts/cli.mjs')],
  outfile: join(dist, 'weixin-channels-video/scripts/cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
});
await build({
  entryPoints: [join(root, 'src/native-host.mjs')],
  outfile: join(dist, 'weixin-channels-video/scripts/native-host.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
});
await build({
  entryPoints: [join(root, 'extension/background.mjs')],
  outfile: join(root, 'extension/background.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
});
await build({
  entryPoints: [join(root, 'extension/agent.mjs')],
  outfile: join(root, 'extension/agent.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
});
await rm(join(root, 'extension/app.js'), { force: true });
await cp(join(root, 'extension'), join(dist, 'extension'), { recursive: true });
await cp(join(root, 'LICENSE'), join(dist, 'extension/LICENSE'));
await mkdir(join(dist, 'weixin-channels-video/assets'), { recursive: true });
const packagedExtension = join(dist, 'weixin-channels-video/assets/extension');
await mkdir(packagedExtension, { recursive: true });
for (const file of ['manifest.json', 'index.html', 'styles.css', 'background.js', 'agent.js', 'yuanbao-frame.js']) {
  await cp(join(root, 'extension', file), join(packagedExtension, file));
}
await cp(join(root, 'LICENSE'), join(packagedExtension, 'LICENSE'));
console.log('Built standalone Skill and Chrome extension in dist/.');
