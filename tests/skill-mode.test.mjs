import test from 'node:test';
import assert from 'node:assert/strict';
import { selectExecution } from '../skills/weixin-channels-video/scripts/select-mode.mjs';

test('auto mode uses authenticated built-in browser without creating Chrome request', async () => {
  let chromeCreated = false;
  const selected = await selectExecution({
    builtin: { available: true, request: 'built-in' },
    chrome: { available: true, getRequest: async () => { chromeCreated = true; return 'chrome'; } },
    checkLogin: async (request) => ({ status: request === 'built-in' ? 'authenticated' : 'anonymous' }),
  });
  assert.deepEqual(selected, { mode: 'builtin', request: 'built-in', login: { status: 'authenticated' } });
  assert.equal(chromeCreated, false);
});

test('auto mode tries Chrome only after built-in reports anonymous', async () => {
  const checked = [];
  const selected = await selectExecution({
    builtin: { available: true, request: 'built-in' },
    chrome: { available: true, getRequest: async () => 'chrome' },
    checkLogin: async (request) => { checked.push(request); return { status: request === 'chrome' ? 'authenticated' : 'anonymous' }; },
  });
  assert.deepEqual(checked, ['built-in', 'chrome']);
  assert.equal(selected.mode, 'chrome');
});

test('a failed built-in login check stops selection instead of reading Chrome cookies', async () => {
  let chromeCreated = false;
  await assert.rejects(selectExecution({
    builtin: { available: true, request: 'built-in' },
    chrome: { available: true, getRequest: async () => { chromeCreated = true; return 'chrome'; } },
    checkLogin: async () => { throw new Error('LOGIN_CHECK_FAILED'); },
  }), /LOGIN_CHECK_FAILED/);
  assert.equal(chromeCreated, false);
});

test('an invalid login result is a failure and explicit mode does not fall back', async () => {
  let checked = 0;
  await assert.rejects(selectExecution({
    mode: 'builtin',
    builtin: { available: true, request: 'built-in' },
    chrome: { available: true, getRequest: async () => 'chrome' },
    checkLogin: async () => { checked += 1; return { status: 'unknown' }; },
  }), /Login check failed/);
  assert.equal(checked, 1);
});

test('an anonymous built-in remains the selected mode if Chrome is unavailable', async () => {
  const selected = await selectExecution({
    builtin: { available: true, request: 'built-in' },
    chrome: { available: false, getRequest: async () => assert.fail('must not read Chrome') },
    checkLogin: async () => ({ status: 'anonymous' }),
  });
  assert.equal(selected.mode, 'builtin');
  assert.equal(selected.login.status, 'anonymous');
});
