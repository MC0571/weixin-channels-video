import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createExtensionRequest,
  downloadStatus,
  latestDownload,
  safeFilename,
  startDownload,
} from "../extension/app.mjs";
import { API_URLS } from "../src/core.mjs";

function createHiddenIframeHarness() {
  const iframeListeners = new Map();
  const messageListeners = new Set();
  const requestMessages = [];
  let removeCount = 0;
  let timeoutCallback;
  let timeoutCleared = false;
  const iframe = {
    contentWindow: {
      postMessage(message, targetOrigin) {
        requestMessages.push({ message, targetOrigin });
      },
    },
    addEventListener(type, listener) {
      if (!iframeListeners.has(type)) iframeListeners.set(type, new Set());
      iframeListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      iframeListeners.get(type)?.delete(listener);
    },
    setAttribute() {},
    remove() { removeCount += 1; },
    dispatch(type) {
      for (const listener of [...(iframeListeners.get(type) ?? [])]) listener();
    },
  };
  const windowApi = {
    crypto: { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" },
    addEventListener(type, listener) {
      assert.equal(type, "message");
      messageListeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "message");
      messageListeners.delete(listener);
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 15_000);
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout(timeoutId) {
      assert.equal(timeoutId, 1);
      timeoutCleared = true;
    },
  };
  const documentApi = {
    createElement(tag) {
      assert.equal(tag, "iframe");
      return iframe;
    },
    body: {
      append(element) {
        assert.equal(element, iframe);
        element.dispatch("load");
      },
    },
  };

  return {
    documentApi,
    windowApi,
    iframe,
    requestMessages,
    dispatchMessage(message, source = iframe.contentWindow, origin = "https://yuanbao.tencent.com") {
      for (const listener of [...messageListeners]) listener({ data: message, source, origin });
    },
    expire() { timeoutCallback(); },
    get state() {
      return {
        iframeRemoved: removeCount === 1,
        iframeLoadListeners: iframeListeners.get("load")?.size ?? 0,
        iframeErrorListeners: iframeListeners.get("error")?.size ?? 0,
        messageListeners: messageListeners.size,
        timeoutCleared,
      };
    },
  };
}

async function withHiddenIframeHarness(harness, callback) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: harness.documentApi });
  Object.defineProperty(globalThis, "window", { configurable: true, value: harness.windowApi });
  try {
    return await callback();
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
}

async function withBackgroundHarness({ fetchImpl, timerApi } = {}, callback) {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const previousSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const previousClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  const extensionId = "synthetic-extension-id";
  const rules = new Map();
  const updates = [];
  const fetchCalls = [];
  let messageListener;
  const chromeApi = {
    runtime: {
      id: extensionId,
      getURL: (path) => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener: (listener) => { messageListener = listener; } },
    },
    declarativeNetRequest: {
      updateSessionRules: async (change) => {
        updates.push(structuredClone(change));
        for (const id of change.removeRuleIds ?? []) rules.delete(id);
        for (const rule of change.addRules ?? []) rules.set(rule.id, structuredClone(rule));
      },
    },
    action: { onClicked: { addListener() {} } },
    tabs: { create() {} },
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeApi });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      fetchCalls.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : Response.json({ ok: true });
    },
  });
  if (timerApi) {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: timerApi.setTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: timerApi.clearTimeout });
  }

  const restore = (name, descriptor) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
  try {
    await import(`../extension/background.mjs?test=${Date.now()}-${Math.random()}`);
    const defaultSender = {
      id: extensionId,
      frameId: 0,
      url: `chrome-extension://${extensionId}/index.html`,
    };
    const send = (message, sender = defaultSender) => new Promise((resolve) => {
      const handled = messageListener(message, sender, resolve);
      if (handled !== true) resolve(undefined);
    });
    return await callback({ chromeApi, extensionId, fetchCalls, updates, rules, send });
  } finally {
    restore("chrome", previousChrome);
    restore("fetch", previousFetch);
    restore("setTimeout", previousSetTimeout);
    restore("clearTimeout", previousClearTimeout);
  }
}

function createFeedRequest({ rid = "abc123-12345678", token = "synthetic-token", eid = "synthetic-eid" } = {}) {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", rid);
  url.searchParams.set("_pageUrl", pageUrl);
  return {
    type: "weixin-channels-video:feed-request",
    url: url.href,
    referer: `${pageUrl}?eid=${encodeURIComponent(eid)}&tracking=synthetic&token=${encodeURIComponent(token)}`,
    body: JSON.stringify({ baseReq: { generalToken: token }, exportId: eid }),
  };
}

test("extension requests only fixed APIs with isolated credentials and browser-owned headers", async () => {
  const calls = [];
  const request = createExtensionRequest(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true });
  });

  await request(API_URLS.userInfo, {
    method: "GET",
    headers: {
      Origin: "https://yuanbao.tencent.com",
      Referer: "https://yuanbao.tencent.com/chat?private=value",
      Cookie: "must-not-be-set-by-extension-code",
      Authorization: "must-not-cross-origin",
    },
  });
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.has("origin"), false);
  assert.equal(calls[0].init.headers.has("referer"), false);
  assert.equal(calls[0].init.headers.has("cookie"), false);
  assert.equal(calls[0].init.headers.has("authorization"), false);

  await assert.rejects(request("https://attacker.example/collect", { method: "POST" }), TypeError);
  await assert.rejects(request(API_URLS.userInfo, { method: "POST" }), TypeError);
  assert.equal(calls.length, 1);
});

test("hidden Yuanbao iframe requester preserves HTTP status and cleans up", async () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const parseBody = JSON.stringify({
    type: "video_channel_url",
    url: "https://weixin.qq.com/sph/synthetic-id",
    scene: 1,
  });
  const harness = createHiddenIframeHarness();
  await withHiddenIframeHarness(harness, async () => {
    const request = createExtensionRequest(async () => assert.fail("Yuanbao parse must use the hidden iframe"));
    const responsePromise = request(API_URLS.parseShare, { method: "POST", body: parseBody });
    const [{ message, targetOrigin }] = harness.requestMessages;
    assert.equal(harness.iframe.hidden, true);
    assert.equal(harness.iframe.src, "https://yuanbao.tencent.com/");
    assert.equal(harness.iframe.title, "");
    assert.equal(harness.iframe.tabIndex, -1);
    assert.deepEqual({ ...message }, {
      type: "weixin-channels-video:api-request",
      requestId,
      body: parseBody,
    });
    assert.equal(targetOrigin, "https://yuanbao.tencent.com");

    const resultMessage = {
      type: "weixin-channels-video:api-response",
      requestId,
      status: 200,
      body: "{\"code\":0}",
    };
    harness.dispatchMessage(resultMessage, {}, "https://yuanbao.tencent.com");
    harness.dispatchMessage(resultMessage, harness.iframe.contentWindow, "https://attacker.example");
    harness.dispatchMessage({ ...resultMessage, requestId: "223e4567-e89b-42d3-a456-426614174000" });
    assert.equal(harness.state.iframeRemoved, false);
    assert.equal(harness.state.messageListeners, 1);

    harness.dispatchMessage(resultMessage);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "{\"code\":0}");
    assert.deepEqual(harness.state, {
      iframeRemoved: true,
      iframeLoadListeners: 0,
      iframeErrorListeners: 0,
      messageListeners: 0,
      timeoutCleared: true,
    });
  });
});

test("feed request adapter forwards the core request and preserves HTTP 401", async () => {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const referer = `${pageUrl}?eid=synthetic-eid&token=synthetic-token`;
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", "synthetic-rid");
  url.searchParams.set("_pageUrl", pageUrl);
  const body = JSON.stringify({ baseReq: { generalToken: "synthetic-token" }, exportId: "synthetic-eid" });
  const forwarded = [];
  const request = createExtensionRequest(
    async () => assert.fail("feed requests use the background bridge"),
    async () => assert.fail("feed requests do not use the Yuanbao iframe"),
    async (value) => {
      forwarded.push(value);
      return new Response(null, { status: 401 });
    },
  );

  const response = await request(url.href, {
    method: "POST",
    headers: { referer },
    body,
  });
  assert.equal(response.status, 401);
  assert.deepEqual(forwarded, [{ url: url.href, referer, body }]);
});

test("feed request adapter maps background failures to fixed safe messages", async () => {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", "synthetic-rid");
  url.searchParams.set("_pageUrl", pageUrl);
  const referer = `${pageUrl}?token=synthetic-secret&eid=synthetic-eid`;
  const body = JSON.stringify({ baseReq: { generalToken: "synthetic-secret" }, exportId: "synthetic-eid" });
  const previousChrome = globalThis.chrome;
  const messages = [];

  try {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          return { status: 0, body: "", failure: "timeout" };
        },
      },
    };
    const request = createExtensionRequest(async () => assert.fail("feed requests use the background bridge"));
    await assert.rejects(request(url.href, { method: "POST", headers: { referer }, body }), (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "视频详情请求超时。");
      assert.equal(error.message.includes("synthetic-secret"), false);
      return true;
    });
    assert.deepEqual(messages, [{
      type: "weixin-channels-video:feed-request",
      url: url.href,
      referer,
      body,
    }]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("Yuanbao frame bridge routes only the fixed request with browser credentials", async () => {
  const source = await readFile(new URL("../extension/yuanbao-frame.js", import.meta.url), "utf8");
  const extensionOrigin = "chrome-extension://synthetic-extension-id";
  assert.equal(new URL(extensionOrigin + "/").origin, "null");
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const parseBody = JSON.stringify({ type: "video_channel_url" });
  const fetchCalls = [];
  const messages = [];
  const listeners = [];
  const parent = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
  };
  const windowApi = {
    parent,
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.push(listener);
    },
  };
  runInNewContext(source, {
    window: windowApi,
    location: { origin: "https://yuanbao.tencent.com", pathname: "/" },
    chrome: { runtime: { getURL: () => extensionOrigin + "/" } },
    URL,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return { status: 200, ok: true, text: async () => "{\"code\":0}" };
    },
  });

  const requestMessage = {
    type: "weixin-channels-video:api-request",
    requestId,
    body: parseBody,
  };
  const listener = listeners[0];
  listener({ source: {}, origin: extensionOrigin, data: requestMessage });
  listener({ source: parent, origin: "https://attacker.example", data: requestMessage });
  listener({ source: parent, origin: extensionOrigin, data: { ...requestMessage, extra: true } });
  listener({ source: parent, origin: extensionOrigin, data: { ...requestMessage, requestId: "bad" } });
  assert.equal(fetchCalls.length, 0);

  listener({ source: parent, origin: extensionOrigin, data: requestMessage });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, "https://yuanbao.tencent.com/api/weixin/get_parse_result");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, parseBody);
  assert.equal(call.init.credentials, "include");
  assert.equal(call.init.redirect, "error");
  assert.deepEqual({ ...call.init.headers }, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(messages.map(({ message, targetOrigin }) => ({
    message: { ...message },
    targetOrigin,
  })), [{
    message: {
      type: "weixin-channels-video:api-response",
      requestId,
      status: 200,
      body: "{\"code\":0}",
    },
    targetOrigin: extensionOrigin,
  }]);
  listener({ source: parent, origin: extensionOrigin, data: requestMessage });
  assert.equal(fetchCalls.length, 1);
});

test("background feed bridge restricts its sender and API request while preserving the core referer", async () => {
  const request = createFeedRequest();
  await withBackgroundHarness({
    fetchImpl: async () => ({ status: 401, ok: false, text: async () => assert.fail("401 body must not be read") }),
  }, async ({ extensionId, fetchCalls, rules, send, updates }) => {
    const badSender = { id: "other-extension", frameId: 0, url: `chrome-extension://${extensionId}/index.html` };
    const badUrl = { ...request, url: "https://attacker.example/collect" };
    const badRid = { ...request, url: request.url.replace("abc123-12345678", "bad-rid") };
    const badBody = { ...request, body: JSON.stringify({ baseReq: { generalToken: "other-token" }, exportId: "synthetic-eid" }) };
    assert.equal(await send(request, badSender), undefined);
    assert.equal(await send(request, { ...badSender, id: extensionId, frameId: 2 }), undefined);
    assert.equal(await send(request, { id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/other.html` }), undefined);
    assert.equal(await send(badUrl), undefined);
    assert.equal(await send(badRid), undefined);
    assert.equal(await send(badBody), undefined);
    assert.equal(fetchCalls.length, 0);

    const result = await send(request);
    assert.deepEqual(result, { status: 401, body: "" });
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.equal(call.url, request.url);
    assert.equal(call.init.method, "POST");
    assert.deepEqual({ ...call.init.headers }, {
      accept: "application/json",
      "content-type": "application/json",
    });
    assert.equal(call.init.body, request.body);
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "error");
    assert.equal(rules.size, 0);
    assert.equal(updates.length, 3);
    assert.deepEqual(updates[0], { removeRuleIds: [1] });
    assert.deepEqual(updates[1].removeRuleIds, [1]);
    assert.deepEqual(updates[2], { removeRuleIds: [1] });
    assert.deepEqual(updates[1].addRules[0], {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: "https://channels.weixin.qq.com" },
          { header: "Referer", operation: "set", value: request.referer },
        ],
      },
      condition: {
        urlFilter: `|${request.url}|`,
        isUrlFilterCaseSensitive: true,
        initiatorDomains: [extensionId],
        requestMethods: ["post"],
        resourceTypes: ["xmlhttprequest"],
      },
    });
  });
});

test("background feed bridge aborts timed-out requests and removes its session rule", async () => {
  let timeoutCallback;
  const clearedTimers = [];
  await withBackgroundHarness({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    timerApi: {
      setTimeout(callback, delay) {
        assert.equal(delay, 15_000);
        timeoutCallback = callback;
        return "feed-timeout";
      },
      clearTimeout(id) { clearedTimers.push(id); },
    },
  }, async ({ fetchCalls, rules, send }) => {
    const pending = send(createFeedRequest());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls.length, 1);
    assert.equal(rules.size, 1);
    timeoutCallback();
    assert.deepEqual(await pending, { status: 0, body: "", failure: "timeout" });
    assert.equal(rules.size, 0);
    assert.deepEqual(clearedTimers, ["feed-timeout"]);
  });
});

test("background feed bridge serializes referer rules and cleans up after network failure", async () => {
  let finishFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  await withBackgroundHarness({
    fetchImpl: async (_url, init) => {
      if (!finishFirst) {
        markFirstStarted();
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      throw new Error("synthetic network failure");
    },
  }, async ({ fetchCalls, rules, send, updates }) => {
    const firstRequest = createFeedRequest({ rid: "aaa-12345678", token: "first-token", eid: "first-eid" });
    const secondRequest = createFeedRequest({ rid: "bbb-12345678", token: "second-token", eid: "second-eid" });
    const first = send(firstRequest);
    await firstStarted;
    const second = send(secondRequest);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetchCalls.length, 1);
    assert.equal(rules.get(1).action.requestHeaders[1].value, firstRequest.referer);
    finishFirst({ status: 200, ok: true, text: async () => "{\"first\":true}" });
    assert.deepEqual(await first, { status: 200, body: "{\"first\":true}" });
    assert.deepEqual(await second, { status: 0, body: "", failure: "failed" });

    assert.equal(fetchCalls.length, 2);
    assert.equal(rules.size, 0);
    assert.equal(updates[1].addRules[0].action.requestHeaders[1].value, firstRequest.referer);
    assert.equal(updates[3].addRules[0].action.requestHeaders[1].value, secondRequest.referer);
    assert.deepEqual(updates[2], { removeRuleIds: [1] });
    assert.deepEqual(updates[4], { removeRuleIds: [1] });
  });
});

test("download filenames are safe and existing files are uniquified", async () => {
  let options;
  const chromeApi = {
    downloads: {
      download: async (value) => {
        options = value;
        return 27;
      },
    },
  };

  const id = await startDownload({
    title: "../clip: one?.mp4",
    downloadUrl: "https://media.example/video.mp4?sig=synthetic-signature",
  }, chromeApi);

  assert.equal(id, 27);
  assert.equal(options.url, "https://media.example/video.mp4?sig=synthetic-signature");
  assert.equal(options.filename, safeFilename("../clip: one?.mp4"));
  assert.equal(options.filename.includes("/"), false);
  assert.equal(options.filename.includes(".."), false);
  assert.equal(options.conflictAction, "uniquify");
  assert.equal("saveAs" in options, false);
  await assert.rejects(
    startDownload({ title: "clip", downloadUrl: "javascript:alert(1)" }, chromeApi),
    TypeError,
  );
});

test("download status survives reopening through Chrome's own recent download history", async () => {
  let query;
  const chromeApi = {
    runtime: { id: "synthetic-extension-id" },
    downloads: {
      search: async (value) => {
        query = value;
        return [
          { byExtensionId: "other-extension", state: "complete", filename: "/tmp/other.mp4" },
          { byExtensionId: "synthetic-extension-id", state: "in_progress", filename: "/tmp/clip.mp4" },
        ];
      },
    },
  };

  const item = await latestDownload(chromeApi);
  assert.deepEqual(query, { orderBy: ["-startTime"], limit: 50 });
  assert.equal(item.filename, "/tmp/clip.mp4");
  assert.equal(downloadStatus(item), "正在下载 · clip.mp4");
  assert.equal(downloadStatus(null), "还没有下载记录。");
});

test("manifest requests only required extension and upstream-host permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.minimum_chrome_version, "101");
  assert.deepEqual(manifest.permissions, ["downloads", "declarativeNetRequestWithHostAccess"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://yuanbao.tencent.com/*",
    "https://channels.weixin.qq.com/*",
  ]);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["https://yuanbao.tencent.com/*"],
    all_frames: true,
    run_at: "document_start",
    js: ["yuanbao-frame.js"],
  }]);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.action.default_popup, undefined);
});

test("toolbar action opens the full extension page in a new tab", async () => {
  const previousChrome = globalThis.chrome;
  let onClicked;
  let createdTab;
  globalThis.chrome = {
    action: { onClicked: { addListener: (listener) => { onClicked = listener; } } },
    runtime: {
      getURL: (path) => `chrome-extension://synthetic-id/${path}`,
      onMessage: { addListener() {} },
    },
    tabs: { create: (properties) => { createdTab = properties; } },
    declarativeNetRequest: { updateSessionRules: async () => {} },
  };

  try {
    await import(`../extension/background.mjs?test=${Date.now()}`);
    onClicked();
    assert.deepEqual(createdTab, { url: "chrome-extension://synthetic-id/index.html" });
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
