import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveExistingFile, saveMedia } from '../skills/weixin-channels-video/scripts/save-media.mjs';

async function temporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'weixin-skill-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('media is streamed to the destination without leaving a temporary file', async () => {
  await temporaryDirectory(async (directory) => {
    const output = join(directory, 'video.mp4');
    const result = await saveMedia('https://media.invalid/video', output, async () => new Response(Buffer.from('media'), {
      headers: { 'content-type': 'video/mp4' },
    }));
    assert.equal(result.bytes, 5);
    assert.equal(await readFile(output, 'utf8'), 'media');
    assert.deepEqual(await readdir(directory), ['video.mp4']);
  });
});

test('saving never replaces an existing destination and cleans its temporary file', async () => {
  await temporaryDirectory(async (directory) => {
    const output = join(directory, 'video.mp4');
    await writeFile(output, 'keep');
    await assert.rejects(saveMedia('https://media.invalid/video', output, async () => new Response('new', {
      headers: { 'content-type': 'video/mp4' },
    })), { code: 'EEXIST' });
    assert.equal(await readFile(output, 'utf8'), 'keep');
    assert.deepEqual(await readdir(directory), ['video.mp4']);
  });
});

test('an empty source is rejected and a local media file uses the same no-overwrite save path', async () => {
  await temporaryDirectory(async (directory) => {
    const source = join(directory, 'source.mp4');
    await writeFile(source, '');
    await assert.rejects(saveExistingFile(source, join(directory, 'empty.mp4')), /empty or unavailable/);
    await writeFile(source, 'media');
    const result = await saveExistingFile(source, join(directory, 'copy.mp4'));
    assert.equal(result.bytes, 5);
    assert.equal(await readFile(join(directory, 'copy.mp4'), 'utf8'), 'media');
  });
});

test('known non-media text responses are rejected before saving', async () => {
  await temporaryDirectory(async (directory) => {
    await assert.rejects(saveMedia('https://media.invalid/video', join(directory, 'video.mp4'), async () => new Response('<html>', {
      headers: { 'content-type': 'text/html' },
    })), /text response/);
    assert.deepEqual(await readdir(directory), []);
  });
});
