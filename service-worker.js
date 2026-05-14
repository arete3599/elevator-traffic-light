/**
 * 전국 운수시설 승강기 운행정보 — Service Worker
 * 캐싱 전략:
 *   - 앱 셸 (HTML, 아이콘):    Cache-First (즉시 표시)
 *   - CDN 라이브러리:           Stale-While-Revalidate
 *   - OSM 타일 이미지:          Cache-First + LRU 50개 제한
 *   - 공공 API (프록시 경유):    Network-First, 실패 시 캐시 폴백
 */

// ⚠ 코드 변경 후 반드시 이 버전 번호를 올려야 사용자 PWA가 새 SW를 받습니다
const CACHE_VERSION = 'v1.7.0';
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;
const CDN_CACHE = `cdn-libs-${CACHE_VERSION}`;
const TILE_CACHE = `osm-tiles-${CACHE_VERSION}`;
const API_CACHE = `api-data-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './subway-elevator-status.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-apple-touch.png',
];

const CDN_HOSTS = [
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
];

const MAX_TILE_ENTRIES = 50;

// ─── INSTALL ─────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      console.log('[SW] 앱 셸 캐싱 시작');
      // 실패해도 install 자체는 막지 않음 (개별 자원 누락 허용)
      return Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url).catch((e) =>
          console.warn(`[SW] 캐시 실패: ${url}`, e.message)
        ))
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const valid = [APP_SHELL_CACHE, CDN_CACHE, TILE_CACHE, API_CACHE];
      return Promise.all(
        keys.filter((k) => !valid.includes(k))
            .map((k) => { console.log(`[SW] 구버전 캐시 정리: ${k}`); return caches.delete(k); })
      );
    }).then(() => self.clients.claim())
  );
});

// ─── FETCH ───────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) 카카오 지오코딩 API: 캐시하지 않음 (다른 출처, 인증 헤더)
  if (url.hostname === 'dapi.kakao.com') {
    return;
  }

  // 2) OSM 타일: Cache-First + LRU
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(cacheFirstWithLimit(TILE_CACHE, req, MAX_TILE_ENTRIES));
    return;
  }

  // 3) CDN 라이브러리: Stale-While-Revalidate
  if (CDN_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(staleWhileRevalidate(CDN_CACHE, req));
    return;
  }

  // 4) 로컬 프록시 경유 공공 API: Network-First
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(API_CACHE, req));
    return;
  }

  // 5) HTML 문서: Network-First (새 버전 즉시 반영, 오프라인 시 캐시 폴백)
  // 이게 Cache-First면 사용자가 옛 HTML에 영원히 갇힘
  const isHtmlDoc = req.destination === 'document'
                  || url.pathname === '/'
                  || url.pathname.endsWith('.html');
  if (isHtmlDoc) {
    event.respondWith(networkFirst(APP_SHELL_CACHE, req));
    return;
  }

  // 6) 그 외 앱 셸 (아이콘, manifest, JS): Cache-First
  event.respondWith(cacheFirst(APP_SHELL_CACHE, req));
});

// ─── 전략 구현 ────────────────────────────────────────────

async function cacheFirst(cacheName, req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    // 오프라인 시 폴백: HTML 요청이면 메인 페이지라도 반환
    if (req.destination === 'document') {
      const fallback = await caches.match('./subway-elevator-status.html');
      if (fallback) return fallback;
    }
    throw e;
  }
}

async function cacheFirstWithLimit(cacheName, req, maxEntries) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(req, res.clone());
      trimCache(cacheName, maxEntries); // 비동기, 결과 기다리지 않음
    }
    return res;
  } catch (e) {
    return cached || new Response('', { status: 504 });
  }
}

async function staleWhileRevalidate(cacheName, req) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkFetch = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || networkFetch;
}

async function networkFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // 폴백: 빈 응답 (앱은 데모 모드로 자동 폴백됨)
    return new Response(JSON.stringify({ offline: true, error: '오프라인' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
  }
}
