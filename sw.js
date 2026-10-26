// Офлайн-режим: страница — свежая из сети; при медленной сети (>4 с) или без интернета — сохранённая копия.
// Основная (…/Dnevnik/) и тестовая (…/Dnevnik-test/) копии не мешают друг другу.
// Картинки и библиотеки — из кэша. Запросы к серверу дневника и config.json НЕ кэшируются никогда.
const SUFFIX = "|" + self.registration.scope;   // у основной и тестовой копии — свои кэши
const CACHE = "dnevnik-v7" + SUFFIX;
const CORE = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && (k.endsWith(SUFFIX) || !k.includes("|"))).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    // свежая страница из сети, но если сеть медленная (VPN, плохая связь) — через 4 секунды показываем сохранённую,
    // а свежая всё равно скачается и откроется в следующий раз
    const net = fetch(req, { cache: "no-store" }).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); } return r; });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(new Promise(resolve => {
      let done = false; const finish = r => { if (!done && r) { done = true; resolve(r); } };
      const t = setTimeout(() => caches.match("index.html").then(hit => finish(hit)), 4000);
      net.then(r => { clearTimeout(t); finish(r); }).catch(() => { clearTimeout(t); caches.match("index.html").then(hit => finish(hit || Response.error())); });
    }));
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
