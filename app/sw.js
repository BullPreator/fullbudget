/* =========================================================
   FullBudget — Service Worker
   Amaç: (1) uygulamayı çevrimdışı da açılabilir kılmak, (2) bildirime
   dokununca uygulamaya odaklanmak/açmak.

   ÖNEMLİ SINIR: Burada GERÇEK sunucu-tabanlı push YOKTUR. Onun için bir
   arka uç (backend) gerekir: VAPID anahtar çifti, istemcide
   pushManager.subscribe() ile abonelik, bu aboneliğin bir sunucuda
   saklanması ve sunucunun web-push gibi bir kütüphaneyle bu 'push'
   olayını tetiklemesi. Aşağıdaki 'push' dinleyicisi, ileride bir backend
   eklersen kullanılacak hazır bir iskelettir — şu an hiçbir şey onu
   tetiklemiyor. Uygulama içindeki bildirimler (ödeme hatırlatmaları)
   bunun yerine sayfa açıkken/yakın zamanda açılmışken JS tarafından
   doğrudan gösteriliyor.

   SÜRÜM NOTU: index.html'i her önemli güncellemende CACHE_VERSION'ı da
   bir artır (v1 -> v2 -> ...). Aksi halde bazı kullanıcılar çevrimdışı
   önbellekte eski bir sürümde takılı kalabilir.
   ========================================================= */
const CACHE_VERSION = 'fullbudget-v6';
const PRECACHE_URLS = ['manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST vb. isteklere karışma

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Sayfa navigasyonu (index.html): önce ağ, olmazsa (çevrimdışı) önbellekteki
  // son başarılı kopya. Kullanıcı çevrimiçiyken hep en güncel sürümü görür.
  // ÖNEMLİ: cache.put() işlemi event.waitUntil() içine alınmalı — aksi halde
  // respondWith() cevabı döner dönmez tarayıcı bu işleyiciyi bitmiş sayıp
  // arka plandaki (henüz tamamlanmamış) cache.put()'u iptal edebilir ve
  // sayfa hiçbir zaman gerçekten önbelleğe yazılmaz.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {}));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Aynı kökenden statik dosyalar (manifest, ikon): önce önbellek (hızlı açılış),
  // arka planda ağdan tazele (yine event.waitUntil() ile korunarak).
  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone())).catch(() => {}));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Farklı kökenden istekler (Google Fonts, canlı döviz/altın kuru API'leri vb.):
  // önbelleğe hiç karışma — finansal veri her zaman taze/ağdan gelsin.
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('./');
    })
  );
});

/* Gerçek sunucu push'u için hazır iskelet (bkz. dosya başındaki not) — şu an
   hiçbir sunucu bu olayı tetiklemiyor, ileride bir backend eklenirse kullanılır. */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch (e) { payload = { title: 'Bütçe Koçu', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Bütçe Koçu', {
      body: payload.body || '',
      tag: payload.tag || 'butce-kocu',
      icon: 'icon.svg',
    })
  );
});
