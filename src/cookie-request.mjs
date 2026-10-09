import { API_URLS } from "./core.mjs";

const ENDPOINTS = new Map([
  [API_URLS.userInfo, { method: "GET", query: [] }],
  [API_URLS.parseShare, { method: "POST", query: [] }],
  [API_URLS.feedInfo, { method: "POST", query: ["_rid", "_pageUrl"] }],
]);

function matchEndpoint(value) {
  let url;
  try {
    url = new URL(typeof value === "string" ? value : value.href);
  } catch {
    throw new TypeError("Only fixed Yuanbao and Channels API endpoints are allowed");
  }

  if (url.username || url.password || url.hash) {
    throw new TypeError("Only fixed Yuanbao and Channels API endpoints are allowed");
  }

  const endpoint = ENDPOINTS.get(`${url.origin}${url.pathname}`);
  if (!endpoint) {
    throw new TypeError("Only fixed Yuanbao and Channels API endpoints are allowed");
  }

  const params = [...url.searchParams.keys()];
  if (
    params.some((key) => !endpoint.query.includes(key)) ||
    new Set(params).size !== params.length
  ) {
    throw new TypeError("Only fixed Yuanbao and Channels API endpoints are allowed");
  }

  return { url, endpoint };
}

export function createCookieRequest(cookie, fetchImpl = fetch) {
  if (typeof cookie !== "string" || /[\r\n]/.test(cookie)) {
    throw new TypeError("A valid Yuanbao cookie is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  return async (value, init = {}) => {
    const { url, endpoint } = matchEndpoint(value);
    const method = String(init.method || "GET").toUpperCase();
    if (method !== endpoint.method) {
      throw new TypeError("Method is not allowed for this API endpoint");
    }

    const headers = new Headers(init.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    headers.delete("proxy-authorization");
    if (url.hostname === "yuanbao.tencent.com") headers.set("cookie", cookie);

    const response = await fetchImpl(url.href, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(url.hostname === "channels.weixin.qq.com"
        ? { credentials: "omit" }
        : {}),
    });

    if (
      response?.redirected === true ||
      response?.type === "opaqueredirect" ||
      (response?.status >= 300 && response.status < 400)
    ) {
      throw new Error("API redirects are not allowed");
    }
    return response;
  };
}
