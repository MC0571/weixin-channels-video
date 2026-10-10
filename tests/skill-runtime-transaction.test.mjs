import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skillArchive } from './fixtures/skill-archive.mjs';

const supportedPlatform = process.platform === 'darwin' || process.platform === 'win32';

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
    const oldExtension = join(legacyRoot, '0.1.1', 'assets', 'extension');
    await mkdir(oldExtension, { recursive: true });
    await writeFile(join(oldExtension, 'manifest.json'), JSON.stringify({ version: '0.1.1' }));
    await writeFile(join(legacyRoot, 'current.json'), JSON.stringify({
      version: '0.1.1',
      runtimeProtocol: 1,
    }));

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
