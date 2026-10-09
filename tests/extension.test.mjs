import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createExtensionRequest,
  downloadStatus,
  latestDownload,
  safeFilename,
  startDownload,
} from "../extension/app.mjs";
import { API_URLS, parseShareLink } from "../src/core.mjs";

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

test("parseShare requests run in the open Yuanbao tab and return only serializable response data", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  let injected;
  let tabQuery;
  let pageRequest;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://yuanbao.tencent.com" },
  });
  globalThis.fetch = async (url, init) => {
    pageRequest = { url, init };
    return new Response("synthetic parse denial", { status: 403 });
  };
  const request = createExtensionRequest(async () => {
    throw new Error("parse request must use the Yuanbao tab");
  }, {
    tabs: {
      query: async (query) => {
        tabQuery = query;
        return [{ id: 12 }];
      },
    },
    scripting: {
      executeScript: async (details) => {
        injected = details;
        return [{ result: await details.func(...details.args) }];
      },
    },
  });

  try {
    const response = await request(API_URLS.parseShare, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{\"type\":\"video_channel_url\"}",
    });
    assert.deepEqual(tabQuery, { url: "https://yuanbao.tencent.com/*" });
    assert.equal(injected.target.tabId, 12);
    assert.equal(injected.world, "MAIN");
    assert.deepEqual(pageRequest, {
      url: "https://yuanbao.tencent.com/api/weixin/get_parse_result",
      init: {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: "{\"type\":\"video_channel_url\"}",
        credentials: "include",
        redirect: "error",
      },
    });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
  }
});

test("parseShare injection does not request when the selected tab has navigated to another origin", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  let fetchCalled = false;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://attacker.example" },
  });
  globalThis.fetch = async () => {
    fetchCalled = true;
    return Response.json({});
  };
  const request = createExtensionRequest(async () => assert.fail("must use the Yuanbao tab"), {
    tabs: { query: async () => [{ id: 12 }] },
    scripting: {
      executeScript: async (details) => [{ result: await details.func(...details.args) }],
    },
  });

  try {
    await assert.rejects(
      request(API_URLS.parseShare, { method: "POST", body: "{}" }),
      /origin changed/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
  }
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

test("parseShare requests explain when no Yuanbao tab is open and leave other requests unchanged", async () => {
  const calls = [];
  const request = createExtensionRequest(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      userId: "synthetic-user",
      needRefreshToken: false,
      anonUser: { isAnon: false },
    }));
  }, {
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => assert.fail("must not inject without a tab") },
  });

  await assert.rejects(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request }),
    (error) => {
      assert.equal(error.code, "LOGIN_CHECK_FAILED");
      assert.equal(error.message, "请在当前 Chrome 中打开已登录的元宝页面，并保持该标签页打开。");
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API_URLS.userInfo);
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
