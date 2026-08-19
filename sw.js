// mojioko-gensai Service Worker
//
// 方針:
// - HTML本体(ナビゲーションリクエスト)は「ネットワーク優先」。
//   常に最新のデプロイを取得し、オフライン時だけキャッシュにフォールバックする。
//   (キャッシュ優先にすると、再デプロイしても古い画面のままになってしまうため)
// - アイコン/マニフェストなどの静的アセットは「キャッシュ優先」。
// - /api/* へのリクエストは常にネットワークから取得し、絶対にキャッシュしない
//   (文字起こし結果や認証情報などをキャッシュで古くしないため)。

const CACHE_NAME = 'mojioko-shell-v2';
const STATIC_FILES = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIリクエストは絶対にキャッシュしない(常に最新を取得)
  if (url.pathname.startsWith('/api/')) {
    return; // ブラウザのデフォルト(ネットワーク)動作に任せる
  }

  // HTML本体(ページ遷移・リロード)はネットワーク優先。
  // オフライン等で取得できない場合のみキャッシュにフォールバック。
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // それ以外の静的アセットはキャッシュ優先 → 無ければネットワークから取得
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (event.request.method === 'GET' && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
