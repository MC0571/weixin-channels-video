(() => {
  const yuanbaoOrigin = "https://yuanbao.tencent.com";
  const yuanbaoApiUrl = `${yuanbaoOrigin}/api/weixin/get_parse_result`;
  const channelsOrigin = "https://channels.weixin.qq.com";
  const channelsPagePath = "/finder-preview/pages/feed";
  const channelsPageUrl = `${channelsOrigin}${channelsPagePath}`;
  const channelsApiPath = "/finder-preview/api/feed/get_feed_info";
  const requestType = "weixin-channels-video:api-request";
  const responseType = "weixin-channels-video:api-response";
  const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const yuanbaoFrame = location.origin === yuanbaoOrigin;
  const channelsFrame = location.origin === channelsOrigin && location.pathname === channelsPagePath;

  if (window.parent === window || (!yuanbaoFrame && !channelsFrame)) return;

  let extensionUrl;
  try {
    extensionUrl = new URL(chrome.runtime.getURL("/"));
  } catch {
    return;
  }
  if (extensionUrl.protocol !== "chrome-extension:" || !extensionUrl.host) return;
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
  let requestHandled = false;

  function hasExactKeys(value, keys) {
    return value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key));
  }

  function channelsRequest(message) {
    if (typeof message.url !== "string" || typeof message.referer !== "string") return null;
    try {
      const url = new URL(message.url);
      const referer = new URL(message.referer);
      const queryKeys = [...url.searchParams.keys()].sort();
      if (
        url.origin !== channelsOrigin ||
        url.pathname !== channelsApiPath ||
        url.username ||
        url.password ||
        url.hash ||
        queryKeys.length !== 2 ||
        queryKeys[0] !== "_pageUrl" ||
        queryKeys[1] !== "_rid" ||
        url.searchParams.get("_pageUrl") !== channelsPageUrl ||
        !url.searchParams.get("_rid") ||
        referer.origin !== channelsOrigin ||
        referer.pathname !== channelsPagePath ||
        referer.username ||
        referer.password ||
        referer.hash ||
        !referer.searchParams.get("token") ||
        !referer.searchParams.get("eid")
      ) {
        return null;
      }
      return { url: url.href, referer: referer.href };
    } catch {
      return null;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== extensionOrigin || requestHandled) return;
    if (
      (yuanbaoFrame && location.origin !== yuanbaoOrigin) ||
      (channelsFrame && (location.origin !== channelsOrigin || location.pathname !== channelsPagePath))
    ) return;
    const message = event.data;
    const expectedKeys = yuanbaoFrame
      ? ["type", "requestId", "body"]
      : ["type", "requestId", "body", "url", "referer"];
    if (
      !hasExactKeys(message, expectedKeys) ||
      message.type !== requestType ||
      typeof message.requestId !== "string" ||
      !requestIdPattern.test(message.requestId) ||
      typeof message.body !== "string"
    ) {
      return;
    }

    const channelRequest = channelsFrame ? channelsRequest(message) : null;
    if (channelsFrame && !channelRequest) return;
    requestHandled = true;

    void (async () => {
      let status = 0;
      let body = "";
      try {
        const response = await fetch(yuanbaoFrame ? yuanbaoApiUrl : channelRequest.url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: message.body,
          credentials: yuanbaoFrame ? "include" : "omit",
          redirect: "error",
          ...(channelRequest ? {
            referrer: channelRequest.referer,
            referrerPolicy: "same-origin",
          } : {}),
        });
        status = response.status;
        if (response.ok) body = await response.text();
      } catch {
        status = 0;
        body = "";
      }

      window.parent.postMessage({
        type: responseType,
        requestId: message.requestId,
        status,
        body,
      }, extensionOrigin);
    })();
  });
})();
