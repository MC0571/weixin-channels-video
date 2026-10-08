import { API_URLS, ParseError, parseShareLink } from "../src/core.mjs";

const ENDPOINTS = new Map([
  [API_URLS.userInfo, { method: "GET", host: "yuanbao.tencent.com" }],
  [API_URLS.parseShare, { method: "POST", host: "yuanbao.tencent.com" }],
  [API_URLS.feedInfo, { method: "POST", host: "channels.weixin.qq.com" }],
]);

export function createExtensionRequest(fetchImpl = globalThis.fetch) {
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
  const downloadButton = document.querySelector("#download-button");
  const downloadStatusElement = document.querySelector("#download-status");
  let result = null;
  let visibleDownloadId = null;

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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    parseButton.disabled = true;
    downloadButton.disabled = true;
    resultCard.hidden = true;
    result = null;
    setParseStatus("正在检查登录状态并解析…");

    try {
      result = await parseShareLink(input.value, { request: createExtensionRequest() });
      title.textContent = result.title || "未命名视频";
      author.textContent = result.author || "作者信息不可用";
      cover.hidden = !result.coverUrl;
      if (result.coverUrl) cover.src = result.coverUrl;
      video.src = result.previewUrl;
      video.load();
      resultCard.hidden = false;
      downloadButton.disabled = false;
      setParseStatus("解析完成，可以预览或下载。");
    } catch (error) {
      setParseStatus(error instanceof ParseError ? error.message : "解析请求失败，请稍后重试。", true);
    } finally {
      parseButton.disabled = false;
    }
  });

  downloadButton.addEventListener("click", async () => {
    if (!result) return;
    downloadButton.disabled = true;
    downloadStatusElement.textContent = "正在开始下载…";
    try {
      await startDownload(result, chrome);
      await refreshDownloadStatus();
    } catch {
      downloadStatusElement.textContent = "下载无法启动，请检查浏览器下载设置。";
    } finally {
      downloadButton.disabled = false;
    }
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id === visibleDownloadId) void refreshDownloadStatus();
  });
  void refreshDownloadStatus();
}

if (typeof document !== "undefined" && globalThis.chrome?.downloads) {
  initializePage();
}
