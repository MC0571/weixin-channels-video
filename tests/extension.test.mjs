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

test("shared hidden iframe requester handles both API steps and preserves HTTP status", async () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const channelsOrigin = "https://channels.weixin.qq.com";
  const channelsPageUrl = channelsOrigin + "/finder-preview/pages/feed";
  const referer = channelsPageUrl +
    "?entry_card_type=48&comment_scene=39&appid=0&token=synthetic-token&eid=synthetic-eid";
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", channelsPageUrl);
  const parseBody = JSON.stringify({
    type: "video_channel_url",
    url: "https://weixin.qq.com/sph/synthetic-id",
    scene: 1,
  });
  const feedBody = JSON.stringify({
    baseReq: { generalToken: "synthetic-token" },
    exportId: "synthetic-eid",
  });
  const routes = [
    {
      apiUrl: API_URLS.parseShare,
      init: { method: "POST", body: parseBody },
      frameUrl: "https://yuanbao.tencent.com/",
      origin: "https://yuanbao.tencent.com",
      expectedMessage: {
        type: "weixin-channels-video:api-request",
        requestId,
        body: parseBody,
      },
      status: 200,
      responseBody: "{\"code\":0}",
    },
    {
      apiUrl: feedUrl.href,
      init: { method: "POST", headers: { referer }, body: feedBody },
      frameUrl: channelsPageUrl,
      origin: channelsOrigin,
      expectedMessage: {
        type: "weixin-channels-video:api-request",
        requestId,
        body: feedBody,
        url: feedUrl.href,
        referer,
      },
      status: 401,
      responseBody: "",
    },
  ];

  for (const route of routes) {
    const harness = createHiddenIframeHarness();
    await withHiddenIframeHarness(harness, async () => {
      const request = createExtensionRequest(async () => assert.fail("both API steps must use hidden iframes"));
      const responsePromise = request(route.apiUrl, route.init);
      const [{ message, targetOrigin }] = harness.requestMessages;

      assert.equal(harness.iframe.hidden, true);
      assert.equal(harness.iframe.src, route.frameUrl);
      assert.equal(harness.iframe.title, "");
      assert.equal(harness.iframe.tabIndex, -1);
      assert.deepEqual({ ...message }, route.expectedMessage);
      assert.equal(targetOrigin, route.origin);

      const resultMessage = {
        type: "weixin-channels-video:api-response",
        requestId,
        status: route.status,
        body: route.responseBody,
      };
      harness.dispatchMessage(resultMessage, {}, route.origin);
      harness.dispatchMessage(resultMessage, harness.iframe.contentWindow, "https://attacker.example");
      harness.dispatchMessage({
        ...resultMessage,
        requestId: "223e4567-e89b-42d3-a456-426614174000",
      }, harness.iframe.contentWindow, route.origin);
      assert.equal(harness.state.iframeRemoved, false);
      assert.equal(harness.state.messageListeners, 1);

      harness.dispatchMessage(resultMessage, harness.iframe.contentWindow, route.origin);
      const response = await responsePromise;
      assert.equal(response.status, route.status);
      assert.equal(await response.text(), route.responseBody);
      assert.deepEqual(harness.state, {
        iframeRemoved: true,
        iframeLoadListeners: 0,
        iframeErrorListeners: 0,
        messageListeners: 0,
        timeoutCleared: true,
      });
    });
  }
});

test("Channels hidden iframe reports fixed failure and timeout messages and cleans up", async () => {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const referer = pageUrl + "?token=synthetic-token&eid=synthetic-eid";
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", pageUrl);

  for (const failure of ["status-zero", "timeout"]) {
    const harness = createHiddenIframeHarness();
    await withHiddenIframeHarness(harness, async () => {
      const request = createExtensionRequest(async () => assert.fail("feed must use the hidden iframe"));
      const responsePromise = request(feedUrl.href, {
        method: "POST",
        headers: { referer },
        body: "{}",
      });
      const [{ message }] = harness.requestMessages;
      const expectedMessage = failure === "timeout"
        ? "视频详情隐藏页面请求超时。"
        : "视频详情隐藏页面请求失败。";

      if (failure === "status-zero") {
        harness.dispatchMessage({
          type: "weixin-channels-video:api-response",
          requestId: message.requestId,
          status: 0,
          body: "",
        }, harness.iframe.contentWindow, "https://channels.weixin.qq.com");
      } else {
        harness.expire();
      }

      await assert.rejects(responsePromise, (error) => {
        assert.equal(error.code, "UPSTREAM_ERROR");
        assert.equal(error.message, expectedMessage);
        assert.equal(error.message.includes("synthetic-token"), false);
        return true;
      });
      assert.deepEqual(harness.state, {
        iframeRemoved: true,
        iframeLoadListeners: 0,
        iframeErrorListeners: 0,
        messageListeners: 0,
        timeoutCleared: true,
      });
    });
  }
});

test("API frame bridge routes fixed Yuanbao and Channels requests with required fetch options", async () => {
  const source = await readFile(new URL("../extension/api-frame.js", import.meta.url), "utf8");
  const extensionOrigin = "chrome-extension://synthetic-extension-id";
  assert.equal(new URL(extensionOrigin + "/").origin, "null");
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const channelsOrigin = "https://channels.weixin.qq.com";
  const channelsPagePath = "/finder-preview/pages/feed";
  const channelsPageUrl = channelsOrigin + channelsPagePath;
  const referer = channelsPageUrl +
    "?entry_card_type=48&comment_scene=39&appid=0&token=synthetic-token&eid=synthetic-eid";
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", channelsPageUrl);
  const parseBody = JSON.stringify({ type: "video_channel_url" });
  const feedBody = JSON.stringify({ baseReq: { generalToken: "synthetic-token" }, exportId: "synthetic-eid" });
  const routes = [
    {
      origin: "https://yuanbao.tencent.com",
      path: "/",
      request: {
        type: "weixin-channels-video:api-request",
        requestId,
        body: parseBody,
      },
      expectedUrl: "https://yuanbao.tencent.com/api/weixin/get_parse_result",
      expectedBody: parseBody,
      credentials: "include",
      response: { status: 200, ok: true, text: async () => "{\"code\":0}" },
      expectedResponse: {
        type: "weixin-channels-video:api-response",
        requestId,
        status: 200,
        body: "{\"code\":0}",
      },
    },
    {
      origin: channelsOrigin,
      path: channelsPagePath,
      request: {
        type: "weixin-channels-video:api-request",
        requestId,
        body: feedBody,
        url: feedUrl.href,
        referer,
      },
      expectedUrl: feedUrl.href,
      expectedBody: feedBody,
      credentials: "omit",
      referrer: referer,
      response: { status: 401, ok: false, text: async () => assert.fail("error response body must not be read") },
      expectedResponse: {
        type: "weixin-channels-video:api-response",
        requestId,
        status: 401,
        body: "",
      },
    },
  ];

  function createFrame(route) {
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
    const fetch = async (url, init) => {
      fetchCalls.push({ url, init });
      return route.response;
    };
    runInNewContext(source, {
      window: windowApi,
      location: { origin: route.origin, pathname: route.path },
      chrome: { runtime: { getURL: () => extensionOrigin + "/" } },
      URL,
      fetch,
    });
    return { fetchCalls, messages, listener: listeners[0], parent };
  }

  for (const route of routes) {
    const frame = createFrame(route);
    const invalidMessages = [
      { source: {}, origin: extensionOrigin, data: route.request },
      { source: frame.parent, origin: "https://attacker.example", data: route.request },
      { source: frame.parent, origin: extensionOrigin, data: { ...route.request, extra: true } },
    ];
    if (route.origin === channelsOrigin) {
      invalidMessages.push(
        {
          source: frame.parent,
          origin: extensionOrigin,
          data: { ...route.request, url: "https://attacker.example/collect" },
        },
        {
          source: frame.parent,
          origin: extensionOrigin,
          data: { ...route.request, referer: "https://attacker.example/feed?token=x&eid=y" },
        },
      );
    }
    for (const event of invalidMessages) frame.listener(event);
    assert.equal(frame.fetchCalls.length, 0);

    frame.listener({ source: frame.parent, origin: extensionOrigin, data: route.request });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(frame.fetchCalls.length, 1);
    const [call] = frame.fetchCalls;
    assert.equal(call.url, route.expectedUrl);
    assert.equal(call.init.method, "POST");
    assert.deepEqual({ ...call.init.headers }, {
      accept: "application/json",
      "content-type": "application/json",
    });
    assert.equal(call.init.body, route.expectedBody);
    assert.equal(call.init.credentials, route.credentials);
    assert.equal(call.init.redirect, "error");
    if (route.referrer) {
      assert.equal(call.init.referrer, route.referrer);
      assert.equal(call.init.referrerPolicy, "same-origin");
    } else {
      assert.equal(Object.hasOwn(call.init, "referrer"), false);
      assert.equal(Object.hasOwn(call.init, "referrerPolicy"), false);
    }
    assert.deepEqual(frame.messages.map(({ message, targetOrigin }) => ({
      message: { ...message },
      targetOrigin,
    })), [{ message: route.expectedResponse, targetOrigin: extensionOrigin }]);
    frame.listener({ source: frame.parent, origin: extensionOrigin, data: route.request });
    assert.equal(frame.fetchCalls.length, 1);
  }
});

test("Channels iframe rejects a feed request after its page path changes", async () => {
  const source = await readFile(new URL("../extension/api-frame.js", import.meta.url), "utf8");
  const extensionOrigin = "chrome-extension://synthetic-extension-id";
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const location = {
    origin: "https://channels.weixin.qq.com",
    pathname: "/finder-preview/pages/feed",
  };
  const fetchCalls = [];
  const parent = { postMessage() { assert.fail("a stale feed page must not respond"); } };
  const listeners = [];
  const windowApi = {
    parent,
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.push(listener);
    },
  };
  runInNewContext(source, {
    window: windowApi,
    location,
    chrome: { runtime: { getURL: () => extensionOrigin + "/" } },
    URL,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return { status: 200, ok: true, text: async () => "{}" };
    },
  });
  const feedUrl = new URL(API_URLS.feedInfo);
  feedUrl.searchParams.set("_rid", "synthetic-rid");
  feedUrl.searchParams.set("_pageUrl", "https://channels.weixin.qq.com/finder-preview/pages/feed");
  const request = {
    type: "weixin-channels-video:api-request",
    requestId,
    body: "{}",
    url: feedUrl.href,
    referer: "https://channels.weixin.qq.com/finder-preview/pages/feed?token=x&eid=y",
  };

  location.pathname = "/finder-preview/pages/another";
  listeners[0]({ source: parent, origin: extensionOrigin, data: request });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 0);
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
  assert.deepEqual(manifest.permissions, ["downloads"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://yuanbao.tencent.com/*",
    "https://channels.weixin.qq.com/*",
  ]);
  assert.deepEqual(manifest.content_scripts, [{
    matches: [
      "https://yuanbao.tencent.com/*",
      "https://channels.weixin.qq.com/finder-preview/pages/feed*",
    ],
    all_frames: true,
    run_at: "document_start",
    js: ["api-frame.js"],
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
