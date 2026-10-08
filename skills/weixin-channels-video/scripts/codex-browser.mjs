import { API_URLS, checkLogin, parseShareLink } from '../../../src/core.mjs';

// CDP handles stay in the host runtime; response bodies must never be printed.
export function createBrowserRequest({ yuanbaoCdp, channelsCdp }) {
  return async (value, init = {}) => {
    const url = new URL(value);
    const target = `${url.origin}${url.pathname}`;
    if (!Object.values(API_URLS).includes(target)) throw new Error('Unsupported browser request.');
    const cdp = url.origin === new URL(API_URLS.userInfo).origin ? yuanbaoCdp : channelsCdp;
    if (!cdp) throw new Error('Required browser origin is unavailable.');
    const headers = new Headers(init.headers);
    for (const name of ['cookie', 'authorization', 'origin', 'referer']) headers.delete(name);
    const options = {
      method: init.method || 'GET',
      headers: Object.fromEntries(headers),
      ...(init.body === undefined ? {} : { body: init.body }),
      credentials: url.origin === new URL(API_URLS.userInfo).origin ? 'include' : 'omit',
      redirect: 'error',
      ...(url.origin === 'https://channels.weixin.qq.com' && init.headers?.referer
        ? { referrer: init.headers.referer }
        : {}),
    };
    let result;
    try {
      result = await cdp.send('Runtime.evaluate', {
        expression: `(async()=>{const r=await fetch(${JSON.stringify(url.href)},${JSON.stringify(options)});return {status:r.status,body:await r.json()}})()`,
        awaitPromise: true,
        returnByValue: true,
      });
    } catch {
      throw new Error('Browser request failed.');
    }
    if (result.exceptionDetails || !result.result?.value) throw new Error('Browser request failed.');
    const { status, body } = result.result.value;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
}

export async function checkBrowserLogin(yuanbaoCdp) {
  return checkLogin(createBrowserRequest({ yuanbaoCdp }));
}

export async function parseInBrowser(url, handles) {
  return parseShareLink(url, { request: createBrowserRequest(handles) });
}

export async function downloadInBrowser(result, tab) {
  const cdp = await tab.capabilities.get('cdp');
  const id = `wx-channels-download-${Math.random().toString(36).slice(2)}`;
  await cdp.send('Runtime.evaluate', {
    expression: `(()=>{const a=document.createElement('a');a.id=${JSON.stringify(id)};a.textContent='下载已解析视频';a.href=${JSON.stringify(result.downloadUrl)};a.download='video.mp4';document.body.append(a)})()`,
  });
  try {
    return await tab.playwright.locator(`#${id}`).downloadMedia({ timeoutMs: 120000 });
  } finally {
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)})?.remove()` });
  }
}
