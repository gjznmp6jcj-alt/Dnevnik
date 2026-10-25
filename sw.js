// Офлайн-режим: страница — всегда свежая из сети, без интернета — сохранённая копия.
// Основная (…/Dnevnik/) и тестовая (…/Dnevnik-test/) копии не мешают друг другу.
// Картинки и библиотеки — из кэша. Запросы к серверу дневника и config.json НЕ кэшируются никогда.
const SUFFIX = "|" + self.registration.scope;   // у основной и тестовой копии — свои кэши
const CACHE = "dnevnik-v6" + SUFFIX;
const CORE = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && (k.endsWith(SUFFIX) || !k.includes("|"))).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    e.respondWith(fetch(req, { cache: "no-store" }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); return r; }).catch(() => caches.match("index.html")));
    return;
  }
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.hostname === "cdn.jsdelivr.net";
  if (!sameOrigin && !isLib) return;                                // сервер, базы продуктов и т.п. — всегда напрямую
  if (sameOrigin && /config\.json$/.test(url.pathname)) return;     // настройки — всегда свежие
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return r;
  })));
});
