/* =========================================================
   FullBudgetBackend — security.js (P0-A1)

   Bağımlılıksız güvenlik katmanı. helmet / express-rate-limit / cors
   paketlerinin yerine, bu backend'in ihtiyaç duyduğu kadarı Node
   yerleşikleriyle yazıldı. Gerekçe: tek endpoint'li küçük bir servis için
   üç ek bağımlılık (ve onların transitif ağacı) net bir saldırı yüzeyi
   artışıdır; buradaki davranışların tamamı ~300 satırda okunabilir ve
   testlerle doğrulanabilir durumda.

   Buradaki her middleware Express'in (req, res, next) sözleşmesine uyar
   ama Express'e BAĞLI DEĞİLDİR - sade bir Node http sunucusunda da aynen
   çalışır. Testler bunu bu şekilde kullanıyor.

   GÜVENLİK KURALLARI (bu dosya boyunca korunur):
     - Finansal context, soru metni, token ya da secret ASLA loglanmaz.
     - İstemciye dönen hiçbir hata gövdesi stack trace, dosya yolu,
       API anahtarı veya OpenAI iç hata detayı içermez.
   ========================================================= */

'use strict';

const crypto = require('crypto');

/* =========================================================
   1) REQUEST ID (correlation id)
   Her istek için bir kimlik üretir, yanıta X-Request-Id olarak koyar ve
   req.id üzerinden logger'a verir. İstemci kendi X-Request-Id'sini
   gönderirse -yalnızca güvenli biçimdeyse- ona saygı gösteririz; aksi
   halde kendimiz üretiriz (log enjeksiyonu / header kirliliği önlemi).
   ========================================================= */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming))
    ? incoming
    : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req._startedAt = process.hrtime.bigint();
  next();
}

/* =========================================================
   2) GÜVENLİK BAŞLIKLARI (helmet eşdeğeri)

   HSTS: yalnızca üretimde VE istek gerçekten HTTPS üzerinden geldiyse
   gönderilir. Yerel http:// geliştirmede gönderilseydi tarayıcı
   localhost'u kalıcı olarak https'e kilitler ve geliştirme ortamı bozulurdu
   - bu yüzden bilinçli olarak koşullu.
   ========================================================= */
function isHttps(req, trustProxy) {
  if (req.socket && req.socket.encrypted) return true;
  if (!trustProxy) return false;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto !== 'string') return false;
  return proto.split(',')[0].trim().toLowerCase() === 'https';
}

function securityHeaders(opts) {
  const production = !!(opts && opts.production);
  const trustProxy = !!(opts && opts.trustProxy);
  const hstsMaxAge = (opts && opts.hstsMaxAge) || 15552000; // 180 gün

  return function securityHeadersMw(req, res, next) {
    // MIME sniffing kapalı
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Clickjacking: bu servis hiçbir yerde çerçeve içine alınmamalı
    res.setHeader('X-Frame-Options', 'DENY');
    // Modern karşılığı; frame-ancestors X-Frame-Options'ı geçersiz kılar
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    // Referrer sızıntısı: çapraz origin'e yol/sorgu gitmesin
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Bu API hiçbir güçlü cihaz iznine ihtiyaç duymaz
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Adobe crossdomain.xml politikası
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // Yanıtlar kullanıcıya özel; ara katman önbelleklemesin
    res.setHeader('Cache-Control', 'no-store');
    // Information leakage: Express'in "X-Powered-By: Express" başlığı
    res.removeHeader('X-Powered-By');

    if (production && isHttps(req, trustProxy)) {
      res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains`);
    }
    next();
  };
}

/* =========================================================
   3) CORS — allowlist, ASLA wildcard

   CORS_ORIGINS boşsa: hiçbir çapraz-origin isteğine izin verilmez.
   Bugünkü dağıtımda frontend aynı origin'den servis edildiği için bu
   varsayılan uygulamayı BOZMAZ (same-origin isteklerde tarayıcı Origin
   başlığını CORS denetimine sokmaz).

   credentials=true ile wildcard origin tarayıcı tarafından zaten
   reddedilir; burada her zaman tek ve tam origin yansıtılır.
   ========================================================= */
function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function cors(opts) {
  const allowed = new Set((opts && opts.origins) || []);
  const credentials = !!(opts && opts.credentials);
  const methods = (opts && opts.methods) || 'GET,POST,OPTIONS';
  const maxAge = (opts && opts.maxAge) || 600;

  return function corsMw(req, res, next) {
    const origin = req.headers.origin;

    // Origin yok => same-origin ya da tarayıcı dışı istemci. CORS devrede değil.
    if (!origin) {
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      return next();
    }

    const ok = allowed.has(origin);

    // Yanıt origin'e göre değiştiği için ara önbellekler bunu bilmeli
    res.setHeader('Vary', 'Origin');

    if (!ok) {
      // Preflight'ı sessizce reddet: CORS başlığı KOYMA. Tarayıcı isteği
      // kendisi engeller. Gerçek isteklerde de başlık koymayız - yanıt
      // istemciye ulaşsa bile JS okuyamaz.
      if (req.method === 'OPTIONS') { res.statusCode = 403; return res.end(); }
      const err = new Error('cors-origin-not-allowed');
      err.status = 403;
      err.publicMessage = 'Bu kaynağa bu adresten erişim izni yok.';
      err.safeType = 'cors_blocked';
      return next(err);
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit, RateLimit-Policy, Retry-After');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', methods);
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
      res.setHeader('Access-Control-Max-Age', String(maxAge));
      res.statusCode = 204;
      return res.end();
    }
    next();
  };
}

/* =========================================================
   4) RATE LIMIT — IP bazlı, sabit pencere

   Tek süreçli bir Node servisi için bellek içi sayaç yeterlidir. Birden
   fazla instance'a ölçeklendiğinde bu Redis'e taşınmalıdır (raporda
   belirtildi) - aksi halde limit instance sayısıyla çarpılır.

   Başlıklar: IETF taslağı (draft-8) "RateLimit" ve "RateLimit-Policy"
   formatı + yaygın kullanılan X-RateLimit-* eşlenikleri.
   ========================================================= */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      // En soldaki, proxy'nin eklediği gerçek istemci adresidir.
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* P1-2 (production audit fix): keyFn eklendi - limiteri neye göre sayacağını
   dışarıdan seçilebilir yaptık. Varsayılan hâlâ IP bazlı (davranış DEĞİŞMEDİ).
   Gerçek kullanıcı hesabı/authentication geldiğinde, server.js'de
   requireAuthenticatedUser'dan SONRA çalışan ikinci bir createRateLimiter
   örneği `keyFn: (req) => req.user.id` ile kurulup kullanıcı bazlı kotaya
   geçilebilir - bu fonksiyonun kendisinde başka hiçbir değişiklik gerekmez. */
function createRateLimiter(opts) {
  const windowMs = (opts && opts.windowMs) || 60000;
  const max = (opts && opts.max) || 10;
  const trustProxy = !!(opts && opts.trustProxy);
  const name = (opts && opts.name) || 'ai';
  const keyFn = (opts && typeof opts.keyFn === 'function')
    ? opts.keyFn
    : (req) => clientIp(req, trustProxy);

  const hits = new Map(); // key -> { count, resetAt }

  // Bellek sızıntısını engelle: süresi dolmuş kayıtları düzenli temizle.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) if (rec.resetAt <= now) hits.delete(key);
  }, Math.max(windowMs, 30000));
  if (sweeper.unref) sweeper.unref(); // süreç kapanışını engellemesin

  function middleware(req, res, next) {
    const ip = keyFn(req) || 'unknown';
    const now = Date.now();
    let rec = hits.get(ip);

    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count += 1;

    const remaining = Math.max(0, max - rec.count);
    const resetSec = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));

    res.setHeader('RateLimit-Policy', `${max};w=${Math.round(windowMs / 1000)}`);
    res.setHeader('RateLimit', `limit=${max}, remaining=${remaining}, reset=${resetSec}`);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rec.resetAt / 1000)));

    if (rec.count > max) {
      res.setHeader('Retry-After', String(resetSec));
      const err = new Error('rate-limit-exceeded');
      err.status = 429;
      // Frontend bu metni olduğu gibi gösterebilir; mevcut 429 metniyle uyumlu.
      err.publicMessage = 'Şu anda çok fazla istek var, lütfen biraz sonra tekrar dene.';
      err.safeType = 'rate_limited';
      return next(err);
    }
    next();
  }

  middleware.reset = () => hits.clear();
  middleware.stop = () => clearInterval(sweeper);
  middleware.name_ = name;
  return middleware;
}

/* =========================================================
   5) GÖVDE OKUMA + 512 KB LİMİTİ + JSON PARSE

   express.json() yerine geçer. İki nedenle:
     (a) /ai/coach hattını Express'ten bağımsız (ve test edilebilir) kılar,
     (b) express.json() bozuk JSON'da VARSAYILAN olarak HTML hata sayfası
         döner; frontend ise her durumda {error:"..."} JSON'u bekliyor.
   Limit ve davranış sözleşmesi aynen korunur: 512 KB, aşılırsa reddet.
   ========================================================= */
const BODY_LIMIT_BYTES = 512 * 1024;

function readJsonBody(opts) {
  const limit = (opts && opts.limit) || BODY_LIMIT_BYTES;

  return function readJsonBodyMw(req, res, next) {
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype && ctype !== 'application/json') {
      const err = new Error('unsupported-media-type');
      err.status = 415;
      err.publicMessage = 'İstek gövdesi application/json olmalı.';
      err.safeType = 'unsupported_media_type';
      return next(err);
    }

    // Content-Length biliniyorsa gövdeyi hiç okumadan reddet (ucuz yol).
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const err = new Error('payload-too-large');
      err.status = 413;
      err.publicMessage = 'İstek gövdesi çok büyük.';
      err.safeType = 'payload_too_large';
      return next(err);
    }

    let size = 0;
    const chunks = [];
    let done = false;

    const fail = (status, publicMessage, safeType) => {
      if (done) return;
      done = true;
      req.destroy();
      const err = new Error(safeType);
      err.status = status;
      err.publicMessage = publicMessage;
      err.safeType = safeType;
      next(err);
    };

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      // Content-Length yalan söylemiş ya da chunked gelmiş olabilir:
      // akış sırasında da denetle.
      if (size > limit) return fail(413, 'İstek gövdesi çok büyük.', 'payload_too_large');
      chunks.push(chunk);
    });

    req.on('error', () => fail(400, 'İstek okunamadı.', 'body_read_error'));

    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        const err = new Error('empty-body');
        err.status = 400;
        err.publicMessage = 'Geçersiz istek: gövde boş.';
        err.safeType = 'empty_body';
        return next(err);
      }
      try {
        req.body = JSON.parse(raw);
      } catch (e) {
        const err = new Error('invalid-json');
        err.status = 400;
        err.publicMessage = 'Geçersiz istek: gövde okunamadı.';
        err.safeType = 'invalid_json';
        return next(err);
      }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        const err = new Error('body-not-object');
        err.status = 400;
        err.publicMessage = 'Geçersiz istek: gövde bir JSON nesnesi olmalı.';
        err.safeType = 'body_not_object';
        return next(err);
      }
      next();
    });
  };
}

/* =========================================================
   6) /ai/coach İSTEK DOĞRULAMA

   Frontend sözleşmesi DEĞİŞMEZ: { question, lang, contextVersion,
   systemPromptHint, context, precomputed }. Buradaki kurallar mevcut
   server.js doğrulamalarının üst kümesidir - eskiden geçen hiçbir geçerli
   istek şimdi reddedilmez.
   ========================================================= */
const MAX_QUESTION_LENGTH = 500;      // frontend AI_QUESTION_MAX_LENGTH ile aynı
const MAX_HINT_LENGTH = 4000;         // backend zaten 1000'e kırpıyor; bu kaba üst sınır
const MAX_CONTEXT_KEYS = 200;         // beklenmedik şişkin nesneleri ele
const MAX_CONTEXT_DEPTH = 12;         // derin iç içe geçmiş yapı = kaynak tüketimi

function objectDepth(value, max, current) {
  current = current || 0;
  if (current > max) return current;
  if (!value || typeof value !== 'object') return current;
  let deepest = current;
  for (const key of Object.keys(value)) {
    const d = objectDepth(value[key], max, current + 1);
    if (d > deepest) deepest = d;
    if (deepest > max) return deepest;
  }
  return deepest;
}

function badRequest(message, safeType) {
  const err = new Error(safeType);
  err.status = 400;
  err.publicMessage = message;
  err.safeType = safeType;
  return err;
}

function validateCoachRequest(req, res, next) {
  if (req.method !== 'POST') {
    const err = new Error('method-not-allowed');
    err.status = 405;
    err.publicMessage = 'Bu uç nokta yalnızca POST kabul eder.';
    err.safeType = 'method_not_allowed';
    res.setHeader('Allow', 'POST, OPTIONS');
    return next(err);
  }

  const body = req.body || {};
  const { question, lang, contextVersion, systemPromptHint, context, precomputed } = body;

  // --- question (zorunlu) ---
  if (typeof question !== 'string' || !question.trim()) {
    return next(badRequest('Soru boş olamaz.', 'question_missing'));
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return next(badRequest(
      `Soru en fazla ${MAX_QUESTION_LENGTH} karakter olabilir.`,
      'question_too_long'
    ));
  }

  // --- context (zorunlu, düz nesne) ---
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return next(badRequest('Geçersiz istek: finansal context eksik veya hatalı.', 'context_invalid'));
  }
  if (Object.keys(context).length > MAX_CONTEXT_KEYS) {
    return next(badRequest('Geçersiz istek: finansal context beklenenden büyük.', 'context_too_large'));
  }
  if (objectDepth(context, MAX_CONTEXT_DEPTH) > MAX_CONTEXT_DEPTH) {
    return next(badRequest('Geçersiz istek: finansal context beklenen biçimde değil.', 'context_too_deep'));
  }

  // --- precomputed (opsiyonel; verildiyse düz nesne olmalı) ---
  if (precomputed != null) {
    if (typeof precomputed !== 'object' || Array.isArray(precomputed)) {
      return next(badRequest('Geçersiz istek: precomputed beklenen biçimde değil.', 'precomputed_invalid'));
    }
    if (objectDepth(precomputed, MAX_CONTEXT_DEPTH) > MAX_CONTEXT_DEPTH) {
      return next(badRequest('Geçersiz istek: precomputed beklenen biçimde değil.', 'precomputed_too_deep'));
    }
  }

  // --- lang (opsiyonel; tanınmayan değer sessizce 'tr'ye düşer - eski davranış) ---
  if (lang != null && typeof lang !== 'string') {
    return next(badRequest('Geçersiz istek: lang beklenen biçimde değil.', 'lang_invalid'));
  }

  // --- systemPromptHint (opsiyonel) ---
  if (systemPromptHint != null) {
    if (typeof systemPromptHint !== 'string') {
      return next(badRequest('Geçersiz istek: systemPromptHint beklenen biçimde değil.', 'hint_invalid'));
    }
    if (systemPromptHint.length > MAX_HINT_LENGTH) {
      return next(badRequest('Geçersiz istek: systemPromptHint çok uzun.', 'hint_too_long'));
    }
  }

  // --- contextVersion (opsiyonel; sayı değilse yanıtta null döner - eski davranış) ---
  if (contextVersion != null && typeof contextVersion !== 'number') {
    return next(badRequest('Geçersiz istek: contextVersion beklenen biçimde değil.', 'context_version_invalid'));
  }

  next();
}

/* =========================================================
   7) AUTH SINIRI — bilinçli olarak BOŞ

   Gerçek kimlik doğrulaması bu görevin kapsamı DIŞINDADIR ve burada
   TAKLİT EDİLMEMİŞTİR: sahte JWT, sabit token, sahte kullanıcı ya da
   frontend'e gömülü secret YOKTUR. Bu fonksiyon yalnızca gelecekteki
   gerçek doğrulamanın takılacağı TEK ve NET noktayı şimdiden ayırır.

   Bugünkü davranış: isteği olduğu gibi geçirir ve req.user = null bırakır
   - yani hiçbir kod "kimlik doğrulanmış" varsayımı yapamaz.

   ⚠ ÜRETİM RİSKİ: bu haliyle /ai/coach herkese açıktır. Uç noktayı bilen
   herkes OpenAI kotanızı sınırsız harcayabilir. Rate limit bunu yavaşlatır
   ama ORTADAN KALDIRMAZ (dağıtık IP'lerle aşılır). Gerçek auth devreye
   girene kadar bu servis ya özel ağda tutulmalı ya da önüne bir ağ geçidi
   (WAF / API gateway) konmalıdır.

   Gerçek auth geldiğinde YALNIZCA bu fonksiyonun içi doldurulur:
     1) oturum çerezini/Authorization başlığını doğrula
     2) geçersizse: 401 (kimlik yok/geçersiz) ya da 403 (yetki yok)
     3) geçerliyse: req.user = { id, ... } ata ve next()
   Çağrı yeri (server.js) değişmez.
   ========================================================= */
function requireAuthenticatedUser(req, res, next) {
  req.user = null;
  req.authMode = 'anonymous';
  next();
}

/* =========================================================
   8) MERKEZİ HATA YÖNETİCİSİ

   İstemciye: yalnızca güvenli bir mesaj + requestId.
   Loga: requestId, endpoint, status, süre, güvenli hata tipi. BAŞKA HİÇBİR ŞEY.
   Finansal context, soru metni, gövde, header, anahtar loglanmaz.
   ========================================================= */
function durationMs(req) {
  if (!req._startedAt) return null;
  return Number(process.hrtime.bigint() - req._startedAt) / 1e6;
}

function logLine(req, status, safeType) {
  const d = durationMs(req);
  return JSON.stringify({
    requestId: req.id || null,
    method: req.method,
    endpoint: (req.originalUrl || req.url || '').split('?')[0], // sorgu dizesi loglanmaz
    status,
    durationMs: d == null ? null : Math.round(d * 10) / 10,
    type: safeType,
  });
}

function createErrorHandler(opts) {
  const logger = (opts && opts.logger) || console;

  // Express 4 hata middleware'i 4 argümanla tanınır - imzayı değiştirme.
  return function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    const status = (err && Number(err.status)) || 500;
    const safeType = (err && err.safeType) || 'internal_error';

    // 5xx'i error, 4xx'i warn seviyesinde logla. Gövde asla loglanmaz.
    const line = logLine(req, status, safeType);
    if (status >= 500) logger.error(line);
    else logger.warn(line);

    if (res.headersSent) return;

    const publicMessage = (err && err.publicMessage)
      ? err.publicMessage
      // Beklenmeyen hata: mesajı ASLA sızdırma, genel metin dön.
      : 'Beklenmeyen bir hata oluştu.';

    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: publicMessage, requestId: req.id || null }));
  };
}

/* Başarılı istekleri de aynı güvenli alanlarla loglamak için (opsiyonel). */
function accessLog(opts) {
  const logger = (opts && opts.logger) || console;
  const enabled = !(opts && opts.enabled === false);
  return function accessLogMw(req, res, next) {
    if (!enabled) return next();
    res.on('finish', () => {
      if (res.statusCode < 400) logger.log(logLine(req, res.statusCode, 'ok'));
    });
    next();
  };
}

module.exports = {
  requestId,
  securityHeaders,
  cors,
  parseOrigins,
  createRateLimiter,
  readJsonBody,
  validateCoachRequest,
  requireAuthenticatedUser,
  createErrorHandler,
  accessLog,
  clientIp,
  BODY_LIMIT_BYTES,
  MAX_QUESTION_LENGTH,
};
