/* =========================================================
   FullBudgetBackend — server.js (P0-A1 hardened)

   Görev: frontend'i (FullBudget index.html) servis etmek ve gerçek AI Coach
   sorularını, API anahtarını hiçbir zaman istemciye göstermeden OpenAI'a
   aktarmak.

   P0-A1'de eklenenler (davranış sözleşmesi KORUNARAK):
     - IP bazlı rate limit (yalnızca /ai/coach)
     - Sıkı istek doğrulama + 512 KB gövde limiti
     - Güvenlik başlıkları (helmet eşdeğeri, bağımlılıksız)
     - CORS allowlist (ASLA wildcard), ortam değişkeninden
     - Gerçek auth için temiz sınır (requireAuthenticatedUser) - sahte auth YOK
     - Merkezi hata yöneticisi (stack/anahtar/yol sızdırmaz)
     - Her isteğe correlation id (X-Request-Id)
     - Graceful shutdown (SIGTERM/SIGINT)
     - Model adı ve OpenAI uç noktası config'den

   GÜVENLİK KURALLARI (bu dosya boyunca korunur):
     - OPENAI_API_KEY yalnızca process.env üzerinden okunur, asla response'a
       veya console.log'a yazılmaz.
     - Kullanıcının finansal context/precomputed verisi gereksiz yere loglanmaz.
     - OpenAI'dan dönen ham hata detayı istemciye gösterilmez - yalnızca
       güvenli, genel bir mesaj döner.
     - Auth hâlâ implemente EDİLMEDİ (bilinçli - P0-A1 dışı). Sahte bir auth
       taklit edilmedi; yalnızca gerçek auth'un takılacağı tek nokta ayrıldı.
       ⚠ Bu haliyle /ai/coach herkese açıktır - bkz. security.js içindeki
       requireAuthenticatedUser açıklaması.
   ========================================================= */

'use strict';

try { require('dotenv').config(); } catch (e) { /* dotenv kurulu değilse process.env zaten kullanılabilir olabilir */ }

const express = require('express');
const path = require('path');
const http = require('http');

const sec = require('./security');
const { createCoachHandler, DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_URL } = require('./coach');
const { attachGracefulShutdown } = require('./shutdown');

/* ---------- Yapılandırma (hepsi ortam değişkeninden, güvenli varsayılanlarla) ---------- */
function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CONFIG = {
  port:        intEnv('PORT', 3000),
  production:  process.env.NODE_ENV === 'production',
  trustProxy:  process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  corsOrigins: sec.parseOrigins(process.env.CORS_ORIGINS),
  // credentials yalnızca açıkça istendiğinde; allowlist ile birlikte güvenli.
  corsCredentials: process.env.CORS_CREDENTIALS === '1' || process.env.CORS_CREDENTIALS === 'true',
  rateLimit: {
    windowMs: intEnv('AI_RATE_LIMIT_WINDOW_MS', 60 * 1000),
    max:      intEnv('AI_RATE_LIMIT_MAX', 10),
    // P1-2 (production audit fix): IP bazlı limit dağıtık IP'lerle aşılabildiği
    // için (bkz. security.js madde 7 yorumu), TÜM istemciler toplamında sunucu
    // genelinde bir tavan da eklendi - gerçek auth gelene kadar OpenAI maliyetini
    // üst sınırlayan ikinci bir savunma katmanı. IP limiti değişmedi, buna EK.
    globalMax: intEnv('AI_RATE_LIMIT_GLOBAL_MAX', 60),
  },
  openai: {
    // Anahtar SADECE burada okunur ve yalnızca coach handler'a geçer.
    apiKey:    process.env.OPENAI_API_KEY,
    model:     process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    url:       process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_URL,
    timeoutMs: intEnv('OPENAI_TIMEOUT_MS', 25000),
    // P1-3 (production audit fix): tek bir cevabın üretebileceği token sayısına
    // üst sınır - denetimde bu alanın hiç gönderilmediği, dolayısıyla tek bir
    // isteğin maliyetinin sınırsız olabileceği tespit edilmişti.
    maxOutputTokens: intEnv('OPENAI_MAX_OUTPUT_TOKENS', 700),
  },
};

/* ---------- Uygulama ---------- */
function createApp(config) {
  const cfg = config || CONFIG;
  const app = express();

  // "X-Powered-By: Express" bilgi sızıntısını kapat.
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', true);

  // Her istek: correlation id + güvenlik başlıkları + erişim logu.
  app.use(sec.requestId);
  app.use(sec.securityHeaders({ production: cfg.production, trustProxy: cfg.trustProxy }));
  app.use(sec.accessLog({ enabled: process.env.ACCESS_LOG !== '0' }));

  /* ---------- GET /health ----------
     Rate limit UYGULANMAZ (load balancer / uptime probe'u boğulmamalı).
     CORS uygulanmaz, kimlik doğrulama gerektirmez.
     OpenAI anahtarının DEĞERİ hiçbir şekilde yanıta girmez - yalnızca
     "yapılandırılmış mı" bilgisi (boolean) döner. */
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      // DİKKAT: anahtarın kendisi DEĞİL, yalnızca varlığı.
      openaiConfigured: !!cfg.openai.apiKey,
    });
  });

  /* ---------- POST /ai/coach ----------
     Zincir sırası bilinçli:
       cors        → izinsiz origin en başta elenir
       rateLimit   → pahalı işten önce, gövde okunmadan
       body        → 512 KB limiti + JSON parse
       auth sınırı → bugün geçirgen (gerçek auth buraya takılacak)
       validate    → şekil/uzunluk denetimi
       handler     → OpenAI çağrısı

     Başarılı: 200 { answer, contextVersion }   ← SÖZLEŞME DEĞİŞMEDİ
     Hata:     400 geçersiz istek | 403 CORS | 405 yanlış metot |
               413 çok büyük gövde | 415 yanlış içerik tipi |
               429 rate limit | 500/502/504 backend veya OpenAI hatası */
  const aiLimiter = sec.createRateLimiter({
    windowMs: cfg.rateLimit.windowMs,
    max: cfg.rateLimit.max,
    trustProxy: cfg.trustProxy,
    name: 'ai-coach',
  });

  /* P1-2 (production audit fix): sunucu-geneli (tüm IP'ler toplamında) ikinci
     bir tavan. Amaç: gerçek authentication henüz yokken, dağıtık IP'lerden
     gelen bir saldırının IP-bazlı limiti aşarak OpenAI kotasını sınırsız
     tüketmesini engellemek. Tek anahtarlı (sabit key) bir createRateLimiter
     örneği - üstteki fonksiyonda hiçbir değişiklik gerektirmedi (keyFn hook'u
     sayesinde). windowMs aynı pencereyi paylaşır, tavan AI_RATE_LIMIT_GLOBAL_MAX
     ile ayrıca yapılandırılabilir (varsayılan 60/dakika, tüm istemciler toplam). */
  const aiGlobalLimiter = sec.createRateLimiter({
    windowMs: cfg.rateLimit.windowMs,
    max: cfg.rateLimit.globalMax,
    trustProxy: cfg.trustProxy,
    name: 'ai-coach-global',
    keyFn: () => '__global__',
  });

  const corsMw = sec.cors({
    origins: cfg.corsOrigins,
    credentials: cfg.corsCredentials,
    methods: 'POST,OPTIONS',
  });

  const coachHandler = createCoachHandler({
    apiKey: cfg.openai.apiKey,
    model: cfg.openai.model,
    url: cfg.openai.url,
    timeoutMs: cfg.openai.timeoutMs,
    maxOutputTokens: cfg.openai.maxOutputTokens,
    fetch: cfg.fetch,
  });

  app.options('/ai/coach', corsMw);
  app.post('/ai/coach',
    corsMw,
    aiGlobalLimiter,
    aiLimiter,
    sec.readJsonBody({ limit: sec.BODY_LIMIT_BYTES }),
    sec.requireAuthenticatedUser,
    sec.validateCoachRequest,
    (req, res, next) => { Promise.resolve(coachHandler(req, res, next)).catch(next); }
  );

  // POST dışındaki metotlar için net 405 (validate içindeki kuralla aynı mesaj).
  app.all('/ai/coach', corsMw, sec.validateCoachRequest);

  /* ---------- Statik dosyalar + GET / ----------
     public/index.html = FullBudget'ın frontend dosyasının kopyası. Bu server
     yeni bir frontend YAZMAZ, var olanı servis eder.
     NOT (denetim bulgusu B3): bu kopyanın güncel frontend ile eşitlenmesi ayrı
     bir dağıtım adımıdır; bu görevin kapsamı dışındadır. */
  app.use(express.static(path.join(__dirname, 'public'), {
    // dotfile'lar (.env vb.) hiçbir koşulda servis edilmesin.
    dotfiles: 'ignore',
    index: false,
  }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  /* ---------- 404 ---------- */
  app.use((req, res, next) => {
    const err = new Error('not-found');
    err.status = 404;
    err.publicMessage = 'Kaynak bulunamadı.';
    err.safeType = 'not_found';
    next(err);
  });

  /* ---------- Merkezi hata yöneticisi (zincirin EN SONU) ---------- */
  app.use(sec.createErrorHandler({}));

  // Testlerin limiti sıfırlayabilmesi / zamanlayıcıyı durdurabilmesi için.
  app.locals.aiLimiter = aiLimiter;
  return app;
}

/* ---------- Başlat (doğrudan çalıştırıldığında) ----------
   Graceful shutdown ./shutdown.js içinde (Express'ten bağımsız, ayrı test ediliyor). */
function start(config) {
  const cfg = config || CONFIG;
  const app = createApp(cfg);
  const server = http.createServer(app);

  attachGracefulShutdown(server, {});

  server.listen(cfg.port, () => {
    // NOT: API anahtarı, kullanıcı context'i veya başka hassas veri BURADA loglanmaz.
    // Yalnızca anahtarın VAR OLUP OLMADIĞI bilgisi - değeri değil.
    console.log(JSON.stringify({
      type: 'server_started',
      port: cfg.port,
      env: cfg.production ? 'production' : 'development',
      corsOrigins: cfg.corsOrigins.length,
      aiRateLimit: `${cfg.rateLimit.max}/${Math.round(cfg.rateLimit.windowMs / 1000)}s`,
      openaiConfigured: !!cfg.openai.apiKey,
      model: cfg.openai.model,
    }));
    if (!cfg.openai.apiKey) {
      console.error(JSON.stringify({ type: 'config_warning', message: 'OPENAI_API_KEY tanımlı değil - /ai/coach 500 dönecek.' }));
    }
    if (cfg.production && cfg.corsOrigins.length === 0) {
      console.error(JSON.stringify({ type: 'config_warning', message: 'CORS_ORIGINS boş - çapraz origin istekleri reddedilecek.' }));
    }
  });

  return server;
}

if (require.main === module) start();

module.exports = { createApp, start, attachGracefulShutdown, CONFIG };
