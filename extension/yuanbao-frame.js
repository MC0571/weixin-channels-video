(() => {
  const yuanbaoOrigin = "https://yuanbao.tencent.com";
  const apiUrl = `${yuanbaoOrigin}/api/weixin/get_parse_result`;
  const requestType = "weixin-channels-video:api-request";
  const responseType = "weixin-channels-video:api-response";
  const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  if (window.parent === window || location.origin !== yuanbaoOrigin) return;

  let extensionUrl;
  try {
    extensionUrl = new URL(chrome.runtime.getURL("/"));
  } catch {
    return;
  }
  if (extensionUrl.protocol !== "chrome-extension:" || !extensionUrl.host) return;
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
  let requestHandled = false;

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== extensionOrigin ||
      requestHandled ||
      location.origin !== yuanbaoOrigin
    ) return;
    const message = event.data;
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      Object.keys(message).length !== 3 ||
      message.type !== requestType ||
      typeof message.requestId !== "string" ||
      !requestIdPattern.test(message.requestId) ||
      typeof message.body !== "string"
    ) {
      return;
    }
    requestHandled = true;

    void (async () => {
      let status = 0;
      let body = "";
      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: message.body,
          credentials: "include",
          redirect: "error",
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
