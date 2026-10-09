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
  waitForDownload,
} from "../extension/app.mjs";
import { createAgentConnectionController, startAgent } from "../extension/agent.mjs";
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

test("background feed bridge accepts only the exact extension index page", async () => {
  await withBackgroundHarness({}, async ({ extensionId, fetchCalls, send }) => {
    const request = createFeedRequest();
    const invalidUrls = [
      `chrome-extension://${extensionId}/index.html?agent-connect`,
      `chrome-extension://${extensionId}/agent.html`,
      `chrome-extension://${extensionId}/other.html`,
    ];
    for (const url of invalidUrls) {
      assert.equal(await send(request, { id: extensionId, frameId: 0, url }), undefined);
    }
    assert.equal(fetchCalls.length, 0);
    assert.equal((await send(request, { id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/index.html` })).status, 200);
    assert.equal(fetchCalls.length, 1);
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
  await startDownload({ title: "unused", downloadUrl: "https://media.example/video.mp4" }, chromeApi, "Clips/custom.mp4");
  assert.equal(options.filename, "Clips/custom.mp4");
  await assert.rejects(
    startDownload({ title: "clip", downloadUrl: "https://media.example/video.mp4" }, chromeApi, "../unsafe.mp4"),
    TypeError,
  );
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

test("waitForDownload follows one Chrome ID through its terminal state and removes its listener", async () => {
  const listeners = new Set();
  const current = { id: 42, state: "in_progress", filename: "/Users/test/Downloads/clip.mp4", bytesReceived: 0 };
  const searchQueries = [];
  const chromeApi = {
    downloads: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
      async search(query) {
        searchQueries.push(query);
        return [current];
      },
    },
  };
  const pending = waitForDownload(42, chromeApi, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.size, 1);
  current.state = "complete";
  current.bytesReceived = 1234;
  for (const listener of [...listeners]) listener({ id: 42, state: { current: "complete" } });
  assert.deepEqual(await pending, {
    state: "complete",
    path: "/Users/test/Downloads/clip.mp4",
    bytes: 1234,
  });
  assert.deepEqual(searchQueries, [{ id: 42 }, { id: 42 }]);
  assert.equal(listeners.size, 0);
});

test("waitForDownload times out with zero listeners and rejects zero-byte terminal downloads", async () => {
  const listeners = new Set();
  const chromeApi = {
    downloads: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
      async search() { return [{ id: 12, state: "in_progress", filename: "/tmp/clip.mp4", bytesReceived: 0 }]; },
    },
  };
  await assert.rejects(waitForDownload(12, chromeApi, 10), /DOWNLOAD_TIMEOUT/);
  assert.equal(listeners.size, 0);
  chromeApi.downloads.search = async () => [{ id: 12, state: "complete", filename: "/tmp/clip.mp4", bytesReceived: 0 }];
  await assert.rejects(waitForDownload(12, chromeApi, 100), /DOWNLOAD_EMPTY/);
  assert.equal(listeners.size, 0);
});

test("manifest requests only required extension and upstream-host permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual(manifest.permissions, ["downloads", "declarativeNetRequestWithHostAccess", "nativeMessaging"]);
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
  const index = await readFile(new URL("../extension/index.html", import.meta.url), "utf8");
  assert.match(index, /src="\.\/agent\.js"/);
  assert.match(index, /id="agent-connect-toggle"[^>]*role="switch"[^>]*aria-checked="false"/s);
  assert.match(index, /id="agent-connect-status"[^>]*role="status"/s);
});

test("toolbar action focuses the existing page or creates one", async () => {
  const previousChrome = globalThis.chrome;
  let onClicked;
  const focusedTabs = [];
  const createdTabs = [];
  let queried = [{ tabId: 42, windowId: 9 }];
  const focusedWindows = [];
  globalThis.chrome = {
    action: { onClicked: { addListener: (listener) => { onClicked = listener; } } },
    runtime: {
      getURL: (path) => `chrome-extension://synthetic-id/${path}`,
      onMessage: { addListener() {} },
      getContexts: async (filter) => {
        assert.deepEqual(filter, { contextTypes: ["TAB"], documentUrls: ["chrome-extension://synthetic-id/index.html"] });
        return queried;
      },
    },
    windows: { update: async (id, properties) => { focusedWindows.push({ id, properties }); } },
    tabs: {
      update: async (id, properties) => { focusedTabs.push({ id, properties }); },
      create: async (properties) => { createdTabs.push(properties); },
    },
    declarativeNetRequest: { updateSessionRules: async () => {} },
  };

  try {
    await import(`../extension/background.mjs?test=${Date.now()}`);
    await onClicked();
    assert.deepEqual(focusedTabs, [{ id: 42, properties: { active: true } }]);
    assert.deepEqual(createdTabs, []);
    assert.deepEqual(focusedWindows, [{ id: 9, properties: { focused: true } }]);
    queried = [];
    await onClicked();
    assert.deepEqual(createdTabs, [{ url: "chrome-extension://synthetic-id/index.html" }]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("agent controller ignores stale port callbacks and never routes old work to a new port", async () => {
  const createEvent = () => {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      fire(value) { for (const listener of [...listeners]) listener(value); },
    };
  };
  const ports = [];
  const chromeApi = {
    runtime: {
      connectNative(name) {
        assert.equal(name, "com.mc0571.weixin_channels_video");
        const port = {
          onMessage: createEvent(),
          onDisconnect: createEvent(),
          messages: [],
          postMessage(value) { this.messages.push(value); },
          disconnect() { this.onDisconnect.fire(); },
        };
        ports.push(port);
        return port;
      },
      get lastError() { return undefined; },
    },
  };
  const attributes = new Map([["aria-checked", "false"]]);
  let click;
  const toggleButton = {
    textContent: "",
    addEventListener(type, listener) { assert.equal(type, "click"); click = listener; },
    getAttribute(name) { return attributes.get(name); },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const statusElement = { textContent: "" };
  let finishOldWork;
  const controller = createAgentConnectionController({
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    chromeApi,
    toggleButton,
    statusElement,
    handleCommand: () => new Promise((resolve) => { finishOldWork = resolve; }),
  });

  assert.equal(toggleButton.textContent, "开启 AI 连接");
  assert.equal(attributes.get("aria-checked"), "false");
  assert.match(statusElement.textContent, /首次使用/);
  click();
  const oldPort = ports[0];
  oldPort.onMessage.fire({ type: "ready", version: 1 });
  assert.equal(statusElement.textContent, "AI 助手已连接，使用期间请保留此页面。");
  oldPort.onMessage.fire({ id: "323e4567-e89b-42d3-a456-426614174000", command: "status" });
  await Promise.resolve();

  click();
  click();
  const newPort = ports[1];
  newPort.onMessage.fire({ type: "ready", version: 1 });
  oldPort.onMessage.fire({ type: "ready", version: 1 });
  oldPort.onDisconnect.fire();
  assert.equal(controller.isConnected(), true);
  assert.equal(attributes.get("aria-checked"), "true");
  assert.equal(statusElement.textContent, "AI 助手已连接，使用期间请保留此页面。");

  finishOldWork({ id: "323e4567-e89b-42d3-a456-426614174000", ok: true, result: { login: "anonymous" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(oldPort.messages, [{ type: "hello", version: 1, sessionId: "123e4567-e89b-42d3-a456-426614174000" }]);
  assert.deepEqual(newPort.messages, [{ type: "hello", version: 1, sessionId: "123e4567-e89b-42d3-a456-426614174000" }]);
});

test("agent controller resets after hello send failure and can reconnect", () => {
  const createEvent = () => ({ addListener() {}, fire() {} });
  let attempts = 0;
  const chromeApi = {
    runtime: {
      connectNative: () => {
        attempts += 1;
        return {
          onMessage: createEvent(),
          onDisconnect: createEvent(),
          disconnect() {},
          postMessage() { if (attempts === 1) throw new Error("synthetic post failure"); },
        };
      },
    },
  };
  const attributes = new Map([ ["aria-checked", "false"] ]);
  let click;
  const toggleButton = {
    textContent: "",
    addEventListener(_type, listener) { click = listener; },
    getAttribute(name) { return attributes.get(name); },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const statusElement = { textContent: "" };
  const controller = createAgentConnectionController({ sessionId: "123e4567-e89b-42d3-a456-426614174000", chromeApi, toggleButton, statusElement, handleCommand: async () => ({}) });

  click();
  assert.equal(attempts, 1);
  assert.equal(controller.isConnected(), false);
  assert.equal(attributes.get("aria-checked"), "false");
  assert.match(statusElement.textContent, /检查本地连接组件/);
  click();
  assert.equal(attempts, 2);
  assert.equal(controller.isConnected(), true);
  assert.equal(attributes.get("aria-checked"), "true");
});

test("agent controller resets and reconnects when a command response cannot be sent", async () => {
  const createEvent = () => {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      fire(value) { for (const listener of [...listeners]) listener(value); },
    };
  };
  const ports = [];
  const chromeApi = {
    runtime: {
      connectNative: () => {
        const port = {
          onMessage: createEvent(),
          onDisconnect: createEvent(),
          disconnectCount: 0,
          messages: [],
          postMessage(value) {
            if (value.type !== "hello") throw new Error("synthetic response send failure");
            this.messages.push(value);
          },
          disconnect() { this.disconnectCount += 1; this.onDisconnect.fire(); },
        };
        ports.push(port);
        return port;
      },
    },
  };
  const attributes = new Map([["aria-checked", "false"]]);
  let click;
  const toggleButton = {
    textContent: "",
    addEventListener(_type, listener) { click = listener; },
    getAttribute(name) { return attributes.get(name); },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const statusElement = { textContent: "" };
  const controller = createAgentConnectionController({
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    chromeApi,
    toggleButton,
    statusElement,
    handleCommand: async (request) => ({ id: request.id, ok: true, result: {} }),
  });

  click();
  const failedPort = ports[0];
  failedPort.onMessage.fire({ type: "ready", version: 1 });
  failedPort.onMessage.fire({ id: "323e4567-e89b-42d3-a456-426614174000", command: "status" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isConnected(), false);
  assert.equal(failedPort.disconnectCount, 1);
  assert.equal(attributes.get("aria-checked"), "false");
  assert.match(statusElement.textContent, /检查本地连接组件/);

  click();
  assert.equal(controller.isConnected(), true);
  assert.equal(ports.length, 2);
});


test("unpaired pages never launch the native host", () => {
  let launches = 0;
  const statusElement = { textContent: "" };
  const chromeApi = { runtime: { connectNative: () => { launches += 1; } } };
  for (const sessionId of [undefined, "not-a-session"]) {
    const controller = createAgentConnectionController({ chromeApi, sessionId, statusElement });
    controller.connect();
    assert.equal(controller.isConnected(), false);
    assert.match(statusElement.textContent, /首次连接/);
  }
  assert.equal(launches, 0);
});

test("CLI pairing reuses a user page without starting a second native host", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const url = "chrome-extension://synthetic-id/index.html";
  const stored = new Map([["unrelated", "preserve"]]);
  const attributes = new Map();
  const statusElement = {};
  const toggleButton = { addEventListener() {}, setAttribute: (key, value) => attributes.set(key, value) };
  const callbacks = new Map();
  const calls = [];
  let nativeStarts = 0;
  const windowApi = {
    location: { hash: `#agent-connect=${sessionId}` },
    history: { replaceState(_state, _title, value) { calls.push(["clean", value]); windowApi.location.hash = ""; } },
    localStorage: { setItem: (key, value) => stored.set(key, value), getItem: (key) => stored.get(key) },
    addEventListener: (type, handler) => callbacks.set(type, handler),
  };
  const chromeApi = {
    runtime: {
      getURL: () => url,
      getContexts: async () => [{ tabId: 1, windowId: 5 }, { tabId: 2, windowId: 6 }],
      connectNative: () => { nativeStarts += 1; throw new Error("must not start before handoff"); },
    },
    tabs: {
      getCurrent: async () => ({ id: 2 }),
      update: async (id, options) => calls.push(["update", id, options]),
      remove: async (id) => calls.push(["remove", id]),
    },
    windows: { update: async (id, options) => calls.push(["focus", id, options]) },
  };
  await startAgent({ chromeApi, windowApi, documentApi: { querySelector: (selector) => selector.endsWith("toggle") ? toggleButton : statusElement } });
  assert.deepEqual(calls, [
    ["clean", url],
    ["update", 1, { url: `${url}#agent-connect=${sessionId}`, active: true }],
    ["focus", 5, { focused: true }],
    ["remove", 2],
  ]);
  assert.equal(nativeStarts, 0);
  assert.equal(stored.get("unrelated"), "preserve");
  assert.equal(stored.get("weixin-channels-video:bridge-session"), sessionId);
});

test("existing user page accepts pairing without reload and reads it on subsequent toggles", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const storage = new Map();
  const listeners = new Map();
  const attributes = new Map();
  let click;
  const toggleButton = {
    addEventListener(_type, callback) { click = callback; },
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: (key) => attributes.get(key),
  };
  const statusElement = {};
  const hellos = [];
  const windowApi = {
    location: { hash: "#ordinary-fragment" },
    history: { replaceState() { windowApi.location.hash = ""; } },
    localStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) },
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const chromeApi = {
    runtime: {
      getURL: () => "chrome-extension://synthetic-id/index.html",
      connectNative: () => ({
        onMessage: { addListener() {} }, onDisconnect: { addListener() {} },
        postMessage: (value) => hellos.push(value), disconnect() {},
      }),
    },
  };
  const controller = await startAgent({ chromeApi, windowApi, documentApi: { querySelector: (selector) => selector.endsWith("toggle") ? toggleButton : statusElement } });
  assert.equal(controller.isConnected(), false);
  assert.equal(storage.size, 0);
  windowApi.location.hash = `#agent-connect=${sessionId}`;
  listeners.get("hashchange")();
  assert.equal(controller.isConnected(), true);
  assert.equal(windowApi.location.hash, "");
  windowApi.location.hash = `#agent-connect=${sessionId}`;
  listeners.get("hashchange")();
  assert.equal(hellos.length, 1, "repeated pairing reuses the live native port");
  click();
  click();
  assert.deepEqual(hellos, Array(2).fill({ type: "hello", version: 1, sessionId }));
});

test("concurrent CLI pages choose one winner and never close each other", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const url = "chrome-extension://synthetic-id/index.html";
  const removed = [];
  const updated = [];
  const started = [];
  const contexts = [{ tabId: 7, windowId: 1 }, { tabId: 8, windowId: 1 }];
  await Promise.all(contexts.map(async ({ tabId }) => {
    const storage = new Map();
    const windowApi = {
      location: { hash: `#agent-connect=${sessionId}` },
      history: { replaceState() { windowApi.location.hash = ""; } },
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      addEventListener() {},
    };
    await startAgent({
      windowApi,
      documentApi: { querySelector: () => ({ setAttribute() {}, addEventListener() {} }) },
      chromeApi: {
        runtime: {
          getURL: () => url,
          getContexts: async () => contexts,
          connectNative: () => {
            started.push(tabId);
            return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} };
          },
        },
        tabs: {
          getCurrent: async () => ({ id: tabId }),
          update: async (id) => updated.push(id),
          remove: async (id) => removed.push(id),
        },
        windows: { update: async () => {} },
      },
    });
  }));
  assert.deepEqual(started, [7]);
  assert.deepEqual(updated, [7]);
  assert.deepEqual(removed, [8]);
});

test("pairing storage failure closes an existing connection before reporting off", () => {
  for (const brokenRead of [() => undefined, () => { throw new Error("blocked storage"); }]) {
    let readSession = () => "123e4567-e89b-42d3-a456-426614174000";
    let disconnects = 0;
    const controller = createAgentConnectionController({
      readSession: () => readSession(),
      chromeApi: { runtime: { connectNative: () => ({
        onMessage: { addListener() {} }, onDisconnect: { addListener() {} },
        postMessage() {}, disconnect() { disconnects += 1; },
      }) } },
    });
    controller.connect();
    assert.equal(controller.isConnected(), true);
    readSession = brokenRead;
    controller.connect();
    assert.equal(controller.isConnected(), false);
    assert.equal(disconnects, 1);
  }
});
