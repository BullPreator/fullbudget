/* =========================================================
   FullBudget — Kök (root) EMEKLİ Service Worker

   Bu dosya bir uygulama service worker'ı DEĞİLDİR ve hiçbir offline/cache
   davranışı sağlamaz. Tek görevi, taşımadan önce "/" kapsamında (scope: "/")
   kayıtlı kalmış olan ESKİ FullBudget service worker'ını emekliye ayırmaktır:

     1) kendi kaydını unregister() ile iptal eder,
     2) yalnızca FullBudget'a ait ("fullbudget-" önekli) eski cache'leri siler.

   Gerçek uygulama service worker'ı artık burada değil, app/sw.js'tedir ve
   yalnızca /app/ scope'unda çalışır. Bu dosyaya YENİ bir davranış eklenmez —
   eski kayıtlar temizlendikten sonra bu dosya tamamen kaldırılabilir.
   ========================================================= */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k.indexOf('fullbudget-') === 0).map((k) => caches.delete(k))
        );
      } catch (e) { /* cache API yoksa/erişilemezse sessizce geç */ }

      try {
        await self.registration.unregister();
      } catch (e) { /* unregister başarısız olursa sessizce geç - bir sonraki activate'te tekrar dener */ }
    })()
  );
});
