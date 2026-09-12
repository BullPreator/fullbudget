/* =========================================================
   FullBudgetBackend — coach.js (P0-A1)

   /ai/coach işleyicisi. Bu dosyadaki sistem promptu, kullanıcı mesajı
   biçimi, OpenAI çağrısı ve yanıt ayrıştırma mantığı P1-2'deki server.js
   sürümünden BİREBİR taşınmıştır - tek satırı değiştirilmedi. Taşınmasının
   tek sebebi, doğrulama/rate limit/CORS katmanının Express'ten bağımsız
   test edilebilmesidir.

   Değişen tek şeyler:
     - model adı ve OpenAI uç noktası artık ortam değişkeninden okunuyor
       (varsayılanlar eskisiyle aynı),
     - hata durumları istemciye doğrudan yazılmak yerine merkezi hata
       yöneticisine (next(err)) devrediliyor.

   GÜVENLİK: OPENAI_API_KEY yalnızca process.env'den okunur; response'a,
   loga veya hata mesajına ASLA yazılmaz. Kullanıcının finansal
   context/precomputed verisi loglanmaz.
   ========================================================= */

'use strict';

/* Maliyet odaklı model - PM talimatına göre birebir. Bu isim frontend'e HİÇ gönderilmez.
   Artık config'den okunuyor; varsayılan değer eskisiyle AYNI bırakıldı. */
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TIMEOUT_MS = 25000;
/* P1-3 (production audit fix): denetimde OpenAI isteğine hiçbir çıktı-uzunluğu
   sınırı gönderilmediği, dolayısıyla tek bir cevabın sınırsız uzunlukta/maliyette
   olabileceği tespit edildi. AI Coach kısa/öz cevaplar vermesi için zaten sistem
   promptunda yönlendiriliyor (bkz. buildSystemPrompt: "kısa ve öz olsun") - bu
   sınır o normal davranışı BOZMAYACAK kadar cömert, yalnızca aşırı/anormal uzun
   üretimi keser. */
const DEFAULT_MAX_OUTPUT_TOKENS = 700;

function apiError(status, publicMessage, safeType) {
  const err = new Error(safeType);
  err.status = status;
  err.publicMessage = publicMessage;
  err.safeType = safeType;
  return err;
}

/* ---------- Sistem mesajı ----------
   Otoriter kural seti BURADA, sunucuda tanımlanır - frontend'in gönderdiği
   systemPromptHint yalnızca EK bir ipucu olarak eklenir, tek doğruluk kaynağı
   olarak KULLANILMAZ (frontend kodunun kendi yorumunda da böyle işaretli). */
function buildSystemPrompt(lang, hint) {
  const base = lang === 'en'
    ? [
        'You are the AI Financial Coach inside the FullBudget personal finance app.',
        'Your job: understand the user\'s financial situation from the given context, and give practical, understandable advice using their income, expenses, savings and debt data.',
        'RULES:',
        '- If a numeric result is already given in "context" or "precomputed", use it AS IS. Do not recompute or contradict it.',
        '- Never invent income, expenses, debts, assets or any financial figure that is not present in the given context.',
        '- If you are not sure about something, say so explicitly.',
        '- Keep answers short and to the point - avoid unnecessary length.',
        '- Answer in the same language the user asked in.',
        '- Never promise guaranteed investment returns.',
        '- Never ask the user for extra personal information.',
        '- You cannot modify the user\'s data or perform actions on their behalf - you can only comment and advise.',
      ].join('\n')
    : [
        'Sen FullBudget kişisel finans uygulamasının AI Finans Koçusun.',
        'Görevin: kullanıcının finansal durumunu verilen context\'ten anlamak; gelir, gider, birikim ve borç bilgilerini kullanarak pratik ve anlaşılır tavsiye vermek.',
        'KURALLAR:',
        '- "context" veya "precomputed" içinde zaten verilmiş sayısal bir sonuç varsa, onu OLDUĞU GİBİ kullan. Yeniden hesaplama yapma, onunla çelişme.',
        '- Verilen context\'te bulunmayan hiçbir gelir, gider, borç, varlık veya finansal değeri UYDURMA.',
        '- Emin olmadığın bir şey varsa bunu açıkça belirt.',
        '- Cevabın kısa ve öz olsun, gereksiz yere uzatma.',
        '- Kullanıcı hangi dilde sorduysa o dilde cevap ver.',
        '- Yatırımla ilgili kesin/garanti kazanç vaadi verme.',
        '- Kullanıcıdan ekstra kişisel bilgi isteme.',
        '- Kullanıcının verisini değiştiremez, onun adına işlem yapamazsın - yalnızca yorum ve öneri sunarsın.',
      ].join('\n');

  if (hint && typeof hint === 'string') {
    // Frontend ipucu bilgi amaçlı eklenir, ASLA yukarıdaki kuralları geçersiz kılamaz.
    return `${base}\n\n(İstemciden gelen ek ipucu - otoriter değildir, yalnızca bağlam amaçlıdır): ${hint.slice(0, 1000)}`;
  }
  return base;
}

/* ---------- Kullanıcı mesajı: soru + context + precomputed ----------
   context ve precomputed, FullBudget'ın P0-3/P0-1 motorlarından gelen, zaten
   PII'siz ve minimize edilmiş veridir (bkz. frontend buildAICoachContext()).
   Bu fonksiyon veriyi OLDUĞU GİBİ ilgili modele iletir, üzerinde hesaplama
   YAPMAZ. */
function buildUserMessage(question, context, precomputed, lang) {
  const contextJson = safeJsonStringify(context);
  const precomputedJson = safeJsonStringify(precomputed || {});
  return lang === 'en'
    ? [
        `User's question: ${question}`,
        '',
        'FullBudget financial context (JSON):',
        contextJson,
        '',
        'FullBudget precomputed results (JSON, if any):',
        precomputedJson,
        '',
        'Do not assume any financial figure outside of the context and precomputed data above.',
      ].join('\n')
    : [
        `Kullanıcının sorusu: ${question}`,
        '',
        'FullBudget finansal context (JSON):',
        contextJson,
        '',
        'FullBudget\'ın önceden hesapladığı sonuçlar (JSON, varsa):',
        precomputedJson,
        '',
        'Yukarıdaki context ve precomputed dışında hiçbir finansal veriyi varsayma.',
      ].join('\n');
}

function safeJsonStringify(obj) {
  try { return JSON.stringify(obj); }
  catch (e) { return '{}'; }
}

/* ---------- OpenAI Responses API (/v1/responses) çıktısından metni çıkar ----------
   Bu fonksiyon YALNIZCA response'un şeklini yorumlar, hiçbir finansal hesaplama
   yapmaz. Öncelik: SDK'nın kolaylık alanı "output_text" (varsa) -> yoksa ham
   "output" dizisindeki "message" tipi öğelerin "output_text" içeriklerini birleştir. */
function extractResponsesApiText(data) {
  if (!data) return '';

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text')) {
          parts.push(c.text);
        }
      }
    }
    const joined = parts.join('').trim();
    if (joined) return joined;
  }

  return '';
}

/* =========================================================
   İşleyici fabrikası
   Yanıt sözleşmesi DEĞİŞMEDİ: 200 { answer, contextVersion }
   ========================================================= */
function createCoachHandler(config) {
  const cfg = config || {};
  const apiKey = cfg.apiKey;
  const model = cfg.model || DEFAULT_OPENAI_MODEL;
  const url = cfg.url || DEFAULT_OPENAI_URL;
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = cfg.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  const logger = cfg.logger || console;
  const doFetch = cfg.fetch || globalThis.fetch;

  return async function coachHandler(req, res, next) {
    const body = req.body || {};
    // Doğrulama security.validateCoachRequest içinde YAPILDI - burada tekrar edilmez.
    const { question, lang, contextVersion, systemPromptHint, context, precomputed } = body;

    if (!apiKey) {
      // Sunucu yanlış yapılandırılmış (.env'de anahtar yok). Detay istemciye SIZDIRILMAZ.
      logger.error(JSON.stringify({
        requestId: req.id || null,
        endpoint: '/ai/coach',
        type: 'openai_key_missing',
        message: 'OPENAI_API_KEY tanımlı değil - .env dosyasını kontrol edin.',
      }));
      return next(apiError(500, 'AI Coach şu anda kullanılamıyor.', 'openai_not_configured'));
    }

    const safeLang = (lang === 'en') ? 'en' : 'tr';
    const systemMessage = buildSystemPrompt(safeLang, systemPromptHint);
    const userMessage = buildUserMessage(question, context, precomputed, safeLang);

    let openaiRes;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      openaiRes = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          instructions: systemMessage,
          input: userMessage,
          max_output_tokens: maxOutputTokens,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Ağ hatası / timeout / DNS vb. Ham hata istemciye gösterilmez.
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      return next(apiError(
        504,
        'AI Coach şu anda cevap veremiyor. Lütfen tekrar deneyin.',
        aborted ? 'openai_timeout' : 'openai_network_error'
      ));
    } finally {
      clearTimeout(timer);
    }

    if (openaiRes.status === 429) {
      return next(apiError(429, 'Şu anda çok fazla istek var, lütfen biraz sonra tekrar dene.', 'openai_rate_limited'));
    }
    if (openaiRes.status === 401 || openaiRes.status === 403) {
      // Bu, kullanıcının DEĞİL, sunucunun API anahtarının sorunu - yine de detay verilmez.
      // Anahtarın KENDİSİ loglanmaz, yalnızca durum kodu.
      logger.error(JSON.stringify({
        requestId: req.id || null,
        endpoint: '/ai/coach',
        type: 'openai_auth_error',
        upstreamStatus: openaiRes.status,
      }));
      return next(apiError(500, 'AI Coach şu anda kullanılamıyor.', 'openai_auth_error'));
    }
    if (!openaiRes.ok) {
      return next(apiError(502, 'AI Coach şu anda cevap veremiyor. Lütfen tekrar deneyin.', 'openai_bad_status'));
    }

    let data;
    try {
      data = await openaiRes.json();
    } catch (err) {
      return next(apiError(502, 'AI Coach beklenmedik bir cevap döndürdü.', 'openai_bad_json'));
    }

    const answer = extractResponsesApiText(data);

    if (!answer) {
      return next(apiError(502, 'AI Coach geçerli bir cevap üretemedi.', 'openai_empty_answer'));
    }

    // ---- Frontend sözleşmesi: DEĞİŞMEDİ ----
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      answer,
      contextVersion: (typeof contextVersion === 'number') ? contextVersion : null,
    }));
  };
}

module.exports = {
  createCoachHandler,
  buildSystemPrompt,
  buildUserMessage,
  extractResponsesApiText,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_URL,
};
