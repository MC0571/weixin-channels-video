import assert from "node:assert/strict";
import test from "node:test";
import { API_URLS, checkLogin, ParseError, parseShareLink } from "../src/core.mjs";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function authenticatedResponse() {
  return response({
    userId: "synthetic-user",
    needRefreshToken: false,
    anonUser: { isAnon: false },
  });
}

function assertCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof ParseError);
    assert.equal(error.code, code);
    return true;
  });
}

test("checkLogin distinguishes authenticated and anonymous account states", async () => {
  assert.deepEqual(
    await checkLogin(async (url, init) => {
      assert.equal(url, API_URLS.userInfo);
      assert.equal(init.method, "GET");
      return authenticatedResponse();
    }),
    { status: "authenticated" },
  );

  assert.deepEqual(
    await checkLogin(async () =>
      response({
        userId: "synthetic-anonymous-user",
        needRefreshToken: false,
        anonUser: { isAnon: true },
      }),
    ),
    { status: "anonymous" },
  );

  assert.deepEqual(
    await checkLogin(async () =>
      response({
        userId: "synthetic-user",
        needRefreshToken: true,
        anonUser: { isAnon: false },
      }),
    ),
    { status: "anonymous" },
  );
});

test("checkLogin treats explicit auth failure as anonymous and malformed checks as failures", async () => {
  assert.deepEqual(
    await checkLogin(async () => new Response(null, { status: 401 })),
    { status: "anonymous" },
  );
  await assertCode(
    checkLogin(async () => response({ userId: "synthetic-user" })),
    "LOGIN_CHECK_FAILED",
  );
  await assertCode(checkLogin(async () => { throw new Error("private transport detail"); }), "LOGIN_CHECK_FAILED");
});

test("parseShareLink checks login, uses playable_url token and eid, and returns the selected media", async () => {
  const calls = [];
  const result = await parseShareLink("https://weixin.qq.com/sph/share-id", {
    request: async (url, init) => {
      calls.push({ url, init });
      if (url === API_URLS.userInfo) return authenticatedResponse();
      if (url === API_URLS.parseShare) {
        assert.deepEqual(JSON.parse(init.body), {
          type: "video_channel_url",
          url: "https://weixin.qq.com/sph/share-id",
          scene: 1,
        });
        return response({
          code: 0,
          data: {
            wx_export_id: "must-not-be-used",
            playable_url:
              "https://channels.weixin.qq.com/finder-preview/pages/feed?token=synthetic-token&eid=synthetic-eid",
            desc: "Fallback title",
            author: "Fallback author",
            cover_url: "https://media.example/synthetic-cover.jpg",
          },
        });
      }

      const requestUrl = new URL(url);
      assert.equal(requestUrl.origin + requestUrl.pathname, API_URLS.feedInfo);
      assert.match(requestUrl.searchParams.get("_rid"), /^[0-9a-f]+-[0-9a-f]{8}$/);
      assert.equal(
        requestUrl.searchParams.get("_pageUrl"),
        "https://channels.weixin.qq.com/finder-preview/pages/feed",
      );
      assert.deepEqual(JSON.parse(init.body), {
        baseReq: { generalToken: "synthetic-token" },
        exportId: "synthetic-eid",
      });
      assert.equal(new URL(init.headers.referer).searchParams.get("token"), "synthetic-token");
      return response({
        errCode: 0,
        data: {
          authorInfo: { nickname: "Synthetic author" },
          feedInfo: {
            description: "Synthetic title",
            coverUrl: "https://media.example/feed-cover.jpg",
            h264VideoInfo: { videoUrl: "https://media.example/h264.mp4" },
            videoUrl: "https://media.example/base.mp4",
            h265VideoInfo: { videoUrl: "https://media.example/h265.mp4" },
          },
        },
      });
    },
  });

  assert.deepEqual(result, {
    sourceUrl: "https://weixin.qq.com/sph/share-id",
    title: "Synthetic title",
    author: "Synthetic author",
    coverUrl: "https://media.example/feed-cover.jpg",
    previewUrl: "https://media.example/h264.mp4",
    downloadUrl: "https://media.example/h264.mp4",
  });
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(result).includes("synthetic-token"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-eid"), false);
});

test("parseShareLink distinguishes authentication failure from a forbidden parse request", async () => {
  const makeRequest = (status) => async (url) =>
    url === API_URLS.userInfo ? authenticatedResponse() : new Response(null, { status });

  await assertCode(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request: makeRequest(401) }),
    "AUTH_EXPIRED",
  );
  await assert.rejects(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request: makeRequest(403) }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "元宝解析接口请求失败（HTTP 403）。");
      return true;
    },
  );
});

test("parseShareLink reports feed HTTP status without treating it as Yuanbao authentication failure", async () => {
  const secret = "synthetic-feed-token";
  const request = async (url) => {
    if (url === API_URLS.userInfo) return authenticatedResponse();
    if (url === API_URLS.parseShare) {
      return response({
        code: 0,
        data: {
          playable_url: `https://channels.weixin.qq.com/finder-preview/pages/feed?token=${secret}&eid=synthetic-eid`,
        },
      });
    }
    return new Response("synthetic private failure body", { status: 401 });
  };

  await assert.rejects(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "视频详情接口请求失败（HTTP 401）。");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("synthetic private failure body"), false);
      return true;
    },
  );
});

test("parseShareLink preserves an actionable missing-session-tab error from the request adapter", async () => {
  const request = async (url) => {
    if (url === API_URLS.userInfo) return authenticatedResponse();
    throw new ParseError("LOGIN_CHECK_FAILED", "请保持元宝标签页打开。");
  };

  await assert.rejects(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request }),
    (error) => {
      assert.equal(error.code, "LOGIN_CHECK_FAILED");
      assert.equal(error.message, "请保持元宝标签页打开。");
      return true;
    },
  );
});

test("parseShareLink rejects malformed share URLs before making requests", async () => {
  let called = false;
  const request = async () => {
    called = true;
    return authenticatedResponse();
  };

  await assertCode(parseShareLink("https://evil.example/sph/share-id", { request }), "INVALID_URL");
  await assertCode(parseShareLink("http://weixin.qq.com/sph/share-id", { request }), "INVALID_URL");
  await assertCode(parseShareLink("https://weixin.qq.com/sph/a%2Fb", { request }), "INVALID_URL");
  assert.equal(called, false);
});

test("parseShareLink stops when required playable_url parameters are missing", async () => {
  let feedCalled = false;
  const request = async (url) => {
    if (url === API_URLS.userInfo) return authenticatedResponse();
    if (url === API_URLS.parseShare) {
      return response({ data: { playable_url: "https://channels.weixin.qq.com/feed?token=synthetic-token" } });
    }
    feedCalled = true;
    return response({});
  };

  await assertCode(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request }),
    "UPSTREAM_ERROR",
  );
  assert.equal(feedCalled, false);
});

test("parseShareLink returns fixed feed-unavailable messages without echoing upstream text", async () => {
  const request = async (url) => {
    if (url === API_URLS.userInfo) return authenticatedResponse();
    if (url === API_URLS.parseShare) {
      return response({
        data: {
          playable_url:
            "https://channels.weixin.qq.com/finder-preview/pages/feed?token=synthetic-token&eid=synthetic-eid",
        },
      });
    }
    return response({ errCode: 7, errMsg: "synthetic upstream detail" });
  };

  await assert.rejects(
    parseShareLink("https://weixin.qq.com/sph/share-id", { request }),
    (error) => {
      assert.equal(error.code, "FEED_UNAVAILABLE");
      assert.equal(error.message, "视频内容不可用。");
      assert.equal(error.message.includes("synthetic upstream detail"), false);
      return true;
    },
  );
});
