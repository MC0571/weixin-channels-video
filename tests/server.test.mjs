import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeServer } from '../server/index.mjs';

test('Node HTTP adapter passes request bodies through the shared API handler', async () => {
  const server = createNodeServer({
    apiToken: 'test-api-token',
    yuanbaoCookie: 'test-cookie=value',
    fetchImpl: async () => { throw new Error('unexpected upstream request'); },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/parse`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-api-token',
        'content-type': 'application/json',
      },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: 'INVALID_REQUEST', message: 'Request body must be JSON with a non-empty url string.' },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
