const CACHE = "genryo-note-v110";
const APP_FILES = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icon.svg", "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png", "./seibun.json"];

// 更新はキャッシュ番号（CACHE）を上げたときだけ、全ファイルをまとめて取得して切り替える。
// 1ファイルでも取得に失敗したらインストールせず、古い版のキャッシュをそのまま使い続ける。
// （ファイルを1つずつ更新すると、途中で中断したときに新旧のファイルが混ざり、起動できなくなるため）
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    await caches.delete(CACHE);
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(APP_FILES.map(url => new Request(url, { cache: "reload" })));
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;

    try {
      return await fetch(event.request);
    } catch (error) {
      if (event.request.mode === "navigate") {
        const appShell = await cache.match("./index.html");
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
