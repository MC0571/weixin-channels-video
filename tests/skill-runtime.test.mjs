import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { skillArchive, tarEntry } from './fixtures/skill-archive.mjs';
import {
  MIN_NODE_VERSION,
  RUNTIME_PROTOCOL,
  parseSkillArchive,
  platformCacheRoot,
  supportsNodeVersion,
  unpackSkillArchive,
} from '../skills/weixin-channels-video/scripts/run.mjs';

const validArchive = () => skillArchive([
  ['weixin-channels-video', '', '5'],
  ['weixin-channels-video/scripts', '', '5'],
  ['weixin-channels-video/scripts/cli.mjs', 'export const version = 1;'],
]);

test('runner declares the tested Node minimum and platform cache roots', () => {
  assert.equal(RUNTIME_PROTOCOL, 2);
  assert.equal(MIN_NODE_VERSION, '22.22.2');
  assert.equal(supportsNodeVersion('22.22.1'), false);
  assert.equal(supportsNodeVersion('22.22.2'), true);
  assert.equal(supportsNodeVersion('22.23.0'), true);
  assert.equal(supportsNodeVersion('23.0.0'), true);
  assert.equal(supportsNodeVersion('22.22.2-pre'), false);
  assert.equal(
    platformCacheRoot({
      platform: 'win32',
      home: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    }),
    win32.join('C:\\Users\\tester\\AppData\\Local', 'weixin-channels-video', 'skill-runtime'),
  );
  assert.equal(
    platformCacheRoot({ platform: 'darwin', home: '/Users/tester', env: {} }),
    join('/Users/tester', 'Library', 'Caches', 'weixin-channels-video', 'skill-runtime'),
  );
  assert.equal(platformCacheRoot({ platform: 'linux' }), null);
});

test('runner parses and safely unpacks the packaged USTAR gzip resource', async () => {
  const archive = validArchive();
  const members = parseSkillArchive(archive);
  assert.equal(members.get('weixin-channels-video/scripts/cli.mjs')?.data.toString(), 'export const version = 1;');

  const parent = await mkdtemp(join(tmpdir(), 'skill-runtime-'));
  try {
    const destination = join(parent, 'payload');
    await unpackSkillArchive(archive, destination);
    assert.equal(
      await readFile(join(destination, 'weixin-channels-video/scripts/cli.mjs'), 'utf8'),
      'export const version = 1;',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('runner rejects path traversal, links, duplicate portable names, and malformed TAR terminators', () => {
  assert.throws(() => parseSkillArchive(skillArchive([
    ['weixin-channels-video', '', '5'],
    ['weixin-channels-video/../outside', 'x'],
  ])), /越界路径/);
  assert.throws(() => parseSkillArchive(skillArchive([
    ['weixin-channels-video', '', '5'],
    ['weixin-channels-video/link', '', '2'],
  ])), /普通文件和目录/);
  assert.throws(() => parseSkillArchive(skillArchive([
    ['weixin-channels-video', '', '5'],
    ['weixin-channels-video/a', 'one'],
    ['weixin-channels-video/A', 'two'],
  ])), /重复路径/);

  const brokenEnd = Buffer.concat([
    tarEntry('weixin-channels-video', '', '5'),
    Buffer.alloc(1024),
  ]);
  brokenEnd[512] = 1;
  assert.throws(() => parseSkillArchive(gzipSync(brokenEnd)));
});
