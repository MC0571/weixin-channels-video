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
import { startAgent } from "../extension/agent.mjs";
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

async function withBackgroundHarness({ fetchImpl, timerApi, initialStorage = {}, initialAlarms = {}, offscreenMessenger } = {}, callback) {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const previousSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const previousClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  const extensionId = "synthetic-extension-id";
  const rules = new Map();
  const updates = [];
  const fetchCalls = [];
  let messageListener;
  const event = () => {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      async fire(value) {
        return Promise.all([...listeners].map((listener) => listener(value)));
      },
    };
  };
  const onStartup = event();
  const onInstalled = event();
  const onAlarm = event();
  const onDownloadDeterminingFilename = event();
  const onDownloadChanged = event();
  const storage = new Map(Object.entries(initialStorage));
  const alarms = new Map(Object.entries(initialAlarms));
  const ports = [];
  let offscreenCreated = false;
  const chromeApi = {
    downloads: {
      onDeterminingFilename: onDownloadDeterminingFilename,
      onChanged: onDownloadChanged,
    },
    runtime: {
      id: extensionId,
      getURL: (path) => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener: (listener) => { messageListener = listener; } },
      onStartup,
      onInstalled,
      getContexts: async (filter) => filter.contextTypes.includes("OFFSCREEN_DOCUMENT")
        ? (offscreenCreated ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [])
        : [],
      sendMessage: async (message) => {
        if (!offscreenMessenger) throw new Error("no offscreen test responder");
        return offscreenMessenger(message);
      },
      connectNative: (name) => {
        assert.equal(name, "com.mc0571.weixin_channels_video");
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          messages: [],
          disconnects: 0,
          postMessage(value) { this.messages.push(value); },
          disconnect() { this.disconnects += 1; void this.onDisconnect.fire(); },
        };
        ports.push(port);
        return port;
      },
    },
    storage: { local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map((key) => [key, storage.get(key)]));
      },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
    } },
    offscreen: { createDocument: async (options) => { offscreenCreated = true; return options; } },
    alarms: {
      onAlarm,
      async clear(name) { return alarms.delete(name); },
      async get(name) { return alarms.get(name); },
      create(name, options) { alarms.set(name, options); },
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
    return await callback({
      chromeApi, extensionId, fetchCalls, updates, rules, send,
      onStartup, onInstalled, onAlarm, storage, alarms, ports,
      get offscreenCreated() { return offscreenCreated; },
    });
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
  for (const title of ["中".repeat(90), "中".repeat(100), "😀".repeat(100)]) {
    options = undefined;
    await startDownload({ title, downloadUrl: "https://media.example/video.mp4" }, chromeApi);
    assert.equal(options.filename, safeFilename(title));
    assert.ok(new TextEncoder().encode(options.filename).byteLength <= 255);
    assert.equal(options.conflictAction, "uniquify");
  }
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
  assert.deepEqual(manifest.permissions, ["downloads", "declarativeNetRequestWithHostAccess", "nativeMessaging", "storage", "offscreen", "alarms"]);
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
  assert.doesNotMatch(index, /agent-connect-(?:toggle|status)/);
  assert.match(await readFile(new URL("../extension/offscreen.html", import.meta.url), "utf8"), /offscreen\.js/);
});

test("toolbar action focuses the existing page or creates one", async () => {
  const previousChrome = globalThis.chrome;
  let onClicked;
  const focusedTabs = [];
  const createdTabs = [];
  let queried = [{ tabId: 42, windowId: 9 }];
  const focusedWindows = [];
  globalThis.chrome = {
    downloads: {
      onDeterminingFilename: { addListener() {} },
      onChanged: { addListener() {} },
    },
    action: { onClicked: { addListener: (listener) => { onClicked = listener; } } },
    runtime: {
      getURL: (path) => `chrome-extension://synthetic-id/${path}`,
      onMessage: { addListener() {} },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      getContexts: async (filter) => {
        assert.deepEqual(filter, { contextTypes: ["TAB"], documentUrls: ["chrome-extension://synthetic-id/index.html"] });
        return queried;
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    alarms: { onAlarm: { addListener() {} }, clear: async () => true, create() {} },
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

test("background restores a persisted pairing on Chrome startup without opening a page", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  await withBackgroundHarness({
    initialStorage: { "weixin-channels-video:bridge-session": sessionId },
  }, async (harness) => {
    const { onStartup, ports, storage } = harness;
    await onStartup.fire();
    assert.equal(storage.get("weixin-channels-video:bridge-session"), sessionId);
    assert.equal(storage.get("weixin-channels-video:bridge-retry-count"), 0);
    assert.equal(ports.length, 1);
    assert.deepEqual(ports[0].messages, [{ type: "hello", version: 1, sessionId }]);
    assert.equal(harness.offscreenCreated, false);
  });
});

test("installed and startup events reuse one restored Native Messaging connection", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  await withBackgroundHarness({
    initialStorage: { "weixin-channels-video:bridge-session": sessionId },
  }, async ({ onInstalled, onStartup, ports, storage }) => {
    await onInstalled.fire();
    await onStartup.fire();
    assert.equal(ports.length, 1);
    assert.deepEqual(ports[0].messages, [{ type: "hello", version: 1, sessionId }]);
    assert.equal(storage.get("weixin-channels-video:bridge-retry-count"), 0);
  });
});

test("worker module load restores a pairing only when no retry alarm is pending", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const pairingKey = "weixin-channels-video:bridge-session";
  const retryKey = "weixin-channels-video:bridge-retry-count";
  const alarmName = "weixin-channels-video:bridge-reconnect";

  await withBackgroundHarness({
    initialStorage: { [pairingKey]: sessionId, [retryKey]: 2 },
  }, async ({ ports }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(ports.length, 1, "a worker restart can recover without a startup event");
  });

  await withBackgroundHarness({
    initialStorage: { [pairingKey]: sessionId, [retryKey]: 2 },
    initialAlarms: { [alarmName]: { delayInMinutes: 4 } },
  }, async ({ onAlarm, ports, alarms, storage }) => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ports.length, 0, "module loading respects the scheduled backoff");
    assert.equal(storage.get(retryKey), 2, "module loading preserves the persisted attempt count");
    alarms.delete(alarmName);
    await onAlarm.fire({ name: alarmName });
    assert.equal(ports.length, 1);
    assert.equal(storage.get(retryKey), 2, "alarm wake does not reset the retry count");
  });

  await withBackgroundHarness({
    initialStorage: { [pairingKey]: sessionId, [retryKey]: 5 },
  }, async ({ ports }) => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ports.length, 0, "worker restarts do not bypass the retry limit");
  });
});

test("background migrates a legacy page pairing through offscreen without opening the main tab", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const messages = [];
  await withBackgroundHarness({
    offscreenMessenger: async (message) => {
      messages.push(message);
      if (message.type === "weixin-channels-video:offscreen-read-pairing") return { sessionId };
      if (message.type === "weixin-channels-video:offscreen-clear-pairing") return { ok: true };
      throw new Error("unexpected offscreen message");
    },
  }, async (harness) => {
    const { onStartup, ports, storage } = harness;
    await onStartup.fire();
    assert.equal(harness.offscreenCreated, true);
    assert.equal(storage.get("weixin-channels-video:bridge-session"), sessionId);
    assert.deepEqual(messages, [
      { type: "weixin-channels-video:offscreen-read-pairing" },
      { type: "weixin-channels-video:offscreen-clear-pairing", sessionId },
    ]);
    assert.equal(ports.length, 1);
    assert.deepEqual(ports[0].messages, [{ type: "hello", version: 1, sessionId }]);
  });
});

test("pairing opens one background Native Messaging port and keeps task result fields", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const requestId = "323e4567-e89b-42d3-a456-426614174000";
  const shareUrl = "https://weixin.qq.com/sph/synthetic";
  const parseBody = {
    type: "video_channel_url",
    url: shareUrl,
    scene: 1,
  };
  const feedResult = {
    errCode: 0,
    data: {
      feedInfo: {
        description: "A title",
        coverUrl: "https://media.example/cover.jpg",
        h264VideoInfo: { videoUrl: "https://media.example/video.mp4" },
      },
      authorInfo: { nickname: "An author" },
    },
  };
  const calls = [];
  await withBackgroundHarness({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === API_URLS.userInfo) {
        return Response.json({ userId: "user", needRefreshToken: false, anonUser: { isAnon: false } });
      }
      if (url.startsWith(API_URLS.feedInfo)) return Response.json(feedResult);
      assert.fail("unexpected upstream URL");
    },
    offscreenMessenger: async (message) => {
      assert.equal(message.type, "weixin-channels-video:offscreen-parse");
      assert.deepEqual(JSON.parse(message.body), parseBody);
      return {
        status: 200,
        body: JSON.stringify({
          code: 0,
          data: {
            playable_url: "https://yuanbao.tencent.com/share?token=private-token&eid=private-eid",
            desc: "A title",
            author: "An author",
          },
        }),
      };
    },
  }, async ({ send, ports, storage }) => {
    assert.deepEqual(await send({ type: "weixin-channels-video:pair", sessionId }), { ok: true });
    assert.equal(storage.get("weixin-channels-video:bridge-session"), sessionId);
    assert.equal(ports.length, 1);
    assert.deepEqual(ports[0].messages, [{ type: "hello", version: 1, sessionId }]);

    await ports[0].onMessage.fire({ type: "ready", version: 1 });
    await ports[0].onMessage.fire({ id: requestId, command: "parse", url: shareUrl });
    for (let attempt = 0; attempt < 20 && ports[0].messages.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(ports[0].messages.length, 2);
    assert.deepEqual(ports[0].messages[1], {
      id: requestId,
      ok: true,
      result: {
        title: "A title",
        author: "An author",
        coverUrl: "https://media.example/cover.jpg",
        previewUrl: "https://media.example/video.mp4",
        downloadUrl: "https://media.example/video.mp4",
        mediaVariants: [{ label: "H.264", downloadUrl: "https://media.example/video.mp4" }],
      },
    });
    assert.equal(JSON.stringify(ports[0].messages[1]).includes("private-token"), false);
    assert.equal(calls.filter((call) => call.url === API_URLS.userInfo).length, 1);
    assert.equal(calls.filter((call) => call.url.startsWith(API_URLS.feedInfo)).length, 1);
    assert.deepEqual(await send({ type: "weixin-channels-video:pair", sessionId }), { ok: true });
    assert.equal(ports.length, 1, "repeated pairing reuses the active port");
  });
});

test("rotating a paired session closes the old port and records host startup separately from readiness", async () => {
  const previousSession = "123e4567-e89b-42d3-a456-426614174000";
  const nextSession = "223e4567-e89b-42d3-a456-426614174000";
  const stateKey = "weixin-channels-video:bridge-connection-state";
  await withBackgroundHarness({
    initialStorage: { "weixin-channels-video:bridge-session": previousSession },
  }, async ({ onStartup, ports, storage, send }) => {
    await onStartup.fire();
    const previousPort = ports[0];
    assert.deepEqual(previousPort.messages, [{ type: "hello", version: 1, sessionId: previousSession }]);

    assert.deepEqual(await send({ type: "weixin-channels-video:pair", sessionId: nextSession }), { ok: true });
    assert.equal(storage.get("weixin-channels-video:bridge-session"), nextSession);
    assert.equal(previousPort.disconnects, 1);
    assert.deepEqual(ports[1].messages, [{ type: "hello", version: 1, sessionId: nextSession }]);
    assert.equal(storage.get(stateKey).stage, "host_starting", "pairing acknowledgment does not claim host readiness");

    await ports[1].onMessage.fire({ type: "ready", version: 1 });
    for (let attempt = 0; attempt < 20 && storage.get(stateKey)?.stage !== "host_ready"; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(storage.get(stateKey), { version: 1, stage: "host_ready" });
  });
});

test("Native Messaging disconnect stores safe categories for Chrome's documented host errors", async () => {
  const stateKey = "weixin-channels-video:bridge-connection-state";
  const errors = [
    ["Specified native messaging host not found. C:\\private\\manifest.json", "host_not_found"],
    ["Native messaging host host name is not registered. (Windows-only)", "host_not_registered"],
    ["Failed to start native messaging host.", "host_start_failed"],
    ["Access to the specified native messaging host is forbidden.", "host_access_forbidden"],
    ["Native host has exited.", "host_exited"],
    ["Error when communicating with the native messaging host.", "host_communication_failed"],
    ["Unrecognized runtime error with a private path", "host_disconnected"],
  ];
  for (const [message, reason] of errors) {
    await withBackgroundHarness({}, async ({ onStartup, ports, storage, chromeApi }) => {
      await chromeApi.storage.local.set({ "weixin-channels-video:bridge-session": "123e4567-e89b-42d3-a456-426614174000" });
      await onStartup.fire();
      chromeApi.runtime.lastError = { message };
      await ports[0].onDisconnect.fire();
      for (let attempt = 0; attempt < 20 && storage.get(stateKey)?.stage !== "failed"; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(storage.get(stateKey), { version: 1, stage: "failed", reason });
      assert.equal(JSON.stringify(storage.get(stateKey)).includes("private"), false);
    });
  }
});

test("offscreen accepts only fixed background parse and pairing messages", async () => {
  const harness = createHiddenIframeHarness();
  const extensionId = "synthetic-extension-id";
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  let legacySession = sessionId;
  const removed = [];
  harness.windowApi.localStorage = {
    getItem(key) {
      assert.equal(key, "weixin-channels-video:bridge-session");
      return legacySession;
    },
    removeItem(key) {
      assert.equal(key, "weixin-channels-video:bridge-session");
      legacySession = null;
      removed.push(key);
    },
  };
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let listener;
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      getURL: (path) => "chrome-extension://" + extensionId + "/" + path,
      onMessage: { addListener: (callback) => { listener = callback; } },
    },
  };
  try {
    await withHiddenIframeHarness(harness, async () => {
      await import("../extension/offscreen.mjs?test=" + Date.now() + "-" + Math.random());
      const workerSender = {
        id: extensionId,
      };
      let migrated;
      listener({ type: "weixin-channels-video:offscreen-read-pairing" }, workerSender, (value) => { migrated = value; });
      assert.deepEqual(migrated, { sessionId });

      let cleared;
      listener({
        type: "weixin-channels-video:offscreen-clear-pairing",
        sessionId,
      }, workerSender, (value) => { cleared = value; });
      assert.deepEqual(cleared, { ok: true });
      assert.deepEqual(removed, ["weixin-channels-video:bridge-session"]);
      assert.equal(legacySession, null);

      const request = {
        type: "weixin-channels-video:offscreen-parse",
        body: JSON.stringify({ type: "video_channel_url" }),
      };
      assert.equal(listener(request, {
        id: extensionId,
        url: "chrome-extension://" + extensionId + "/index.html",
        frameId: 0,
        documentId: "synthetic-page-document",
      }, () => assert.fail("page messages cannot start background Yuanbao requests")), undefined);
      const responsePromise = new Promise((resolve) => {
        assert.equal(listener(request, workerSender, resolve), true);
      });
      const [{ message }] = harness.requestMessages;
      harness.dispatchMessage({
        type: "weixin-channels-video:api-response",
        requestId: message.requestId,
        status: 200,
        body: "{\"code\":0}",
      });
      assert.deepEqual(await responsePromise, { status: 200, body: "{\"code\":0}" });
    });
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else delete globalThis.chrome;
  }
});

test("one reconnect alarm uses bounded backoff and stops after five failed starts", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  await withBackgroundHarness({
    initialStorage: { "weixin-channels-video:bridge-session": sessionId },
  }, async ({ onStartup, onAlarm, alarms, ports, storage }) => {
    await onStartup.fire();
    const expectedDelays = [1, 2, 4, 8, 15];
    for (const expectedDelay of expectedDelays) {
      const current = ports.at(-1);
      await current.onDisconnect.fire();
      assert.deepEqual([...alarms.keys()], ["weixin-channels-video:bridge-reconnect"]);
      assert.deepEqual(alarms.get("weixin-channels-video:bridge-reconnect"), { delayInMinutes: expectedDelay });
      alarms.delete("weixin-channels-video:bridge-reconnect");
      await onAlarm.fire({ name: "weixin-channels-video:bridge-reconnect" });
      assert.equal(ports.length, expectedDelays.indexOf(expectedDelay) + 2);
    }
    await ports.at(-1).onDisconnect.fire();
    assert.equal(storage.get("weixin-channels-video:bridge-retry-count"), 5);
    assert.equal(alarms.size, 0, "failed retries stop until startup or another explicit pairing");
  });
});

test("Native Messaging commands share one queue across port reconnections", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  let startFirstOffscreenRequest;
  let finishFirstOffscreenRequest;
  const firstRequestStarted = new Promise((resolve) => { startFirstOffscreenRequest = resolve; });
  const firstRequestResult = new Promise((resolve) => { finishFirstOffscreenRequest = resolve; });
  let parseRequests = 0;
  await withBackgroundHarness({
    initialStorage: { "weixin-channels-video:bridge-session": sessionId },
    fetchImpl: async (url) => {
      if (url === API_URLS.userInfo) {
        return Response.json({ userId: "user", needRefreshToken: false, anonUser: { isAnon: false } });
      }
      assert.fail("unexpected upstream URL");
    },
    offscreenMessenger: async (message) => {
      assert.equal(message.type, "weixin-channels-video:offscreen-parse");
      parseRequests += 1;
      if (parseRequests === 1) {
        startFirstOffscreenRequest();
        return firstRequestResult;
      }
      return { status: 500, body: "{}" };
    },
  }, async ({ onStartup, onAlarm, ports }) => {
    await onStartup.fire();
    const oldPort = ports[0];
    await oldPort.onMessage.fire({ type: "ready", version: 1 });
    await oldPort.onMessage.fire({
      id: "323e4567-e89b-42d3-a456-426614174000",
      command: "parse",
      url: "https://weixin.qq.com/sph/first",
    });
    await firstRequestStarted;
    await oldPort.onMessage.fire({
      id: "423e4567-e89b-42d3-a456-426614174000",
      command: "parse",
      url: "https://weixin.qq.com/sph/queued-old-request",
    });

    await oldPort.onDisconnect.fire();
    await onAlarm.fire({ name: "weixin-channels-video:bridge-reconnect" });
    const newPort = ports[1];
    await newPort.onMessage.fire({ type: "ready", version: 1 });
    await newPort.onMessage.fire({
      id: "523e4567-e89b-42d3-a456-426614174000",
      command: "parse",
      url: "https://weixin.qq.com/sph/new-port-request",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseRequests, 1, "new-port work waits for the dispatched old task");

    finishFirstOffscreenRequest({ status: 500, body: "{}" });
    for (let attempt = 0; attempt < 20 && newPort.messages.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(parseRequests, 2, "queued work from the stale port is not replayed");
    assert.equal(oldPort.messages.length, 1, "the stale port receives no late result");
    assert.equal(newPort.messages.length, 2);
  });
});

test("CLI bootstrap page sends only the fixed pairing and closes after background acknowledgment", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const url = "chrome-extension://synthetic-id/index.html";
  const messages = [];
  const calls = [];
  const listeners = new Map();
  const windowApi = {
    location: { hash: "#agent-connect=" + sessionId },
    history: {
      state: null,
      replaceState(_state, _title, value) {
        calls.push(["clean", value]);
        windowApi.location.hash = "";
      },
    },
    addEventListener: (type, callback) => listeners.set(type, callback),
  };
  const chromeApi = {
    runtime: {
      getURL: (path) => "chrome-extension://synthetic-id/" + path,
      sendMessage: async (message) => {
        messages.push(message);
        return { ok: true };
      },
    },
    tabs: {
      getCurrent: async () => ({ id: 42 }),
      remove: async (id) => calls.push(["remove", id]),
    },
  };

  startAgent({ chromeApi, windowApi });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ type: "weixin-channels-video:pair", sessionId }]);
  assert.deepEqual(calls, [["clean", url], ["remove", 42]]);
  assert.equal(windowApi.location.hash, "");
  assert.equal(typeof listeners.get("hashchange"), "function");
});

test("manual extension page stays open and invalid pairing hashes are removed without pairing", async () => {
  let sends = 0;
  let removes = 0;
  let hashChange;
  const windowApi = {
    location: { hash: "" },
    history: { replaceState() { windowApi.location.hash = ""; } },
    addEventListener(type, callback) { assert.equal(type, "hashchange"); hashChange = callback; },
  };
  const chromeApi = {
    runtime: {
      getURL: () => "chrome-extension://synthetic-id/index.html",
      sendMessage: async () => { sends += 1; return { ok: true }; },
    },
    tabs: {
      getCurrent: async () => ({ id: 1 }),
      remove: async () => { removes += 1; },
    },
  };
  startAgent({ chromeApi, windowApi });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  assert.equal(removes, 0);

  windowApi.location.hash = "#agent-connect=not-a-session";
  hashChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  assert.equal(removes, 0);
  assert.equal(windowApi.location.hash, "");
});
