import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChromeProfiles, selectChromeProfile } from '../skills/weixin-channels-video/scripts/chrome-profile.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'weixin-profile-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addProfile(root, directory, name) {
  await mkdir(join(root, directory), { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')); }
  catch { state = { profile: { info_cache: {} } }; }
  state.profile.info_cache[directory] = { name };
  await writeFile(join(root, 'Local State'), JSON.stringify(state));
}

test('profile listing and selection use metadata without reading cookie databases', async () => {
  await fixture(async (root) => {
    await addProfile(root, 'Default', 'Work');
    await addProfile(root, 'Profile 2', 'Personal');
    assert.deepEqual(await listChromeProfiles(root), [
      { directory: 'Default', name: 'Work' },
      { directory: 'Profile 2', name: 'Personal' },
    ]);
    await assert.rejects(selectChromeProfile(undefined, root), /Choose a Chrome profile/);
    assert.deepEqual(await selectChromeProfile('Personal', root), {
      directory: 'Profile 2',
      name: 'Personal',
      profileDirectory: join(root, 'Profile 2'),
    });
    assert.equal((await selectChromeProfile('Default', root)).directory, 'Default');
  });
});
