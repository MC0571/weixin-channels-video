import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { checkBrowserLogin, createBrowserRequest, downloadInBrowser } from '../skills/weixin-channels-video/scripts/codex-browser.mjs';

test('browser login uses its session without returning user identity', async () => {
  const cdp = { async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    assert.match(params.expression, /"credentials":"include"/);
    return { result: { value: { status: 200, text: JSON.stringify({ userId: 'synthetic', anonUser: { isAnon: false }, needRefreshToken: false }) } } };
  } };
  assert.deepEqual(await checkBrowserLogin(cdp), { status: 'authenticated' });
});

test('browser request failures redact runtime exceptions and refuse unrelated endpoints', async () => {
  const request = createBrowserRequest({ yuanbaoCdp: { async send() { throw new Error('synthetic-private'); } } });
  await assert.rejects(request('https://yuanbao.tencent.com/api/getuserinfo'), e => e.message === 'Browser request failed.');
  await assert.rejects(request('https://other.example/api/getuserinfo'), /Unsupported/);
});

test('empty auth failures are anonymous, while malformed successful JSON fails the check', async () => {
  function cdpReturning(status, text) {
    return { async send(method, params) {
      return { result: { value: await runInNewContext(params.expression, { fetch: async () => new Response(text, { status }) }) } };
    } };
  }
  assert.deepEqual(await checkBrowserLogin(cdpReturning(401, '')), { status: 'anonymous' });
  await assert.rejects(checkBrowserLogin(cdpReturning(200, '<html>Error</html>')), e => e.code === 'LOGIN_CHECK_FAILED');
});

test('native media save returns a file path and removes its temporary link', async () => {
  const expressions = [];
  const tab = {
    capabilities: { async get() { return { async send(method, params) { expressions.push(params.expression); } }; } },
    playwright: { locator() { return { async downloadMedia() { return '/tmp/synthetic-video.mp4'; } }; } },
  };
  assert.equal(await downloadInBrowser({ downloadUrl: 'https://media.example/video.mp4' }, tab), '/tmp/synthetic-video.mp4');
  assert.equal(expressions.length, 2);
  assert.match(expressions.at(-1), /remove/);
});
