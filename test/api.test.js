import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp, normalizeUrl } from "../src/app.js";
import { openDb } from "../src/db.js";
import { parseUserAgent, referrerName } from "../src/ua.js";

let server;
let base;
const OWNER = "test-owner-key-1234567890";
const OTHER = "other-owner-key-0987654321";

before(async () => {
  const app = createApp({ db: openDb(":memory:") });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (path, { method = "GET", body, owner = OWNER, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(body && { "Content-Type": "application/json" }), ...(owner && { "X-Owner-Key": owner }), ...headers },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, data: type.includes("json") ? await res.json() : null };
};

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("helpers", () => {
  test("normalizes and validates URLs", () => {
    assert.equal(normalizeUrl("example.com/page"), "https://example.com/page");
    assert.throws(() => normalizeUrl("javascript:alert(1)"), /http and https/);
    assert.throws(() => normalizeUrl("http://localhost:3000"), /public website/);
    assert.throws(() => normalizeUrl("localhost:3000"), /public website/);
    assert.throws(() => normalizeUrl(""), /enter a URL/);
  });

  test("parses user agents and referrers", () => {
    assert.deepEqual(parseUserAgent(CHROME), { bot: false, browser: "Chrome", os: "Windows", device: "Desktop" });
    assert.equal(parseUserAgent(IPHONE).device, "Mobile");
    assert.equal(parseUserAgent("Googlebot/2.1").bot, true);
    assert.equal(referrerName("https://www.twitter.com/x", "snip.app"), "twitter.com");
    assert.equal(referrerName(undefined, "snip.app"), "Direct");
  });
});

describe("links API", () => {
  let code;

  test("requires an owner key", async () => {
    assert.equal((await api("/api/links", { owner: null })).status, 401);
  });

  test("creates short links", async () => {
    const res = await api("/api/links", { method: "POST", body: { url: "github.com/akrambgh1" } });
    assert.equal(res.status, 201);
    assert.equal(res.data.link.url, "https://github.com/akrambgh1");
    assert.match(res.data.link.code, /^[A-Za-z0-9]{6}$/);
    code = res.data.link.code;
  });

  test("supports custom aliases and rejects bad ones", async () => {
    assert.equal((await api("/api/links", { method: "POST", body: { url: "https://example.com", alias: "my-site" } })).status, 201);
    assert.equal((await api("/api/links", { method: "POST", body: { url: "https://example.com", alias: "MY-SITE" } })).status, 409);
    assert.equal((await api("/api/links", { method: "POST", body: { url: "https://example.com", alias: "a b" } })).status, 400);
    assert.equal((await api("/api/links", { method: "POST", body: { url: "https://example.com", alias: "api" } })).status, 400);
  });

  test("redirects and records clicks, ignoring bots", async () => {
    const r1 = await api(`/${code}`, { owner: null, headers: { "User-Agent": CHROME, Referer: "https://twitter.com/post" } });
    assert.equal(r1.status, 302);
    assert.equal(r1.headers.get("location"), "https://github.com/akrambgh1");
    await api(`/${code}`, { owner: null, headers: { "User-Agent": IPHONE } });
    await api(`/${code}`, { owner: null, headers: { "User-Agent": CHROME } });
    await api(`/${code}`, { owner: null, headers: { "User-Agent": "Googlebot/2.1" } });

    const stats = await api(`/api/links/${code}/stats`);
    assert.equal(stats.status, 200);
    assert.equal(stats.data.totals.clicks, 3, "bot click is not counted");
    assert.equal(stats.data.totals.visitors, 2, "same browser twice is one visitor");
    assert.equal(stats.data.timeline.length, 30);
    assert.equal(stats.data.timeline.at(-1).clicks, 3);
    assert.ok(stats.data.referrers.some((r) => r.name === "twitter.com"));
    assert.ok(stats.data.devices.some((d) => d.name === "Mobile"));
  });

  test("lists only my links, with click counts", async () => {
    const mine = await api("/api/links");
    assert.equal(mine.data.links.length, 2);
    assert.equal(mine.data.links.find((l) => l.code === code).clicks, 3);
    assert.equal((await api("/api/links", { owner: OTHER })).data.links.length, 0);
    assert.equal((await api(`/api/links/${code}/stats`, { owner: OTHER })).status, 404);
  });

  test("serves a QR code", async () => {
    const res = await fetch(`${base}/api/links/${code}/qr.svg`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<svg/);
  });

  test("deletes links (owner only) and 404s afterwards", async () => {
    assert.equal((await api(`/api/links/${code}`, { method: "DELETE", owner: OTHER })).status, 404);
    assert.equal((await api(`/api/links/${code}`, { method: "DELETE" })).status, 204);
    assert.equal((await api(`/${code}`, { owner: null })).status, 404);
  });
});
