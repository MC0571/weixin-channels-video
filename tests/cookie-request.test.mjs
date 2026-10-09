import assert from "node:assert/strict";
import test from "node:test";
import { createCookieRequest } from "../src/cookie-request.mjs";
import { API_URLS } from "../src/core.mjs";

test("createCookieRequest sends its cookie only to fixed Yuanbao endpoints", async () => {
  const calls = [];
  const request = createCookieRequest("session=synthetic-cookie", async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  });

  await request(API_URLS.userInfo, {
    method: "GET",
    headers: {
      cookie: "session=caller-cookie",
      authorization: "Bearer synthetic-credential",
    },
  });
  assert.equal(calls[0].init.headers.get("cookie"), "session=synthetic-cookie");
  assert.equal(calls[0].init.headers.has("authorization"), false);
  assert.equal(calls[0].init.redirect, "manual");

  await request(`${API_URLS.feedInfo}?_rid=synthetic-rid&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Ffinder-preview%2Fpages%2Ffeed`, {
    method: "POST",
    credentials: "include",
    headers: {
      cookie: "session=caller-cookie",
      authorization: "Bearer synthetic-credential",
      "proxy-authorization": "synthetic-proxy-credential",
    },
    body: "{}",
  });
  assert.equal(calls[1].init.headers.has("cookie"), false);
  assert.equal(calls[1].init.headers.has("authorization"), false);
  assert.equal(calls[1].init.headers.has("proxy-authorization"), false);
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.redirect, "manual");
});

test("createCookieRequest rejects non-API destinations and wrong methods", async () => {
  let called = false;
  const request = createCookieRequest("session=synthetic-cookie", async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(request("https://attacker.example/collect", { method: "POST" }), TypeError);
  await assert.rejects(request(API_URLS.userInfo, { method: "POST" }), TypeError);
  await assert.rejects(request(`${API_URLS.feedInfo}?url=https://attacker.example`, { method: "POST" }), TypeError);
  assert.equal(called, false);
});

test("createCookieRequest asks fetch not to follow redirects and rejects redirect responses", async () => {
  let options;
  const request = createCookieRequest("session=synthetic-cookie", async (_url, init) => {
    options = init;
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
  });

  await assert.rejects(request(API_URLS.userInfo), /redirects are not allowed/);
  assert.equal(options.redirect, "manual");
});
