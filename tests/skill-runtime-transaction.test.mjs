import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skillArchive } from './fixtures/skill-archive.mjs';
import { installBridge } from '../skills/weixin-channels-video/scripts/bridge-install.mjs';
import { assertWindowsPrivatePath, secureWindowsPath } from '../skills/weixin-channels-video/scripts/windows-security.mjs';

const supportedPlatform = process.platform === 'darwin' || process.platform === 'win32';

async function assertPrivateTree(path) {
  if (process.platform !== 'win32') return;
  await assertWindowsPrivatePath(path, { directory: true });
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child);
    if (info.isDirectory()) await assertPrivateTree(child);
    else await assertWindowsPrivatePath(child);
  }
}

function makeRelease(version, runtimeProtocol = 2, corruptChecksum = false) {
  const archiveName = 'weixin-channels-video-skill-v' + version + '.tar.gz';
  const skillZipName = 'weixin-channels-video-skill-v' + version + '.zip';
  const extensionZipName = 'weixin-channels-video-extension-v' + version + '.zip';
  const baseUrl = 'https://github.com/MC0571/weixin-channels-video/releases/download/v' + version;
  const archive = skillArchive([
    ['weixin-channels-video', '', '5'],
    ['weixin-channels-video/assets', '', '5'],
    ['weixin-channels-video/assets/extension', '', '5'],
    ['weixin-channels-video/scripts', '', '5'],
    ['weixin-channels-video/runtime.json', JSON.stringify({
      version,
      runtimeProtocol,
      minimumNodeVersion: '22.22.2',
    })],
    ['weixin-channels-video/scripts/cli.mjs', 'export {};'],
    ['weixin-channels-video/scripts/native-host.mjs', 'export {};'],
    ['weixin-channels-video/assets/extension/manifest.json', JSON.stringify({ version })],
  ]);
  const hash = corruptChecksum
    ? '0'.repeat(64)
    : createHash('sha256').update(archive).digest('hex');
  const checksums = Buffer.from(hash + '  ' + archiveName + '\n');
  const makeAsset = (name, bytes, contentType) => ({
    name,
    size: bytes.length,
    content_type: contentType,
    browser_download_url: baseUrl + '/' + name,
  });
  const release = {
    tag_name: 'v' + version,
    draft: false,
    prerelease: false,
    assets: [
      makeAsset(archiveName, archive, 'application/gzip'),
      makeAsset(skillZipName, Buffer.from('zip'), 'application/zip'),
      makeAsset(extensionZipName, Buffer.from('zip'), 'application/zip'),
      makeAsset('SHA256SUMS', checksums, 'text/plain'),
    ],
  };
  return { archive, archiveName, baseUrl, checksums, release };
}

function response(body, contentType) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Response(bytes, {
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.length),
    },
  });
}

test('Release preparation migrates legacy assets and rolls back checksum, protocol, and marker-write failures', {
  skip: !supportedPlatform,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'skill-runtime-transaction-'));
  const originalHome = process.env.HOME;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  if (process.platform === 'win32') process.env.LOCALAPPDATA = join(tempRoot, 'LocalAppData');
  else process.env.HOME = tempRoot;

  try {
    const runtime = await import('../skills/weixin-channels-video/scripts/run.mjs');
    const legacyRoot = runtime.platformCacheRoot();
    const cacheRoot = join(legacyRoot, 'protocol-' + runtime.RUNTIME_PROTOCOL);
    const versionRoot = join(legacyRoot, '0.1.1');
    const assetsRoot = join(versionRoot, 'assets');
    const oldExtension = join(assetsRoot, 'extension');
    const oldManifest = join(oldExtension, 'manifest.json');
    const legacyMarker = join(legacyRoot, 'current.json');
    if (process.platform === 'win32') {
      await mkdir(join(tempRoot, 'LocalAppData', 'weixin-channels-video'), { recursive: true });
      for (const directory of [legacyRoot, versionRoot, assetsRoot, oldExtension]) {
        await mkdir(directory, { recursive: false });
        await secureWindowsPath(directory, { directory: true, newlyCreated: true });
      }
    } else {
      await mkdir(oldExtension, { recursive: true });
    }
    await writeFile(oldManifest, JSON.stringify({ version: '0.1.1' }), { flag: 'wx' });
    await writeFile(legacyMarker, JSON.stringify({
      version: '0.1.1',
      runtimeProtocol: 1,
    }), { flag: 'wx' });
    if (process.platform === 'win32') {
      await secureWindowsPath(oldManifest, { newlyCreated: true });
      await secureWindowsPath(legacyMarker, { newlyCreated: true });
    }

    let activeRelease = makeRelease('0.2.0');
    const releasesApi = 'https://api.github.com/repos/MC0571/weixin-channels-video/releases/latest';
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === releasesApi) {
        return response(JSON.stringify(activeRelease.release), 'application/vnd.github+json');
      }
      if (url === activeRelease.baseUrl + '/SHA256SUMS') {
        return response(activeRelease.checksums, 'text/plain');
      }
      if (url === activeRelease.baseUrl + '/' + activeRelease.archiveName) {
        return response(activeRelease.archive, 'application/gzip');
      }
      throw new Error('Unexpected runtime test URL: ' + url);
    };

    async function prepare() {
      const output = [];
      process.stdout.write = (chunk) => {
        output.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return true;
      };
      try {
        assert.equal(await runtime.run(['prepare']), 0);
        return JSON.parse(output.join(''));
      } finally {
        process.stdout.write = originalWrite;
      }
    }

    async function assertCommitted(version, markerText) {
      assert.equal(await readFile(join(cacheRoot, version, 'runtime.json'), 'utf8').then((text) => JSON.parse(text).version), version);
      assert.equal(await readFile(join(cacheRoot, 'current.json'), 'utf8'), markerText);
      assert.equal(await readFile(join(oldExtension, 'manifest.json'), 'utf8').then((text) => JSON.parse(text).version), version);
    }

    const prepared = await prepare();
    assert.equal(prepared.version, '0.2.0');
    assert.equal(prepared.extensionAssets, oldExtension);
    const committedMarker = await readFile(join(cacheRoot, 'current.json'), 'utf8');
    assert.deepEqual(JSON.parse(committedMarker), {
      version: '0.2.0',
      runtimeProtocol: 2,
      extensionLocation: 'legacy:0.1.1',
    });
    await assertCommitted('0.2.0', committedMarker);
    if (process.platform === 'win32') {
      await assertPrivateTree(cacheRoot);
      await assertPrivateTree(oldExtension);
    }

    activeRelease = makeRelease('0.3.0', 2, true);
    await assert.rejects(prepare(), /SHA256/);
    await assertCommitted('0.2.0', committedMarker);
    await assert.rejects(lstat(join(cacheRoot, '0.3.0')), { code: 'ENOENT' });

    activeRelease = makeRelease('0.4.0', 1);
    await assert.rejects(prepare(), /版本不兼容/);
    await assertCommitted('0.2.0', committedMarker);
    await assert.rejects(lstat(join(cacheRoot, '0.4.0')), { code: 'ENOENT' });
    assert.equal((await readdir(cacheRoot)).some((name) => name.startsWith('.prepare-')), false);

    const incomingExtension = join(tempRoot, 'incoming', 'extension');
    await mkdir(incomingExtension, { recursive: true });
    await writeFile(join(incomingExtension, 'manifest.json'), JSON.stringify({ version: '0.5.0' }));
    await assert.rejects(runtime.materializeRuntime({
      version: '0.5.0',
      extensionAssets: incomingExtension,
    }, {
      writeMarker: async () => { throw new Error('synthetic marker write failure'); },
    }), /synthetic marker write failure/);
    await assertCommitted('0.2.0', committedMarker);
    assert.equal((await readdir(join(legacyRoot, '0.1.1', 'assets'))).some((name) =>
      name.startsWith('.extension-stage-') || name.startsWith('.extension-previous-')), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows release preparation protects the shared bridge storage root', {
  skip: process.platform !== 'win32',
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'skill-runtime-shared-root-'));
  const localAppData = join(tempRoot, 'LocalAppData');
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  await mkdir(localAppData);
  process.env.LOCALAPPDATA = localAppData;

  try {
    const runtimeUrl = new URL('../skills/weixin-channels-video/scripts/run.mjs', import.meta.url);
    runtimeUrl.searchParams.set('fixture', 'shared-bridge-storage-root');
    const runtime = await import(runtimeUrl);
    const appSupportRoot = join(localAppData, 'weixin-channels-video');
    await assert.rejects(lstat(appSupportRoot), { code: 'ENOENT' });

    const activeRelease = makeRelease('0.6.0');
    const releasesApi = 'https://api.github.com/repos/MC0571/weixin-channels-video/releases/latest';
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === releasesApi) {
        return response(JSON.stringify(activeRelease.release), 'application/vnd.github+json');
      }
      if (url === activeRelease.baseUrl + '/SHA256SUMS') {
        return response(activeRelease.checksums, 'text/plain');
      }
      if (url === activeRelease.baseUrl + '/' + activeRelease.archiveName) {
        return response(activeRelease.archive, 'application/gzip');
      }
      throw new Error('Unexpected shared-root runtime test URL: ' + url);
    };

    const output = [];
    process.stdout.write = (chunk) => {
      output.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };
    try {
      assert.equal(await runtime.run(['prepare']), 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    assert.equal(JSON.parse(output.join('')).version, '0.6.0');
    await assertWindowsPrivatePath(appSupportRoot, { directory: true });

    const chromeUserDataDir = join(tempRoot, 'Chrome User Data');
    await mkdir(join(chromeUserDataDir, 'Default'), { recursive: true });
    await writeFile(join(chromeUserDataDir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Default' } } },
    }), { flag: 'wx' });
    let registeredPath = null;
    const installed = await installBridge({
      extensionId: 'a'.repeat(32),
      profile: 'Default',
      appSupportDir: appSupportRoot,
      chromeUserDataDir,
      nodeExecutable: process.execPath,
      platform: 'win32',
      registry: {
        async read() { return registeredPath; },
        async write(_key, path) { registeredPath = path; },
        async remove(_key, expectedPath) {
          if (registeredPath === expectedPath) registeredPath = null;
        },
      },
    });
    assert.equal(installed.config.appSupportDir, appSupportRoot);
    assert.equal(registeredPath, installed.hostManifestPath);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
