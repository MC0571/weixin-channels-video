import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker/index.mjs';

test('Worker reports missing deployment secrets explicitly', async () => {
  const response = await worker.fetch(new Request('https://worker.example/parse'), {});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'SERVER_MISCONFIGURED',
      message: 'Both API_TOKEN and YUANBAO_COOKIE must be configured.',
    },
  });
});

test('Worker uses request-scoped bindings and the shared API handler', async () => {
  const response = await worker.fetch(new Request('https://worker.example/parse', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token' },
    body: 'not json',
  }), { API_TOKEN: 'configured-token', YUANBAO_COOKIE: 'test-cookie=value' });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: { code: 'API_UNAUTHORIZED', message: 'A valid bearer token is required.' },
  });
});
