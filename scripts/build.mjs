import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_VERSION, RUNTIME_PROTOCOL } from '../skills/weixin-channels-video/scripts/runtime-support.mjs';

const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = join(root, 'skills/weixin-channels-video');
const dist = join(root, 'dist');
const extensionSource = join(root, 'extension');
const extensionOutput = join(dist, 'extension');
const skillOutput = join(dist, 'weixin-channels-video');
const releaseOutput = join(dist, 'release');
const releasePackage = process.argv.includes('--release');

const EXTENSION_ASSETS = [
  'manifest.json',
  'index.html',
  'styles.css',
  'background.js',
  'agent.js',
  'offscreen.html',
  'offscreen.js',
  'yuanbao-frame.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/copy.svg',
  'icons/terminal.svg',
  'icons/agents/codex.png',
  'icons/agents/claude-code.png',
  'icons/agents/workbuddy.svg',
  'icons/agents/doubao-work.png',
  'icons/agents/qwen-work.png',
  'icons/agents/trae.png',
];

const manifest = JSON.parse(await readFile(join(extensionSource, 'manifest.json'), 'utf8'));
validateChromeVersion(manifest.version);

await rm(extensionOutput, { recursive: true, force: true });
await rm(skillOutput, { recursive: true, force: true });
await mkdir(join(skillOutput, 'scripts'), { recursive: true });
await cp(join(skill, 'SKILL.md'), join(skillOutput, 'SKILL.md'));
await cp(join(root, 'LICENSE'), join(skillOutput, 'LICENSE'));
await cp(join(root, 'NOTICE.md'), join(skillOutput, 'NOTICE.md'));
await cp(join(skill, 'scripts/run.mjs'), join(skillOutput, 'scripts/run.mjs'));
await cp(join(skill, 'scripts/runtime-support.mjs'), join(skillOutput, 'scripts/runtime-support.mjs'));
await cp(join(skill, 'scripts/windows-security.mjs'), join(skillOutput, 'scripts/windows-security.mjs'));
try {
  await access(join(skill, 'references'));
  await cp(join(skill, 'references'), join(skillOutput, 'references'), { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await writeFile(join(skillOutput, 'runtime.json'), `${JSON.stringify({
  version: manifest.version,
  runtimeProtocol: RUNTIME_PROTOCOL,
  minimumNodeVersion: MIN_NODE_VERSION,
}, null, 2)}\n`);
await build({
  entryPoints: [join(skill, 'scripts/cli.mjs')],
  outfile: join(skillOutput, 'scripts/cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
});
await build({
  entryPoints: [join(root, 'src/native-host.mjs')],
  outfile: join(skillOutput, 'scripts/native-host.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
});
await build({
  entryPoints: [join(extensionSource, 'background.mjs')],
  outfile: join(extensionSource, 'background.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
});
await build({
  entryPoints: [join(extensionSource, 'agent.mjs')],
  outfile: join(extensionSource, 'agent.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
});
await build({
  entryPoints: [join(extensionSource, 'offscreen.mjs')],
  outfile: join(extensionSource, 'offscreen.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
});
await rm(join(extensionSource, 'app.js'), { force: true });
await copyExtensionAssets(extensionOutput);
await copyExtensionAssets(join(skillOutput, 'assets/extension'));
await cp(join(root, 'LICENSE'), join(extensionOutput, 'LICENSE'));
await cp(join(root, 'LICENSE'), join(skillOutput, 'assets/extension/LICENSE'));
await cp(join(root, 'NOTICE.md'), join(extensionOutput, 'NOTICE.md'));
await cp(join(root, 'NOTICE.md'), join(skillOutput, 'assets/extension/NOTICE.md'));

if (releasePackage) {
  const { stdout, stderr } = await execFileAsync('python3', [
    join(root, 'scripts/package-release.py'),
    '--output-dir', releaseOutput,
  ], { cwd: root });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} else {
  console.log('Built standalone Skill and Chrome extension in dist/.');
}

async function copyExtensionAssets(destination) {
  await mkdir(destination, { recursive: true });
  for (const file of EXTENSION_ASSETS) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(extensionSource, file), target);
  }
}

function validateChromeVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version)) {
    throw new Error(`Invalid Chrome extension version: ${String(version)}`);
  }
  if (version.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Chrome extension version components must be at most 65535: ${version}`);
  }
}
