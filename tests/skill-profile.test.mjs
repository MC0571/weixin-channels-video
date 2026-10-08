import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChromeProfiles, resolveChromeProfile } from '../skills/weixin-channels-video/scripts/chrome-profile.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'weixin-profile-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addProfile(root, directory, name) {
  await mkdir(join(root, directory, 'Network'), { recursive: true });
  await writeFile(join(root, directory, 'Network', 'Cookies'), 'metadata-only fixture');
  let state;
  try { state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')); }
  catch { state = { profile: { info_cache: {} } }; }
  state.profile.info_cache[directory] = { name };
  await writeFile(join(root, 'Local State'), JSON.stringify(state));
}

test('profile listing reads metadata and an ambiguous default requires a choice', async () => {
  await fixture(async (root) => {
    await addProfile(root, 'Default', 'Work');
    await addProfile(root, 'Profile 2', 'Personal');
    assert.deepEqual(await listChromeProfiles(root), [
      { directory: 'Default', name: 'Work' },
      { directory: 'Profile 2', name: 'Personal' },
    ]);
    await assert.rejects(resolveChromeProfile(undefined, root), /Choose a Chrome profile/);
    assert.equal((await resolveChromeProfile('Personal', root)).directory, 'Profile 2');
  });
});

test('a single profile is selected without assuming a profile number', async () => {
  await fixture(async (root) => {
    await addProfile(root, 'Default', 'Only profile');
    const selected = await resolveChromeProfile(undefined, root);
    assert.equal(selected.directory, 'Default');
    assert.equal(selected.cookieDb, join(root, 'Default', 'Network', 'Cookies'));
  });
});
