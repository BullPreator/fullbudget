/* =========================================================
   FullBudgetBackend — shutdown.js (P0-A1)

   Graceful shutdown. Ayrı bir modül olmasının sebebi: Express'e bağımlı
   olmadan test edilebilmesi.

   SIGTERM (container orkestratörü: Docker stop, Kubernetes, Render, Fly)
   ve SIGINT (Ctrl+C) geldiğinde:
     1) yeni bağlantı kabul etmeyi bırak,
     2) devam eden isteklerin BİTMESİNİ bekle (kullanıcının cevabı yarıda
        kesilmesin - AI isteği 25 saniyeye kadar sürebiliyor),
     3) boşta bekleyen keep-alive soketlerini serbest bırak (yoksa kapanış
        boşuna dakikalarca sürer),
     4) süre aşımında zorla kapat (asılı kalma).
   ========================================================= */

'use strict';

function attachGracefulShutdown(server, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || 10000;
  const logger = options.logger || console;
  const onClosed = options.onClosed;
  const signals = options.signals || ['SIGTERM', 'SIGINT'];
  let shuttingDown = false;

  /* Keep-alive bağlantılarının kapanışı geciktirmemesi için soketleri izle.
     Her sokete "kaç aktif isteği var" sayacı tutulur:
       - sayaç 0  => boşta, kapanışta hemen kapatılabilir
       - sayaç >0 => meşgul, isteği bitene kadar DOKUNULMAZ
     İstek bittiğinde, kapanış sürüyorsa soket derhal kapatılır; yoksa
     keep-alive soketi açık kalır ve server.close() hiç tamamlanmaz. */
  const sockets = new Map(); // socket -> aktif istek sayısı

  server.on('connection', (socket) => {
    sockets.set(socket, 0);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('request', (req, res) => {
    sockets.set(req.socket, (sockets.get(req.socket) || 0) + 1);
    // Kapanış sırasında gelen/süren isteklerde bağlantının yeniden
    // kullanılmayacağını istemciye bildir.
    if (shuttingDown && !res.headersSent) {
      try { res.setHeader('Connection', 'close'); } catch (e) { /* yanıt başlamışsa önemsiz */ }
    }
    res.on('finish', () => {
      const left = (sockets.get(req.socket) || 1) - 1;
      sockets.set(req.socket, left);
      if (shuttingDown && left <= 0) req.socket.end();
    });
  });

  function finish(signal, err) {
    logger.log(JSON.stringify({ type: 'shutdown_complete', signal, ok: !err }));
    if (typeof onClosed === 'function') onClosed(err || null);
    else process.exit(err ? 1 : 0);
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(JSON.stringify({ type: 'shutdown_started', signal }));

    let forceTimer = null;

    // Yeni bağlantıları reddet, mevcut isteklerin bitmesini bekle.
    server.close((err) => {
      if (forceTimer) clearTimeout(forceTimer);
      finish(signal, err);
    });

    // Boşta bekleyen keep-alive soketlerini serbest bırak. Aktif bir istek
    // işleyen soketlere DOKUNULMAZ - onlar 'finish' olayında kapanacak.
    for (const [socket, active] of sockets) {
      if (socket.destroyed || active > 0) continue;
      socket.end();
    }

    forceTimer = setTimeout(() => {
      logger.error(JSON.stringify({ type: 'shutdown_forced', signal, timeoutMs }));
      for (const socket of sockets.keys()) socket.destroy();
      finish(signal, new Error('shutdown-timeout'));
    }, timeoutMs);
    if (forceTimer.unref) forceTimer.unref();
  }

  const handlers = [];
  for (const sig of signals) {
    const h = () => shutdown(sig);
    process.on(sig, h);
    handlers.push([sig, h]);
  }

  // Testlerin sinyal dinleyicilerini sökebilmesi için.
  shutdown.detach = () => {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
  };

  return shutdown;
}

module.exports = { attachGracefulShutdown };
