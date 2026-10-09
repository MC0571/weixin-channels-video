import { API_URLS, ParseError, parseShareLink } from "../src/core.mjs";
import { isSafeRelativeMp4Filename } from "../src/download-filename.mjs";

const ENDPOINTS = new Map([
  [API_URLS.userInfo, { method: "GET", host: "yuanbao.tencent.com" }],
  [API_URLS.parseShare, { method: "POST", host: "yuanbao.tencent.com" }],
  [API_URLS.feedInfo, { method: "POST", host: "channels.weixin.qq.com" }],
]);
const YUANBAO_ORIGIN = "https://yuanbao.tencent.com";
const YUANBAO_HOME_URL = `${YUANBAO_ORIGIN}/`;
const API_REQUEST_TYPE = "weixin-channels-video:api-request";
const API_RESPONSE_TYPE = "weixin-channels-video:api-response";
const FEED_REQUEST_TYPE = "weixin-channels-video:feed-request";
const IFRAME_TIMEOUT_MS = 15_000;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function responseFromRequestResult(result) {
  if (!result || !Number.isInteger(result.status) || typeof result.body !== "string") {
    throw new TypeError("The page request returned an invalid response");
  }
  return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
    status: result.status,
  });
}

function requestParseShareInHiddenIframe(
  body,
  documentApi = globalThis.document,
  windowApi = globalThis.window,
) {
  if (typeof body !== "string") throw new TypeError("The parse request body must be a string");

  const requestId = windowApi.crypto.randomUUID();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError("A unique request ID is unavailable");

  const iframe = documentApi.createElement("iframe");
  iframe.hidden = true;
  iframe.title = "";
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.src = YUANBAO_HOME_URL;
  const requestMessage = { type: API_REQUEST_TYPE, requestId, body };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const cleanup = () => {
      windowApi.clearTimeout(timeoutId);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
      windowApi.removeEventListener("message", onMessage);
      iframe.remove();
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (kind) => finish(reject, new ParseError(
      "UPSTREAM_ERROR",
      `元宝解析请求${kind === "TIMEOUT" ? "超时" : "失败"}。`,
    ));
    const onLoad = () => {
      try {
        iframe.contentWindow?.postMessage(requestMessage, YUANBAO_ORIGIN);
      } catch {
        fail("FAILED");
      }
    };
    const onError = () => fail("FAILED");
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow || event.origin !== YUANBAO_ORIGIN) return;
      const message = event.data;
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        Object.keys(message).length !== 4 ||
        message.type !== API_RESPONSE_TYPE ||
        message.requestId !== requestId ||
        !Number.isInteger(message.status) ||
        (message.status !== 0 && (message.status < 200 || message.status > 599)) ||
        typeof message.body !== "string"
      ) {
        return;
      }
      if (message.status === 0) {
        fail("FAILED");
        return;
      }
      try {
        finish(resolve, responseFromRequestResult(message));
      } catch {
        fail("FAILED");
      }
    };

    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);
    windowApi.addEventListener("message", onMessage);
    timeoutId = windowApi.setTimeout(
      () => fail("TIMEOUT"),
      IFRAME_TIMEOUT_MS,
    );
    try {
      (documentApi.body ?? documentApi.documentElement).append(iframe);
    } catch {
      fail("FAILED");
    }
  });
}

async function requestFeedInfoInBackground(
  { url, referer, body },
  sendMessage = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime),
) {
  let result;
  try {
    result = await sendMessage({ type: FEED_REQUEST_TYPE, url, referer, body });
  } catch {
    throw new ParseError("UPSTREAM_ERROR", "视频详情请求失败。");
  }
  if (result?.status === 0) {
    throw new ParseError(
      "UPSTREAM_ERROR",
      result.failure === "timeout" ? "视频详情请求超时。" : "视频详情请求失败。",
    );
  }
  try {
    return responseFromRequestResult(result);
  } catch {
    throw new ParseError("UPSTREAM_ERROR", "视频详情请求失败。");
  }
}

export function createExtensionRequest(
  fetchImpl = globalThis.fetch,
  iframeRequester = requestParseShareInHiddenIframe,
  feedRequester = requestFeedInfoInBackground,
) {
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
    if (endpoint.host === "yuanbao.tencent.com" && ![API_URLS.userInfo, API_URLS.parseShare].includes(url.href)) {
      throw new TypeError("Only fixed upstream API endpoints are allowed");
    }
    if (String(init.method || "GET").toUpperCase() !== endpoint.method) {
      throw new TypeError("Method is not allowed for this API endpoint");
    }

    if (url.href === API_URLS.parseShare) {
      return iframeRequester(init.body);
    }

    if (endpoint.host === "channels.weixin.qq.com") {
      return feedRequester({
        url: url.href,
        referer: new Headers(init.headers).get("referer"),
        body: init.body,
      });
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
    // 80 UTF-16 units cap this name at 240 UTF-8 bytes, plus the 4-byte ".mp4" suffix.
    .slice(0, 80)
    .trim();
  return `${name || "weixin-video"}.mp4`;
}

export async function startDownload(result, chromeApi = globalThis.chrome, filename = safeFilename(result.title)) {
  if (!chromeApi?.downloads?.download) throw new TypeError("Chrome downloads API is unavailable");
  if (!isSafeRelativeMp4Filename(filename)) throw new TypeError("Only safe relative MP4 filenames are allowed");
  const url = new URL(result.downloadUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("Only HTTPS media URLs can be downloaded");
  }

  return chromeApi.downloads.download({
    url: url.href,
    filename,
    conflictAction: "uniquify",
  });
}

export async function waitForDownload(downloadId, chromeApi = globalThis.chrome, timeoutMs = 29 * 60_000) {
  if (!Number.isInteger(downloadId) || downloadId < 0 || !chromeApi?.downloads?.onChanged) {
    throw new TypeError("Chrome download tracking is unavailable");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      chromeApi.downloads.onChanged.removeListener(onChanged);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const readTerminalDownload = async () => {
      let item;
      try {
        [item] = await chromeApi.downloads.search({ id: downloadId });
      } catch {
        finish(reject, new Error("DOWNLOAD_STATUS_UNAVAILABLE"));
        return;
      }
      if (!item || !["complete", "interrupted"].includes(item.state)) return;
      if (!Number.isInteger(item.bytesReceived) || item.bytesReceived <= 0 || typeof item.filename !== "string" || !item.filename) {
        finish(reject, new Error("DOWNLOAD_EMPTY"));
        return;
      }
      finish(resolve, {
        state: item.state,
        path: item.filename,
        bytes: item.bytesReceived,
      });
    };
    const onChanged = (delta) => {
      if (delta.id === downloadId && (delta.state?.current === "complete" || delta.state?.current === "interrupted")) {
        void readTerminalDownload();
      }
    };

    chromeApi.downloads.onChanged.addListener(onChanged);
    timeoutId = setTimeout(() => finish(reject, new Error("DOWNLOAD_TIMEOUT")), timeoutMs);
    void readTerminalDownload();
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

if (typeof document !== "undefined" && document.querySelector("#parse-form") && globalThis.chrome?.downloads) {
  initializePage();
}
