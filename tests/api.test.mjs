import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiHandler } from '../src/api.mjs';

const secret = { apiToken: 'test-api-token', yuanbaoCookie: 'test-cookie=value' };

function request(path = '/parse', options = {}) {
  return new Request(`https://api.example${path}`, options);
}

function handler() {
  return createApiHandler({ ...secret, fetchImpl: async () => { throw new Error('unexpected upstream request'); } });
}

test('rejects incomplete deployment credentials', () => {
  assert.throws(() => createApiHandler({ apiToken: '', yuanbaoCookie: secret.yuanbaoCookie }), /Both API_TOKEN and YUANBAO_COOKIE/);
  assert.throws(() => createApiHandler({ apiToken: secret.apiToken, yuanbaoCookie: '' }), /Both API_TOKEN and YUANBAO_COOKIE/);
});

test('accepts only POST /parse without query parameters', async () => {
  const handle = handler();
  const method = await handle(request('/parse', { method: 'GET' }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.deepEqual(await method.json(), { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for /parse.' } });

  const path = await handle(request('/other', { method: 'POST' }));
  assert.equal(path.status, 404);
  const query = await handle(request('/parse?url=ignored', { method: 'POST' }));
  assert.equal(query.status, 400);
});

test('requires a valid service bearer token before reading the body', async () => {
  const handle = handler();
  const response = await handle(request('/parse', { method: 'POST', body: 'not json' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'API_UNAUTHORIZED', message: 'A valid bearer token is required.' } });
});

test('rejects unsupported content types, invalid JSON and oversized bodies', async () => {
  const handle = handler();
  const headers = { authorization: `Bearer ${secret.apiToken}` };
  const mediaType = await handle(request('/parse', { method: 'POST', headers, body: '{}' }));
  assert.equal(mediaType.status, 415);

  const malformed = await handle(request('/parse', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{',
  }));
  assert.equal(malformed.status, 400);

  const oversized = await handle(request('/parse', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'content-length': '8193' },
    body: '{}',
  }));
  assert.equal(oversized.status, 413);
});

test('returns shared-core results without forwarding caller credentials upstream', async () => {
  const calls = [];
  const responses = [
    Response.json({ userId: 'user-1', needRefreshToken: false, anonUser: { isAnon: false } }),
    Response.json({ code: 0, data: { playable_url: 'https://channels.weixin.qq.com/video?token=general-token&eid=export-id' } }),
    Response.json({ data: {
      feedInfo: {
        description: 'Video title',
        h264VideoInfo: { videoUrl: 'https://video.example/video.mp4' },
        picInfo: [{ url: 'https://video.example/cover.jpg' }],
      },
      authorInfo: { nickname: 'Creator' },
    } }),
  ];
  const handle = createApiHandler({
    ...secret,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return responses.shift();
    },
  });

  const response = await handle(request('/parse', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret.apiToken}`,
      cookie: 'caller-cookie=must-not-forward',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://weixin.qq.com/sph/share-id' }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: {
    sourceUrl: 'https://weixin.qq.com/sph/share-id',
    title: 'Video title',
    author: 'Creator',
    coverUrl: 'https://video.example/cover.jpg',
    previewUrl: 'https://video.example/video.mp4',
    downloadUrl: 'https://video.example/video.mp4',
    mediaVariants: [{ label: 'H.264', downloadUrl: 'https://video.example/video.mp4' }],
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.get('cookie'), secret.yuanbaoCookie);
  assert.equal(calls[1].init.headers.get('cookie'), secret.yuanbaoCookie);
  assert.equal(calls[2].init.headers.has('cookie'), false);
  assert.equal(calls.some(({ init }) => init.headers.has('authorization')), false);
  assert.equal(calls.some(({ init }) => init.headers.get('cookie') === 'caller-cookie=must-not-forward'), false);
  assert.ok(calls.every(({ init }) => init.redirect === 'manual'));
});

test('maps an expired deployment login to the core error code and 401 status', async () => {
  const handle = createApiHandler({
    ...secret,
    fetchImpl: async () => Response.json({ userId: '', needRefreshToken: true, anonUser: { isAnon: true } }),
  });
  const response = await handle(request('/parse', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://weixin.qq.com/sph/share-id' }),
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'AUTH_EXPIRED', message: '元宝登录已失效，请重新登录。' } });
});

test('maps an unavailable feed to 404 and preserves the core error code', async () => {
  const responses = [
    Response.json({ userId: 'user-1', needRefreshToken: false, anonUser: { isAnon: false } }),
    Response.json({ code: 0, data: { playable_url: 'https://channels.weixin.qq.com/video?token=general-token&eid=export-id' } }),
    Response.json({ errCode: 1 }),
  ];
  const handle = createApiHandler({ ...secret, fetchImpl: async () => responses.shift() });
  const response = await handle(request('/parse', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://weixin.qq.com/sph/share-id' }),
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: 'FEED_UNAVAILABLE', message: '视频内容不可用。' } });
});
