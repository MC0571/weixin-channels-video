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

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    dispatch(...args) {
      for (const listener of listeners) listener(...args);
    },
    get listenerCount() { return listeners.size; },
  };
}

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

test("parseShare uses the injected hidden-frame requester without querying or creating Yuanbao tabs", async () => {
  const body = "{\"type\":\"video_channel_url\",\"url\":\"https://weixin.qq.com/sph/synthetic-id\",\"scene\":1}";
  let requestedBody;
  const request = createExtensionRequest(
    async () => assert.fail("parseShare must use the hidden-frame requester"),
    {
      tabs: {
        query: async () => assert.fail("parseShare must not query tabs"),
        create: async () => assert.fail("parseShare must not create tabs"),
      },
      scripting: { executeScript: async () => assert.fail("parseShare must not inject into tabs") },
    },
    async (value) => {
      requestedBody = value;
      return Response.json({ code: 0 });
    },
  );

  const response = await request(API_URLS.parseShare, { method: "POST", body });
  assert.equal(requestedBody, body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 0 });
  await assert.rejects(request(`${API_URLS.parseShare}?extra=1`, { method: "POST", body }), TypeError);
  assert.equal(requestedBody, body);
});

test("hidden iframe requester validates the response origin, source, and ID, then cleans up", async () => {
  const harness = createHiddenIframeHarness();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: harness.documentApi });
  Object.defineProperty(globalThis, "window", { configurable: true, value: harness.windowApi });

  try {
    const chromeApi = {
      tabs: {
        query: async () => assert.fail("the hidden iframe must not query tabs"),
        create: async () => assert.fail("the hidden iframe must not create tabs"),
      },
      scripting: { executeScript: async () => assert.fail("the hidden iframe must not inject scripts") },
    };
    const request = createExtensionRequest(
      async () => assert.fail("parseShare must use the hidden iframe"),
      chromeApi,
    );
    const body = "{\"type\":\"video_channel_url\"}";
    const responsePromise = request(API_URLS.parseShare, { method: "POST", body });
    const [{ message, targetOrigin }] = harness.requestMessages;

    assert.equal(harness.iframe.hidden, true);
    assert.equal(harness.iframe.src, "https://yuanbao.tencent.com/");
    assert.deepEqual({ ...message }, {
      type: "weixin-channels-video:parse-request",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      body,
    });
    assert.equal(targetOrigin, "https://yuanbao.tencent.com");

    const response = {
      type: "weixin-channels-video:parse-response",
      requestId: message.requestId,
      status: 200,
      body: "{\"code\":0}",
    };
    harness.dispatchMessage(response, {}, "https://yuanbao.tencent.com");
    harness.dispatchMessage(response, harness.iframe.contentWindow, "https://attacker.example");
    harness.dispatchMessage({ ...response, requestId: "223e4567-e89b-42d3-a456-426614174000" });
    assert.equal(harness.state.iframeRemoved, false);
    assert.equal(harness.state.messageListeners, 1);

    harness.dispatchMessage(response);
    const resolved = await responsePromise;
    assert.deepEqual(await resolved.json(), { code: 0 });
    assert.deepEqual(harness.state, {
      iframeRemoved: true,
      iframeLoadListeners: 0,
      iframeErrorListeners: 0,
      messageListeners: 0,
      timeoutCleared: true,
    });
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});

test("hidden iframe requester cleans up on status 0 and timeout", async () => {
  for (const failure of ["status-zero", "timeout"]) {
    const harness = createHiddenIframeHarness();
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "document", { configurable: true, value: harness.documentApi });
    Object.defineProperty(globalThis, "window", { configurable: true, value: harness.windowApi });

    try {
      const request = createExtensionRequest(async () => assert.fail("parseShare must use the hidden iframe"));
      const responsePromise = request(API_URLS.parseShare, { method: "POST", body: "{}" });
      if (failure === "status-zero") {
        const [{ message }] = harness.requestMessages;
        harness.dispatchMessage({
          type: "weixin-channels-video:parse-response",
          requestId: message.requestId,
          status: 0,
          body: "",
        });
        await assert.rejects(responsePromise, /request failed/);
      } else {
        harness.expire();
        await assert.rejects(responsePromise, /request timed out/);
      }
      assert.deepEqual(harness.state, {
        iframeRemoved: true,
        iframeLoadListeners: 0,
        iframeErrorListeners: 0,
        messageListeners: 0,
        timeoutCleared: true,
      });
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else delete globalThis.document;
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else delete globalThis.window;
    }
  }
});

test("Yuanbao frame script accepts only its extension parent and fetches the fixed same-origin API", async () => {
  const source = await readFile(new URL("../extension/yuanbao-frame.js", import.meta.url), "utf8");
  const extensionOrigin = "chrome-extension://synthetic-extension-id";
  assert.equal(new URL(`${extensionOrigin}/`).origin, "null");
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const messages = [];
  const fetchCalls = [];
  let resolveResponse;
  const responsePosted = new Promise((resolve) => { resolveResponse = resolve; });
  const parent = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
      resolveResponse();
    },
  };
  const listeners = new Map();
  const windowApi = {
    parent,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
  };
  const fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return { status: 200, ok: true, text: async () => "{\"code\":0}" };
  };
  runInNewContext(source, {
    window: windowApi,
    location: { origin: "https://yuanbao.tencent.com" },
    chrome: { runtime: { getURL: () => `${extensionOrigin}/` } },
    URL,
    fetch,
  });
  const [onMessage] = listeners.get("message");
  const request = {
    type: "weixin-channels-video:parse-request",
    requestId,
    body: "{\"type\":\"video_channel_url\"}",
  };

  onMessage({ source: {}, origin: extensionOrigin, data: request });
  onMessage({ source: parent, origin: "https://attacker.example", data: request });
  onMessage({ source: parent, origin: extensionOrigin, data: { ...request, extra: true } });
  assert.equal(fetchCalls.length, 0);

  onMessage({ source: parent, origin: extensionOrigin, data: request });
  await responsePosted;
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://yuanbao.tencent.com/api/weixin/get_parse_result");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.deepEqual({ ...fetchCalls[0].init.headers }, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.equal(fetchCalls[0].init.body, request.body);
  assert.equal(fetchCalls[0].init.credentials, "include");
  assert.equal(fetchCalls[0].init.redirect, "error");
  assert.deepEqual(messages.map(({ message, targetOrigin }) => ({
    message: { ...message },
    targetOrigin,
  })), [{
    message: {
      type: "weixin-channels-video:parse-response",
      requestId,
      status: 200,
      body: "{\"code\":0}",
    },
    targetOrigin: extensionOrigin,
  }]);
  onMessage({
    source: parent,
    origin: extensionOrigin,
    data: { ...request, requestId: "223e4567-e89b-42d3-a456-426614174000" },
  });
  assert.equal(fetchCalls.length, 1);

  const topWindow = {
    addEventListener() { assert.fail("the top Yuanbao page must not register a listener"); },
  };
  topWindow.parent = topWindow;
  runInNewContext(source, {
    window: topWindow,
    location: { origin: "https://yuanbao.tencent.com" },
  });
});

test("feed requests use a temporary same-origin preview tab and the core token referer", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const onUpdated = createEvent();
  const onRemoved = createEvent();
  const expectedReferer =
    "https://channels.weixin.qq.com/finder-preview/pages/feed?entry_card_type=48&comment_scene=39&appid=0&token=synthetic-token&eid=synthetic-eid";
  const feedPageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", feedPageUrl);
  const body = JSON.stringify({ baseReq: { generalToken: "synthetic-token" }, exportId: "synthetic-eid" });
  let createdTab;
  let currentTab;
  let removedTabs = [];
  let pageRequest;
  let injection;

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://channels.weixin.qq.com", pathname: "/finder-preview/pages/feed" },
  });
  globalThis.fetch = async (url, init) => {
    pageRequest = { url, init };
    return Response.json({ errCode: 0 });
  };
  const chromeApi = {
    tabs: {
      create: async (options) => {
        createdTab = options;
        currentTab = { id: 73, status: "loading", url: options.url };
        setTimeout(() => {
          if (!currentTab) return;
          currentTab = { ...currentTab, status: "complete" };
          onUpdated.dispatch(73, { status: "complete" }, currentTab);
        }, 0);
        return currentTab;
      },
      get: async (tabId) => {
        assert.equal(tabId, 73);
        if (!currentTab) throw new Error("No tab with id: 73");
        return currentTab;
      },
      remove: async (tabId) => {
        removedTabs.push(tabId);
        currentTab = null;
      },
      onUpdated,
      onRemoved,
    },
    scripting: {
      executeScript: async (details) => {
        injection = details;
        return [{ result: await details.func(...details.args) }];
      },
    },
  };
  const request = createExtensionRequest(async () => assert.fail("feed must use the preview tab"), chromeApi);

  try {
    const response = await request(feedUrl.href, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://channels.weixin.qq.com",
        referer: expectedReferer,
        cookie: "must-not-be-sent",
      },
      body,
      credentials: "include",
    });

    assert.deepEqual(createdTab, { url: feedPageUrl, active: false });
    assert.equal(createdTab.url.includes("synthetic-token"), false);
    assert.equal(injection.target.tabId, 73);
    assert.equal(injection.world, "MAIN");
    assert.equal(pageRequest.url, feedUrl.href);
    assert.deepEqual(pageRequest.init, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
      credentials: "omit",
      redirect: "error",
      referrer: expectedReferer,
      referrerPolicy: "same-origin",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { errCode: 0 });
    assert.deepEqual(removedTabs, [73]);
    assert.equal(onUpdated.listenerCount, 0);
    assert.equal(onRemoved.listenerCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
  }
});

test("feed requests close their temporary tab and do not inject after a page redirect", async () => {
  const onUpdated = createEvent();
  const onRemoved = createEvent();
  let removedTab;
  let injected = false;
  const chromeApi = {
    tabs: {
      create: async () => ({ id: 74, status: "complete", url: "https://attacker.example/" }),
      get: async () => ({ id: 74, status: "complete", url: "https://attacker.example/" }),
      remove: async (tabId) => { removedTab = tabId; },
      onUpdated,
      onRemoved,
    },
    scripting: { executeScript: async () => { injected = true; } },
  };
  const request = createExtensionRequest(async () => assert.fail("feed must use the preview tab"), chromeApi);
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", "https://channels.weixin.qq.com/finder-preview/pages/feed");

  await assert.rejects(
    request(feedUrl.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: "https://channels.weixin.qq.com/finder-preview/pages/feed?token=synthetic-token&eid=synthetic-eid",
      },
      body: "{}",
    }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "视频详情页面请求失败。");
      return true;
    },
  );
  assert.equal(injected, false);
  assert.equal(removedTab, 74);
  assert.equal(onUpdated.listenerCount, 0);
  assert.equal(onRemoved.listenerCount, 0);
});

test("feed requests stop and remove listeners when the temporary tab is closed while loading", async () => {
  const onUpdated = createEvent();
  const onRemoved = createEvent();
  let currentTab = { id: 75, status: "loading", url: "https://channels.weixin.qq.com/finder-preview/pages/feed" };
  let injected = false;
  const chromeApi = {
    tabs: {
      create: async () => {
        setTimeout(() => {
          currentTab = null;
          onRemoved.dispatch(75);
        }, 0);
        return currentTab;
      },
      get: async () => {
        if (!currentTab) throw new Error("No tab with id: 75");
        return currentTab;
      },
      remove: async () => {
        if (!currentTab) throw new Error("No tab with id: 75");
        currentTab = null;
      },
      onUpdated,
      onRemoved,
    },
    scripting: { executeScript: async () => { injected = true; } },
  };
  const request = createExtensionRequest(async () => assert.fail("feed must use the preview tab"), chromeApi);
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", "https://channels.weixin.qq.com/finder-preview/pages/feed");

  await assert.rejects(
    request(feedUrl.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: "https://channels.weixin.qq.com/finder-preview/pages/feed?token=synthetic-token&eid=synthetic-eid",
      },
      body: "{}",
    }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "视频详情页面请求失败。");
      return true;
    },
  );
  assert.equal(injected, false);
  assert.equal(onUpdated.listenerCount, 0);
  assert.equal(onRemoved.listenerCount, 0);
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
  assert.deepEqual(manifest.permissions, ["downloads", "scripting"]);
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
  assert.equal(manifest.background.service_worker, "background.mjs");
  assert.equal(manifest.action.default_popup, undefined);
});

test("toolbar action opens the full extension page in a new tab", async () => {
  const previousChrome = globalThis.chrome;
  let onClicked;
  let createdTab;
  globalThis.chrome = {
    action: { onClicked: { addListener: (listener) => { onClicked = listener; } } },
    runtime: { getURL: (path) => `chrome-extension://synthetic-id/${path}` },
    tabs: { create: (properties) => { createdTab = properties; } },
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
