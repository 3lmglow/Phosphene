const SHELL_CACHE = "phosphene-shell-v5";
const RUNTIME_CACHE = "phosphene-runtime-v5";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/phosphene-stars-128.png",
  "/icons/phosphene-stars-192.png",
  "/icons/phosphene-stars-512.png",
  "/icons/phosphene-stars-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => /^phosphene-(shell|runtime)-/.test(key) && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isPrivateApi(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/oauth/") ||
    url.pathname.startsWith("/.well-known/") ||
    url.pathname === "/mcp" ||
    url.pathname === "/healthz"
  );
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("/", response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match("/")) || Response.error();
  }
}

async function staticResponse(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then(async (response) => {
      // A proxy may still return its HTML fallback with status 200 for a missing asset.
      const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (response.ok && mime !== "text/html" && mime !== "application/xhtml+xml") {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached || Response.error());
  return cached || update;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPrivateApi(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (["script", "style", "image", "font"].includes(request.destination)) {
    event.respondWith(staticResponse(request));
  }
});
