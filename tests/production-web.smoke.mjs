// Run against a freshly started production instance (CI uses the Compose container).
import assert from "node:assert/strict";
import { test } from "node:test";

const origin = process.env.PHOSPHENE_TEST_ORIGIN ?? "http://127.0.0.1:8080";
const request = (path, options) => fetch(new URL(path, origin), options);

test("the production shell contains useful text without JS and keeps HTTPS protections", async () => {
  for (const path of ["/", "/settings", "/connect?request=test"]) {
    const response = await request(path, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /^text\/html\b/);
    assert.match(response.headers.get("cache-control"), /no-cache/);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /(?:^|;)\s*upgrade-insecure-requests\s*(?:;|$)/);
    assert.match(csp, /(?:^|;)\s*script-src 'self'\s*(?:;|$)/);
    const html = await response.text();
    const fallback = html.match(/<div id="root">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(fallback, "hint must be inside the root replaced by React");
    assert.doesNotMatch(fallback, /<noscript\b/i, "JS is enabled even when the module fails to load");
    assert.match(fallback, /http:\/\//);
    assert.match(fallback, /HTTPS 地址/);
  }
});

test("the shell references real JS and CSS; a new instance exposes first-time setup", async () => {
  const html = await (await request("/")).text();
  for (const [entry, mime] of [
    [html.match(/<script\b[^>]*src="(\/assets\/[^"?]+\.js)"/)?.[1], /^(?:text|application)\/javascript\b/],
    [html.match(/<link\b[^>]*href="(\/assets\/[^"?]+\.css)"/)?.[1], /^text\/css\b/]
  ]) {
    assert.ok(entry, "missing built entry in index.html");
    const asset = await request(entry);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), mime);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.doesNotMatch(await asset.text(), /^\s*<!doctype html/i);
  }
  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).data.initialized, false);
});

test("a stale HTML entry receives a non-cacheable, non-HTML 404, even on direct navigation", async () => {
  for (const [path, method, accept] of [
    ["/assets/index-stale.js", "GET", "*/*"], ["/assets/index-stale.js?rev=old", "GET", "text/html"],
    ["/assets/index-stale.js", "HEAD", "text/html"], ["/assets/extensionless", "GET", "text/html"],
    ["/assets/missing.css", "GET", "text/css"], ["/missing.js", "GET", "*/*"],
    ["/settings", "POST", "text/html"], ["/settings", "GET", "application/json"]
  ]) {
    const response = await request(path, { method, headers: { Accept: accept } });
    assert.equal(response.status, 404, `${method} ${path} (${accept})`);
    assert.match(response.headers.get("content-type"), /^text\/plain\b/);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(await response.text(), method === "HEAD" ? "" : "Not found");
  }

  // Private APIs must still use their own error contract rather than the frontend fallback.
  const api = await request("/api/me");
  assert.equal(api.status, 401);
  assert.match(api.headers.get("content-type"), /^application\/json\b/);
  assert.equal((await api.json()).error.code, "authentication_required");
});

// The Linux Compose CI has Chrome. Without a browser the HTTP-level tests above still run.
const chrome = process.env.PHOSPHENE_TEST_CHROME;
test("a browser replaces the startup hint with the first-time setup form", { skip: !chrome }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chrome, chromiumSandbox: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (error) => console.error("Browser error:", error.message));
    const entry = await page.goto(origin, { waitUntil: "domcontentloaded" });
    assert.equal(entry?.status(), 200);
    await page.getByText(/首次设置\s*·\s*1\s*\/\s*3/).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.locator('input[type="password"]').first().isVisible(), true);
    assert.equal(await page.getByRole("heading", { name: "正在打开 Phosphene" }).count(), 0);
  } finally {
    await browser.close();
  }
});
