import { API_URLS, ParseError, parseShareLink } from "../src/core.mjs";

const ENDPOINTS = new Map([
  [API_URLS.userInfo, { method: "GET", host: "yuanbao.tencent.com" }],
  [API_URLS.parseShare, { method: "POST", host: "yuanbao.tencent.com" }],
  [API_URLS.feedInfo, { method: "POST", host: "channels.weixin.qq.com" }],
]);
const CHANNELS_ORIGIN = "https://channels.weixin.qq.com";
const CHANNELS_FEED_PAGE_PATH = "/finder-preview/pages/feed";
const CHANNELS_FEED_API_PATH = "/finder-preview/api/feed/get_feed_info";
const CHANNELS_FEED_PAGE_URL = `${CHANNELS_ORIGIN}${CHANNELS_FEED_PAGE_PATH}`;
const TAB_LOAD_TIMEOUT_MS = 15_000;

function parseFeedPageUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.origin !== CHANNELS_ORIGIN ||
      url.pathname !== CHANNELS_FEED_PAGE_PATH ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function waitForTabComplete(chromeApi, tabId) {
  return new Promise((resolve, reject) => {
    const { tabs } = chromeApi;
    let settled = false;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      tabs.onUpdated.removeListener(onUpdated);
      tabs.onRemoved.removeListener(onRemoved);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const checkTab = async () => {
      try {
        const tab = await tabs.get(tabId);
        if (tab.status === "complete") finish(resolve, tab);
      } catch (error) {
        finish(reject, error);
      }
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") void checkTab();
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(reject, new Error("Feed page tab was closed"));
    };

    tabs.onUpdated.addListener(onUpdated);
    tabs.onRemoved.addListener(onRemoved);
    timeout = setTimeout(
      () => finish(reject, new Error("Feed page load timed out")),
      TAB_LOAD_TIMEOUT_MS,
    );
    void checkTab();
  });
}

async function closeCreatedTab(chromeApi, tabId) {
  try {
    await chromeApi.tabs.remove(tabId);
  } catch (error) {
    try {
      await chromeApi.tabs.get(tabId);
    } catch {
      return;
    }
    throw error;
  }
}

function responseFromPageResult(result) {
  if (!result || !Number.isInteger(result.status) || typeof result.body !== "string") {
    throw new TypeError("The page request returned an invalid response");
  }
  return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
    status: result.status,
  });
}

async function requestFeedInfoInPage(chromeApi, url, init, referer) {
  let tabId;
  try {
    const tab = await chromeApi.tabs.create({ url: CHANNELS_FEED_PAGE_URL, active: false });
    tabId = tab?.id;
    if (typeof tabId !== "number") throw new Error("Feed page tab could not be created");

    const loadedTab = await waitForTabComplete(chromeApi, tabId);
    if (!parseFeedPageUrl(loadedTab.url)) throw new Error("Feed page redirected outside its fixed path");

    const [injection] = await chromeApi.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async ({ url, body, referer }) => {
        const origin = "https://channels.weixin.qq.com";
        const pagePath = "/finder-preview/pages/feed";
        const apiPath = "/finder-preview/api/feed/get_feed_info";
        const target = new URL(url);
        const requestReferer = new URL(referer);
        if (
          location.origin !== origin ||
          location.pathname !== pagePath ||
          target.origin !== origin ||
          target.pathname !== apiPath ||
          requestReferer.origin !== origin ||
          requestReferer.pathname !== pagePath
        ) {
          throw new Error("Feed page or API origin changed before parsing");
        }

        const response = await fetch(target.href, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body,
          credentials: "omit",
          redirect: "error",
          referrer: requestReferer.href,
          referrerPolicy: "same-origin",
        });
        return {
          status: response.status,
          body: response.ok ? await response.text() : "",
        };
      },
      args: [{ url: url.href, body: init.body, referer }],
    });
    return responseFromPageResult(injection?.result);
  } catch {
    throw new ParseError("UPSTREAM_ERROR", "视频详情页面请求失败。");
  } finally {
    if (typeof tabId === "number") await closeCreatedTab(chromeApi, tabId);
  }
}

export function createExtensionRequest(fetchImpl = globalThis.fetch, chromeApi = globalThis.chrome) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  return async (value, init = {}) => {
    let url;
    try {
      url = new URL(typeof value === "string" ? value : value.href);
    } catch {
      throw new TypeError("Only fixed upstream API endpoints are allowed");
    }

    const endpoint = ENDPOINTS.get(`${url.origin}${url.pathname}`);
    if (!endpoint || url.username || url.password || url.hash) {
      throw new TypeError("Only fixed upstream API endpoints are allowed");
    }
    if (String(init.method || "GET").toUpperCase() !== endpoint.method) {
      throw new TypeError("Method is not allowed for this API endpoint");
    }

    if (url.href === API_URLS.parseShare) {
      const [tab] = await chromeApi.tabs.query({ url: "https://yuanbao.tencent.com/*" });
      if (typeof tab?.id !== "number") {
        throw new ParseError(
          "LOGIN_CHECK_FAILED",
          "请在当前 Chrome 中打开已登录的元宝页面，并保持该标签页打开。",
        );
      }

      const [injection] = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: async (body) => {
          if (location.origin !== "https://yuanbao.tencent.com") {
            throw new Error("Yuanbao tab origin changed before parsing");
          }
          const response = await fetch("https://yuanbao.tencent.com/api/weixin/get_parse_result", {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body,
            credentials: "include",
            redirect: "error",
          });
          return {
            status: response.status,
            body: [401, 403].includes(response.status) ? "" : await response.text(),
          };
        },
        args: [init.body],
      });
      return responseFromPageResult(injection?.result);
    }

    if (endpoint.host === "channels.weixin.qq.com") {
      const referer = parseFeedPageUrl(new Headers(init.headers).get("referer"));
      if (!referer) throw new TypeError("The feed page referer is invalid");
      return requestFeedInfoInPage(chromeApi, url, init, referer.href);
    }

    const headers = new Headers(init.headers);
    for (const name of ["origin", "referer", "cookie", "authorization", "proxy-authorization"]) {
      headers.delete(name);
    }

    return fetchImpl(url.href, {
      ...init,
      method: endpoint.method,
      headers,
      credentials: endpoint.host === "yuanbao.tencent.com" ? "include" : "omit",
      redirect: "error",
    });
  };
}

export function safeFilename(title) {
  const name = String(title || "weixin-video")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\.+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return `${name || "weixin-video"}.mp4`;
}

export async function startDownload(result, chromeApi = globalThis.chrome) {
  if (!chromeApi?.downloads?.download) throw new TypeError("Chrome downloads API is unavailable");
  const url = new URL(result.downloadUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("Only HTTPS media URLs can be downloaded");
  }

  return chromeApi.downloads.download({
    url: url.href,
    filename: safeFilename(result.title),
    conflictAction: "uniquify",
  });
}

export async function latestDownload(chromeApi = globalThis.chrome) {
  const items = await chromeApi.downloads.search({ orderBy: ["-startTime"], limit: 50 });
  return items.find((item) => item.byExtensionId === chromeApi.runtime.id) ?? null;
}

export function downloadStatus(item) {
  if (!item) return "还没有下载记录。";
  const filename = item.filename?.split(/[\\/]/).pop();
  const label = filename ? ` · ${filename}` : "";
  if (item.state === "in_progress") return `正在下载${label}`;
  if (item.state === "complete") return `下载完成${label}`;
  if (item.state === "interrupted") return `下载中断${label}`;
  return `下载状态未知${label}`;
}

function initializePage() {
  const form = document.querySelector("#parse-form");
  const input = document.querySelector("#share-url");
  const parseButton = document.querySelector("#parse-button");
  const parseStatus = document.querySelector("#parse-status");
  const resultCard = document.querySelector("#result-card");
  const title = document.querySelector("#video-title");
  const author = document.querySelector("#video-author");
  const cover = document.querySelector("#cover-image");
  const video = document.querySelector("#preview-video");
  const mediaVariants = document.querySelector("#media-variants");
  const downloadButton = document.querySelector("#download-button");
  const downloadStatusElement = document.querySelector("#download-status");
  let result = null;
  let visibleDownloadId = null;
  let parseGeneration = 0;
  let downloadInProgress = false;
  let metadataListeners = [];
  let metadataProbes = [];

  const setParseStatus = (message, isError = false) => {
    parseStatus.textContent = message;
    parseStatus.dataset.error = String(isError);
  };

  async function refreshDownloadStatus() {
    try {
      const item = await latestDownload(chrome);
      visibleDownloadId = item?.id ?? null;
      downloadStatusElement.textContent = downloadStatus(item);
    } catch {
      downloadStatusElement.textContent = "暂时无法读取下载状态。";
    }
  }

  function clearMediaVariants() {
    parseGeneration += 1;
    for (const { target, type, listener } of metadataListeners) {
      target.removeEventListener(type, listener);
    }
    metadataListeners = [];
    for (const probe of metadataProbes) {
      probe.pause();
      probe.removeAttribute("src");
      probe.load();
    }
    metadataProbes = [];
    mediaVariants.replaceChildren();
    return parseGeneration;
  }

  function renderMediaVariants(parsedResult, generation) {
    const defaultUrl = parsedResult.downloadUrl;

    for (const variant of parsedResult.mediaVariants) {
      const isDefault = variant.downloadUrl === defaultUrl;
      const row = document.createElement("li");
      const link = document.createElement("a");
      const name = document.createElement("span");
      const label = document.createElement("span");
      const defaultBadge = document.createElement("span");
      const resolution = document.createElement("span");
      const action = document.createElement("span");

      link.className = "media-variant-link";
      link.href = variant.downloadUrl;
      name.className = "media-variant-name";
      label.textContent = variant.label;
      defaultBadge.className = "media-variant-default";
      defaultBadge.textContent = "默认";
      defaultBadge.hidden = !isDefault;
      name.append(label, defaultBadge);
      resolution.className = "media-variant-resolution";
      resolution.textContent = "获取分辨率…";
      action.className = "media-variant-action";
      action.textContent = "下载";
      link.append(name, resolution, action);
      row.append(link);
      mediaVariants.append(row);

      const setResolution = (media) => {
        if (generation !== parseGeneration || result !== parsedResult) return;
        resolution.textContent = media.videoWidth > 0 && media.videoHeight > 0
          ? `${media.videoWidth} × ${media.videoHeight}`
          : "分辨率未知";
      };
      const watchMetadata = (media) => {
        if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
          setResolution(media);
          return;
        }
        const registrations = [];
        const stopWatching = () => {
          for (const registration of registrations) {
            media.removeEventListener(registration.type, registration.listener);
            const index = metadataListeners.indexOf(registration);
            if (index !== -1) metadataListeners.splice(index, 1);
          }
          registrations.length = 0;
        };
        const onMetadata = () => setResolution(media);
        const onError = () => {
          if (generation === parseGeneration && result === parsedResult) {
            resolution.textContent = "分辨率未知";
          }
        };
        const addListener = (type, listener) => {
          const registration = { target: media, type, listener };
          media.addEventListener(type, listener);
          metadataListeners.push(registration);
          registrations.push(registration);
        };
        const onMetadataResult = () => {
          stopWatching();
          onMetadata();
        };
        const onErrorResult = () => {
          stopWatching();
          onError();
        };
        for (const [type, listener] of [["loadedmetadata", onMetadataResult], ["error", onErrorResult]]) {
          addListener(type, listener);
        }
      };

      if (isDefault) {
        watchMetadata(video);
      } else {
        const probe = document.createElement("video");
        probe.preload = "metadata";
        metadataProbes.push(probe);
        watchMetadata(probe);
        probe.src = variant.downloadUrl;
        probe.load();
      }
    }
  }

  async function downloadMedia(downloadUrl) {
    if (!result || downloadInProgress) return;
    downloadInProgress = true;
    downloadButton.disabled = true;
    downloadStatusElement.textContent = "正在开始下载…";
    try {
      await startDownload({ ...result, downloadUrl }, chrome);
      await refreshDownloadStatus();
    } catch {
      downloadStatusElement.textContent = "下载无法启动，请检查浏览器下载设置。";
    } finally {
      downloadInProgress = false;
      downloadButton.disabled = !result;
    }
  }

  mediaVariants.addEventListener("click", (event) => {
    const link = event.target instanceof Element
      ? event.target.closest("a.media-variant-link")
      : null;
    if (!link) return;
    event.preventDefault();
    const variant = result?.mediaVariants.find((item) => item.downloadUrl === link.href);
    if (variant) void downloadMedia(variant.downloadUrl);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const generation = clearMediaVariants();
    parseButton.disabled = true;
    downloadButton.disabled = true;
    video.pause();
    video.removeAttribute("src");
    video.load();
    cover.hidden = true;
    cover.removeAttribute("src");
    resultCard.hidden = true;
    result = null;
    setParseStatus("正在检查登录状态并解析…");

    try {
      const parsedResult = await parseShareLink(input.value, { request: createExtensionRequest() });
      if (generation !== parseGeneration) return;
      result = parsedResult;
      title.textContent = parsedResult.title || "未命名视频";
      author.textContent = parsedResult.author || "作者信息不可用";
      cover.hidden = !parsedResult.coverUrl;
      if (parsedResult.coverUrl) cover.src = parsedResult.coverUrl;
      video.src = parsedResult.previewUrl;
      video.load();
      renderMediaVariants(parsedResult, generation);
      resultCard.hidden = false;
      downloadButton.disabled = false;
      setParseStatus("解析完成，可以预览或下载。");
    } catch (error) {
      if (generation === parseGeneration) {
        setParseStatus(error instanceof ParseError ? error.message : "解析请求失败，请稍后重试。", true);
      }
    } finally {
      if (generation === parseGeneration) parseButton.disabled = false;
    }
  });

  downloadButton.addEventListener("click", () => {
    if (result) void downloadMedia(result.downloadUrl);
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id === visibleDownloadId) void refreshDownloadStatus();
  });
  void refreshDownloadStatus();
}

if (typeof document !== "undefined" && globalThis.chrome?.downloads) {
  initializePage();
}
