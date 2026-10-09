export const API_URLS = Object.freeze({
  userInfo: "https://yuanbao.tencent.com/api/getuserinfo",
  parseShare: "https://yuanbao.tencent.com/api/weixin/get_parse_result",
  feedInfo: "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info",
});

const MESSAGES = Object.freeze({
  INVALID_URL: "仅支持有效的微信视频号分享链接。",
  AUTH_EXPIRED: "元宝登录已失效，请重新登录。",
  LOGIN_CHECK_FAILED: "元宝登录状态检查失败。",
  FEED_UNAVAILABLE: "视频内容不可用。",
  UPSTREAM_ERROR: "上游解析失败。",
});

export class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

function fail(code) {
  throw new ParseError(code, MESSAGES[code]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function checkLogin(request) {
  if (typeof request !== "function") fail("LOGIN_CHECK_FAILED");

  let response;
  try {
    response = await request(API_URLS.userInfo, { method: "GET" });
  } catch {
    fail("LOGIN_CHECK_FAILED");
  }

  if (response?.status === 401 || response?.status === 403) {
    return { status: "anonymous" };
  }
  if (response?.ok !== true) fail("LOGIN_CHECK_FAILED");

  let result;
  try {
    result = await response.json();
  } catch {
    fail("LOGIN_CHECK_FAILED");
  }

  const anonUser = isRecord(result) && result.anonUser;
  if (
    !isRecord(result) ||
    typeof result.userId !== "string" ||
    typeof result.needRefreshToken !== "boolean" ||
    !isRecord(anonUser) ||
    typeof anonUser.isAnon !== "boolean"
  ) {
    fail("LOGIN_CHECK_FAILED");
  }

  return {
    status:
      anonUser.isAnon || !result.userId.trim() || result.needRefreshToken
        ? "anonymous"
        : "authenticated",
  };
}

function validateShareUrl(value) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_URL");

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail("INVALID_URL");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "weixin.qq.com" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    fail("INVALID_URL");
  }

  const match = url.pathname.match(/^\/sph\/([^/]+)\/?$/);
  if (!match) fail("INVALID_URL");
  try {
    const pathId = decodeURIComponent(match[1]);
    if (!pathId.trim() || pathId.includes("/") || pathId.includes("\\")) {
      fail("INVALID_URL");
    }
  } catch (error) {
    if (error instanceof ParseError) throw error;
    fail("INVALID_URL");
  }

  return url;
}

async function readJson(request, url, init, code, authCode, stepName) {
  let response;
  try {
    response = await request(url, init);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError(code, `${stepName}请求失败。`);
  }

  if (authCode && response?.status === 401) {
    fail(authCode);
  }
  if (response?.ok !== true) {
    if (Number.isInteger(response?.status) && response.status >= 400 && response.status <= 599) {
      throw new ParseError(code, `${stepName}接口请求失败（HTTP ${response.status}）。`);
    }
    fail(code);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    fail(code);
  }
  if (!isRecord(result)) fail(code);
  return result;
}

function textField(record, key) {
  const value = record?.[key];
  if (value == null) return "";
  if (typeof value !== "string") fail("UPSTREAM_ERROR");
  return value.trim();
}

function optionalHttpsUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("UPSTREAM_ERROR");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail("UPSTREAM_ERROR");
  }
  return url.href;
}

function feedUnavailable(result) {
  if (result.errCode !== undefined) {
    if (!Number.isInteger(result.errCode)) fail("UPSTREAM_ERROR");
    if (result.errCode !== 0) fail("FEED_UNAVAILABLE");
  }

  const detail = result.data?.errMsg;
  if (detail == null) return;
  if (!isRecord(detail)) fail("UPSTREAM_ERROR");
  const type = detail.type ?? 0;
  const title = detail.title ?? "";
  const content = detail.content ?? "";
  if (
    !Number.isInteger(type) ||
    typeof title !== "string" ||
    typeof content !== "string"
  ) {
    fail("UPSTREAM_ERROR");
  }
  if (type !== 0 || title.trim() || content.trim()) fail("FEED_UNAVAILABLE");
}

function randomRequestId() {
  const random = Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0");
  return `${Math.floor(Date.now() / 1000).toString(16)}-${random}`;
}

function feedRequestUrl(generalToken, exportId) {
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", randomRequestId());
  url.searchParams.set(
    "_pageUrl",
    "https://channels.weixin.qq.com/finder-preview/pages/feed",
  );

  const referer = new URL(
    "https://channels.weixin.qq.com/finder-preview/pages/feed",
  );
  referer.searchParams.set("entry_card_type", "48");
  referer.searchParams.set("comment_scene", "39");
  referer.searchParams.set("appid", "0");
  referer.searchParams.set("token", generalToken);
  referer.searchParams.set("entry_scene", "0");
  referer.searchParams.set("eid", exportId);

  return { url: url.href, referer: referer.href };
}

export async function parseShareLink(value, options = {}) {
  const shareUrl = validateShareUrl(value);
  const request = options?.request;
  if (typeof request !== "function") fail("LOGIN_CHECK_FAILED");

  const login = await checkLogin(request);
  if (login.status === "anonymous") fail("AUTH_EXPIRED");

  const parsed = await readJson(
    request,
    API_URLS.parseShare,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        type: "video_channel_url",
        url: shareUrl.href,
        scene: 1,
      }),
    },
    "UPSTREAM_ERROR",
    "AUTH_EXPIRED",
    "元宝解析",
  );
  if (parsed.code !== undefined && parsed.code !== 0) fail("UPSTREAM_ERROR");

  const parseData = parsed.data;
  if (!isRecord(parseData) || typeof parseData.playable_url !== "string") {
    fail("UPSTREAM_ERROR");
  }

  let playableUrl;
  try {
    playableUrl = new URL(parseData.playable_url);
  } catch {
    fail("UPSTREAM_ERROR");
  }
  const generalToken = playableUrl.searchParams.get("token");
  const exportId = playableUrl.searchParams.get("eid");
  if (!generalToken || !exportId) fail("UPSTREAM_ERROR");

  const { url: feedUrl, referer } = feedRequestUrl(generalToken, exportId);
  const feed = await readJson(
    request,
    feedUrl,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://channels.weixin.qq.com",
        referer,
      },
      body: JSON.stringify({ baseReq: { generalToken }, exportId }),
    },
    "UPSTREAM_ERROR",
    undefined,
    "视频详情",
  );
  feedUnavailable(feed);

  const data = feed.data;
  const feedInfo = data?.feedInfo;
  if (!isRecord(data) || !isRecord(feedInfo)) fail("UPSTREAM_ERROR");

  const h264 = feedInfo.h264VideoInfo;
  const h265 = feedInfo.h265VideoInfo;
  if (
    (h264 != null && !isRecord(h264)) ||
    (h265 != null && !isRecord(h265))
  ) {
    fail("UPSTREAM_ERROR");
  }
  const selectedMedia =
    textField(h264, "videoUrl") ||
    textField(feedInfo, "videoUrl") ||
    textField(h265, "videoUrl");
  if (!selectedMedia) fail("FEED_UNAVAILABLE");
  const mediaUrl = optionalHttpsUrl(selectedMedia);

  const authorInfo = data.authorInfo;
  if (authorInfo != null && !isRecord(authorInfo)) fail("UPSTREAM_ERROR");
  const picInfo = feedInfo.picInfo;
  if (picInfo != null && !Array.isArray(picInfo)) fail("UPSTREAM_ERROR");
  const firstPicture = picInfo?.find((picture) => isRecord(picture) && picture.url);
  const coverUrl =
    optionalHttpsUrl(textField(feedInfo, "coverUrl")) ||
    optionalHttpsUrl(textField(parseData, "cover_url")) ||
    optionalHttpsUrl(textField(firstPicture, "url"));

  return {
    sourceUrl: shareUrl.href,
    title: textField(feedInfo, "description") || textField(parseData, "desc"),
    author: textField(authorInfo, "nickname") || textField(parseData, "author"),
    coverUrl,
    previewUrl: mediaUrl,
    downloadUrl: mediaUrl,
  };
}
