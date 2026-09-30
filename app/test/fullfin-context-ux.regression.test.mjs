// FULLFIN — PULSE GİRİŞ NOKTASI, SESSİZ AÇILIŞ, BAĞLAMSAL ÇİPLER, ANA SAYFA NOTU
// -----------------------------------------------------------------------
// Amaç: FullFin'i (mevcut yüzen pulse panelinin ürün kimliği) "VERİ → HESAP → DİL → ERİŞİM"
// zincirine oturtan UX davranışlarını gerçek bir Chromium sayfasında, gerçek app/index.html
// üzerinde doğrulamak. YENİ bir chat/hesap motoru test edilmiyor: panel hâlâ aynı
// aiChatHistory/askCoach() akışını, bağlamsal çipler de aynı Decision Engine / GCAE
// sonuçlarını kullanıyor. Yöntem finance-coach-launcher.regression.test.mjs ile aynı.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..'); // repo kökü (app/ ve app/index.html'i içerir)

let server, browser, baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    try {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/app/index.html';
      const filePath = path.join(appDir, reqPath);
      if (!filePath.startsWith(appDir)) { res.writeHead(403); res.end(); return; }
      const body = readFileSync(filePath);
      const ct = filePath.endsWith('.html') ? 'text/html' : filePath.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(body);
    } catch (e) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/app/index.html`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function newPage(viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  // 'domcontentloaded' yerine 'load' kullanılmadı: bu sandbox ortamında döviz/altın
  // kuru API'leri ve Google Fonts gibi dış kaynaklara giden istekler egress politikası
  // tarafından reddediliyor ve 'load' olayı hiç tetiklenmeyebiliyor (gerçek CI/production
  // ortamında bu kısıtlama yok). DOM ve script'lerin çalışması için 'domcontentloaded'
  // yeterli ve daha güvenilir.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(300); // inline script'lerin ilk render'ı tamamlaması için kısa pay
  // Onboarding/auth overlaylerini kapat — AYNI desen ai-coach-priority-plan.regression.test.mjs
  // dosyasındaki newSession() ile (uygulamanın ilk açılış akışı, kopyalanmadı, aynen izlendi).
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s);
        return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) {
        const b = await page.$(btn);
        if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; }
        break;
      }
      await page.waitForTimeout(150);
    }
  }
  // Açılış splash ekranı (varsa) kısa bir süre sonra kendiliğinden kalkar; garanti olsun diye
  // gizli olmasını bekle - gerçek uygulama akışına müdahale etmez, yalnızca bekler.
  await page.waitForFunction(() => {
    const s = document.getElementById('splashScreen');
    return !s || getComputedStyle(s).display === 'none' || getComputedStyle(s).visibility === 'hidden' || getComputedStyle(s).opacity === '0';
  }, null, { timeout: 6000 }).catch(() => {});
  return { page, consoleErrors };
}


const MOBILE = { width: 430, height: 700 };

// Gerçek finansal durum kur (mevcut testlerdeki AYNI desen — yeni bir state yolu icat edilmedi).
async function seed(page, s) {
  await page.evaluate((d) => {
    persistent.accounts = d.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: d.assets, currency: 'TRY' }] : [];
    persistent.debts = d.debts || [];
    persistent.creditCards = [];
    month.incomes = d.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: d.income }] : [];
    month.expenses = d.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: d.expenses }] : [];
    persistent.goals = d.goals || [];
    render();
  }, s);
  await page.waitForTimeout(150);
}

async function openFullFin(page) {
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(120);
}

const chips = (page) => page.locator('#fcMessages .fc-quick-btn').allTextContents();

// TEK STANDART: sabit çipler bu üç metindir. UI, starter prompt ve testler AYNI diziyi kullanır.
const FIXED_TR = ['Bu ay param nereye gidiyor?', 'Bütçem tutuyor mu?', 'Durumumu özetle'];

// ---------------------------------------------------------------- A–E: sessiz açılış + başlık
test('A-E: pulse FullFin sheet\'ini açar; başlık/alt satır doğru, karşılama mesajı YOK', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });
  await openFullFin(page);

  const head = await page.evaluate(() => ({
    title: document.getElementById('fcHeaderTitle').textContent.trim(),
    sub: document.getElementById('fcHeaderSub').textContent.trim(),
    body: document.getElementById('fcMessages').textContent,
    assistantBubbles: document.querySelectorAll('#fcMessages .fc-msg.assistant').length,
    anyBubbles: document.querySelectorAll('#fcMessages .fc-msg').length,
    historyLen: aiChatHistory.length,
    placeholder: document.getElementById('fcInput').getAttribute('placeholder'),
  }));
  assert.equal(head.title, 'FullFin');
  assert.equal(head.sub, 'Verine bakarak netleştir. Karar sende kalır.');
  // Sheet kendini tanıtmaz: selamlama/"ben FullFin" yok, emoji yok.
  assert.equal(/merhaba|selam|hello|hi\b|ben fullfin|i'?m fullfin|finans koçun/i.test(head.body), false, `karşılama metni olmamalı: ${head.body}`);
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(head.body), false, 'emoji kullanılmamalı');
  assert.equal(head.body.includes('\u{1F44B}'), false, '👋 kullanılmamalı');
  // FullFin kullanıcı etkileşimi olmadan KONUŞMAZ.
  assert.equal(head.assistantBubbles, 0, 'açılışta FullFin mesajı olmamalı');
  assert.equal(head.anyBubbles, 0, 'açılışta hiç mesaj balonu olmamalı');
  assert.equal(head.historyLen, 0, 'açılış sohbet geçmişine hiçbir şey yazmamalı');
  assert.equal(head.placeholder, 'Bir soru sor...');
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

// ---------------------------------------------------------------- H, I, L, M, K: çip mimarisi
test('H/I/L/M: Ana Sayfa\'da 1 bağlamsal + 3 sabit çip; bağlamsal çip gerçek planlanabilir tutarı taşır', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });
  await page.evaluate(() => { setTab('home'); render(); });
  await openFullFin(page);

  const texts = await chips(page);
  assert.equal(texts.length, 4, `1 bağlamsal + 3 sabit = 4 olmalı, gelen: ${JSON.stringify(texts)}`);
  const contextCount = await page.locator('#fcMessages .fc-quick-btn[data-fc-context="1"]').count();
  assert.equal(contextCount, 1, 'tek bir bağlamsal çip olmalı');
  // Bağlamsal çip EN ÜSTTE.
  const firstIsContext = await page.evaluate(() =>
    document.querySelector('#fcMessages .fc-quick-btn').dataset.fcContext === '1');
  assert.equal(firstIsContext, true, 'bağlamsal çip ilk sırada olmalı');

  // Rakam hard-code DEĞİL: canlı GCAE sonucundan geliyor (Ana Sayfa'daki "Planlanabilir tutar" ile aynı kaynak).
  const expected = await page.evaluate(() => {
    const r = runMonthlyGoalCashAllocationLive();
    return `${CUR}${fmt(r.distributableCash)}`;
  });
  assert.ok(texts[0].includes(expected), `bağlamsal çip gerçek planlanabilir tutarı içermeli (${expected}): ${texts[0]}`);

  // Sabit üçlü tam olarak bu ve "Hedeflerimi gözden geçir" global sabit çip DEĞİL.
  assert.deepEqual(texts.slice(1), FIXED_TR, 'sabit üçlü tam olarak bu metinler olmalı');
  assert.equal(texts.some(t => /hedeflerimi gözden geçir/i.test(t)), false, '"Hedeflerimi gözden geçir" sabit çip olmamalı');
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

// ---------------------------------------------------------------- J: hedef ekranı bağlamı
test('J: Hedefler ekranında bağlamsal çip gerçek hedef adına göre değişir', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  const far = new Date(Date.now() + 500 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await seed(page, {
    income: 90000, expenses: 20000, assets: 150000,
    goals: [{ id: 'g1', typeKey: 'ev', referenceId: 'custom', targetAmount: 3000000, currentSaved: 0, targetDate: far }],
  });
  await page.evaluate(() => { setTab('goals'); render(); });
  await openFullFin(page);
  const texts = await chips(page);
  const name = await page.evaluate(() => goalDisplayName(pickPrimaryGoal().g));
  assert.ok(name && name.length, 'test kurulumu gerçek bir birincil hedef üretmeli');
  assert.ok(texts[0].includes(name), `hedef ekranındaki bağlamsal çip hedef adını taşımalı (${name}): ${texts[0]}`);
  assert.equal(texts.length, 4);

  // Aynı oturumda Ana Sayfa'ya dönünce bağlam DEĞİŞİR (tek bir sabit metin değil).
  await page.locator('#fcCloseBtn').click();
  await page.waitForTimeout(250);
  await page.evaluate(() => { setTab('home'); render(); });
  await openFullFin(page);
  const homeTexts = await chips(page);
  assert.notEqual(homeTexts[0], texts[0], 'bağlamsal çip ekrana göre değişmeli');
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

// ---------------------------------------------------------------- R: uydurma bağlam yok
test('R: güvenilir bağlam yokken uydurma soru üretilmez — yalnızca 3 sabit çip kalır', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  // Hiç gelir/gider/varlık/hedef/borç yok → hiçbir ekran için gerçek bağlam yok.
  await seed(page, { income: 0, expenses: 0, assets: 0, goals: [], debts: [] });
  for (const tab of ['home', 'goals', 'debts', 'assets']) {
    await page.evaluate((t) => { setTab(t); render(); }, tab);
    await openFullFin(page);
    const texts = await chips(page);
    assert.equal(texts.length, 3, `${tab}: bağlam yokken yalnızca 3 sabit çip olmalı, gelen: ${JSON.stringify(texts)}`);
    assert.equal(await page.locator('#fcMessages .fc-quick-btn[data-fc-context="1"]').count(), 0, `${tab}: bağlamsal çip olmamalı`);
    await page.locator('#fcCloseBtn').click();
    await page.waitForTimeout(220);
  }
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

// ---------------------------------------------------------------- N, O, P: etkileşim
test('N/O/P: çipe basınca kullanıcı balonu oluşur ve FullFin ilk kez konuşur; input ile de gönderilebilir', async () => {
  const { page } = await newPage(MOBILE);
  await page.evaluate(() => { FB_AI_CONFIG.backendUrl = ''; });   // mevcut şablon yolu (ağ yok)
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });
  await page.evaluate(() => { setTab('home'); render(); });
  await openFullFin(page);
  const first = (await chips(page))[0];

  await page.locator('#fcMessages .fc-quick-btn').first().click();
  await page.waitForTimeout(60);
  const userText = await page.locator('#fcMessages .fc-msg.user').first().textContent();
  assert.equal(userText.trim(), first, 'çip metni kullanıcı balonu olarak görünmeli');
  await page.waitForFunction(() => !aiRequestInFlight, null, { timeout: 15000 });
  const answer = await page.locator('#fcMessages .fc-msg.assistant').first().textContent();
  assert.ok(answer && answer.trim().length > 0, 'FullFin bir cevap üretmeli');
  // Yatırım tavsiyesi dili yok (mevcut güvenlik ilkesi korunuyor).
  assert.equal(/kesinlikle şunu yap|paranı şuna yatır|bunu satın al|en iyi yatırım/i.test(answer), false, `tavsiye dili kullanılmamalı: ${answer}`);

  await page.locator('#fcInput').fill(FIXED_TR[1]);
  await page.locator('#fcSendBtn').click();
  await page.waitForTimeout(60);
  const userCount = await page.locator('#fcMessages .fc-msg.user').count();
  assert.ok(userCount >= 2, 'input ile gönderilen soru da kullanıcı balonu oluşturmalı');
  await page.waitForFunction(() => !aiRequestInFlight, null, { timeout: 15000 });
  await page.close();
});

// ---------------------------------------------------------------- F, G: pulse ≠ mikrofon
test('F/G: pulse FullFin\'i açar, tab bar mikrofonu kendi işlevinde kalır (ikisi ayrı)', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });

  const wiring = await page.evaluate(() => {
    const l = document.getElementById('fcLauncher');
    const mic = document.getElementById('quickAddMicBtn');
    return {
      launcherLabel: l.getAttribute('aria-label'),
      launcherControls: l.getAttribute('aria-controls'),
      micExists: !!mic,
      micLabel: mic ? mic.getAttribute('aria-label') : null,
      sameNode: !!mic && mic === l,
      micInsidePanel: !!mic && !!mic.closest('#fcPanel'),
    };
  });
  assert.equal(wiring.launcherLabel, "FullFin'i aç");
  assert.equal(wiring.launcherControls, 'fcPanel');
  assert.equal(wiring.micExists, true, 'sesli giriş mikrofonu yerinde kalmalı');
  assert.equal(wiring.sameNode, false, 'pulse ve mikrofon aynı düğme OLAMAZ');
  assert.equal(wiring.micInsidePanel, false);
  assert.ok(/ses/i.test(wiring.micLabel || ''), `mikrofonun etiketi sesli girişi anlatmalı: ${wiring.micLabel}`);

  // Mikrofona basmak FullFin panelini AÇMAZ.
  await page.evaluate(() => { const m = document.getElementById('quickAddMicBtn'); if (m) m.click(); });
  await page.waitForTimeout(250);
  assert.notEqual(await page.locator('#fcPanel').getAttribute('hidden'), null, 'mikrofon FullFin panelini açmamalı');
  await page.evaluate(() => { document.querySelectorAll('.ses-sheet.show, .sheet-backdrop.show').forEach(e => e.classList.remove('show')); });

  await openFullFin(page);
  assert.equal(await page.locator('#fcLauncher').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

// ---------------------------------------------------------------- Q, R: Ana Sayfa FullFin notu
test('Q: gerçek bir değişim varken Ana Sayfa notu tek cümle + "Sor" gösterir ve FullFin\'i açar', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 40000, assets: 150000 });
  // Geçen ayın GERÇEK kaydı (uygulamanın kendi history[] yapısı) — bu ay belirgin şekilde daha yüksek.
  await page.evaluate(() => {
    const [y, m] = monthKey.split('-').map(Number);
    const prev = new Date(y, m - 2, 1);
    const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    history.length = 0;
    history.push({ monthKey: prevKey, label: 'prev', income: 90000, expense: 20000, fixedExpense: 0, debtPayment: 0, totalDebt: 0, assets: 150000, netWorth: 150000, savingsRate: 0, categoryBreakdown: {} });
    render();
  });
  await page.waitForTimeout(150);

  const note = await page.evaluate(() => {
    const box = document.getElementById('fullfinNote');
    return {
      hidden: box.hidden,
      label: box.querySelector('.fullfin-note-label')?.textContent.trim(),
      text: box.querySelector('.fullfin-note-text')?.textContent.trim(),
      ask: box.querySelector('.fullfin-note-ask')?.textContent.trim(),
      sentences: (box.querySelector('.fullfin-note-text')?.textContent.trim().match(/[.!?]/g) || []).length,
    };
  });
  assert.equal(note.hidden, false, 'gerçek değişim varken not görünmeli');
  assert.equal(note.label, 'FullFin');
  assert.equal(note.text, 'Bu ay harcamaların geçen aya göre arttı.');
  assert.equal(note.sentences, 1, 'not tek cümle olmalı');
  assert.ok(/^Sor\s*→$/.test(note.ask.replace(/\s+/g, ' ').trim()), `"Sor →" beklenir: ${note.ask}`);

  await page.locator('#fullfinNoteAsk').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

test('R: geçen ay verisi yokken Ana Sayfa notu HİÇ gösterilmez (uydurma içgörü yok)', async () => {
  const { page } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 40000, assets: 150000 });
  await page.evaluate(() => { history.length = 0; render(); });
  await page.waitForTimeout(150);
  const state = await page.evaluate(() => {
    const b = document.getElementById('fullfinNote');
    return { hidden: b.hidden, html: b.innerHTML };
  });
  assert.equal(state.hidden, true, 'karşılaştırılacak gerçek veri yokken not gizli kalmalı');
  assert.equal(state.html, '');
  await page.close();
});

// ---------------------------------------------------------------- S, T: motor ve güvenlik dili
test('S/T: Decision Engine / GCAE sonuçları ve yatırım güvenliği dili değişmedi', async () => {
  const { page } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });
  const engine = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const gcae = runMonthlyGoalCashAllocationLive();
    return { available: de2.availableCash, protectedCash: de2.protectedCash, distributable: gcae.distributableCash };
  });
  // Panel açılıp kapanmak motor çıktısını DEĞİŞTİRMEMELİ (FullFin yalnızca okur).
  await openFullFin(page);
  await page.locator('#fcCloseBtn').click();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const gcae = runMonthlyGoalCashAllocationLive();
    return { available: de2.availableCash, protectedCash: de2.protectedCash, distributable: gcae.distributableCash };
  });
  assert.deepEqual(after, engine, 'FullFin yüzeyi finansal hesapları etkilememeli');

  // Çiplerin hiçbiri yatırım yönlendirmesi gibi görünmemeli (mevcut ilke).
  await openFullFin(page);
  const texts = await chips(page);
  const forbidden = /\bhisse\b|\bal\b|\bsat\b|dolara geç|yatırım yap|\bbuy\b|\bsell\b/i;
  for (const t of texts) assert.equal(forbidden.test(t), false, `çip yatırım tavsiyesi gibi görünmemeli: "${t}"`);
  await page.close();
});

// ---------------------------------------------------------------- U: mobil yerleşim
test('U: mobil sheet alt gezinme çubuğunun üstünde kalır, input ve gönder erişilebilir', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });
  await openFullFin(page);
  const box = await page.evaluate(() => {
    const p = document.getElementById('fcPanel').getBoundingClientRect();
    const i = document.getElementById('fcInput').getBoundingClientRect();
    const s = document.getElementById('fcSendBtn').getBoundingClientRect();
    const hit = document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2);
    return {
      inPage: p.top >= 0 && p.bottom <= innerHeight + 1 && p.left >= 0 && p.right <= innerWidth + 1,
      inputVisible: i.bottom <= innerHeight && i.top >= 0,
      sendVisible: s.bottom <= innerHeight && s.top >= 0,
      inputReachable: !!hit && (hit.id === 'fcInput' || hit.closest('#fcPanel') !== null),
      sendLabel: document.getElementById('fcSendBtn').getAttribute('aria-label'),
      closeLabel: document.getElementById('fcCloseBtn').getAttribute('aria-label'),
      inputLabel: document.getElementById('fcInput').getAttribute('aria-label'),
      dialog: document.getElementById('fcPanel').getAttribute('role'),
      modal: document.getElementById('fcPanel').getAttribute('aria-modal'),
    };
  });
  assert.equal(box.inPage, true, 'panel ekran içinde kalmalı');
  assert.equal(box.inputVisible, true);
  assert.equal(box.sendVisible, true);
  assert.equal(box.inputReachable, true, 'input başka bir katman tarafından örtülmemeli');
  assert.ok(box.sendLabel && box.closeLabel && box.inputLabel, 'erişilebilirlik etiketleri eksiksiz olmalı');
  assert.equal(box.dialog, 'dialog');
  assert.equal(box.modal, 'true');
  assert.deepEqual(consoleErrors, []);
  await page.close();
});

// ---------------------------------------------------------------- Home çipi: metin + routing
test('Home bağlamsal çipi "ne anlama geliyor?" metnini kullanır ve answerOverallStatus yoluna bağlanır', async () => {
  const { page } = await newPage(MOBILE);
  await page.evaluate(() => { FB_AI_CONFIG.backendUrl = ''; });   // mevcut şablon yolu
  await seed(page, { income: 90000, expenses: 24000, assets: 150000 });
  await page.evaluate(() => { setTab('home'); render(); });
  await openFullFin(page);

  const first = (await chips(page))[0];
  const expected = await page.evaluate(() => {
    const a = runMonthlyGoalCashAllocationLive().distributableCash;
    return `Bu ${CUR}${fmt(a)} ne anlama geliyor?`;
  });
  assert.equal(first, expected, 'Home çipi tutarın ANLAMINI sormalı');
  assert.equal(/nasıl kullanayım/i.test(first), false, 'eski "nasıl kullanayım" metni kalmamalı');

  // Çip ile cevap aynı şeyi sorar: answerOverallStatus() yolu çalışır, fallback dönmez.
  const direct = await page.evaluate((q) => ({ viaRouter: answerTemplateQuestion(q), viaAnswer: answerOverallStatus() }), expected);
  assert.equal(direct.viaRouter, direct.viaAnswer, 'çip metni answerOverallStatus() cevabına eşlenmeli');

  await page.locator('#fcMessages .fc-quick-btn').first().click();
  await page.waitForFunction(() => !aiRequestInFlight, null, { timeout: 15000 });
  const answer = (await page.locator('#fcMessages .fc-msg.assistant').first().textContent()).trim();
  assert.equal(/eşleyemedim|can't match/i.test(answer), false, `fallback cevabı dönmemeli: ${answer}`);
  assert.equal(answer, direct.viaAnswer, 'panelde görünen cevap answerOverallStatus() çıktısı olmalı');
  await page.close();
});

// ---------------------------------------------------------------- hedef çipi: KALAN TUTAR
test('hedef çipine basınca cevap ÖNCE kalan tutarı verir (yalnızca süre değil)', async () => {
  const { page } = await newPage(MOBILE);
  await page.evaluate(() => { FB_AI_CONFIG.backendUrl = ''; });   // mevcut şablon yolu
  const far = new Date(Date.now() + 500 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await seed(page, {
    income: 90000, expenses: 20000, assets: 150000,
    goals: [{ id: 'g1', typeKey: 'telefon', targetAmount: 40000, currentSaved: 10000, targetDate: far }],
  });
  await page.evaluate(() => { setTab('goals'); render(); });
  await openFullFin(page);

  const expected = await page.evaluate(() => {
    const { g, info } = pickPrimaryGoal();
    const pct = info.neededTotal > 0 ? Math.min(100, (info.alreadySaved / info.neededTotal) * 100) : 0;
    return {
      name: goalDisplayName(g),
      gap: `${CUR}${fmt(info.gap)}`,
      target: `${CUR}${fmt(info.neededTotal)}`,
      pct: `%${Math.round(pct)}`,
      months: isFinite(info.projectedMonths) ? info.projectedMonths : null,
    };
  });

  await page.locator('#fcMessages .fc-quick-btn').first().click();
  await page.waitForFunction(() => !aiRequestInFlight, null, { timeout: 15000 });
  const answer = (await page.locator('#fcMessages .fc-msg.assistant').first().textContent()).trim();

  const firstSentence = answer.split(/(?<=\.)\s/)[0];
  assert.ok(firstSentence.includes(expected.gap), `ilk cümle kalan tutarı içermeli (${expected.gap}): ${answer}`);
  assert.ok(firstSentence.includes(expected.target), `ilk cümle hedef tutarını içermeli (${expected.target}): ${answer}`);
  assert.ok(firstSentence.includes(expected.pct), `ilk cümle yüzdeyi içermeli (${expected.pct}): ${answer}`);
  assert.ok(firstSentence.includes(expected.name), `ilk cümle hedef adını içermeli: ${answer}`);
  // Süre İKİNCİL: varsa ilk cümlede değil, sonrasında geçer.
  assert.equal(/\bay\b/.test(firstSentence), false, `ilk cümle süre bilgisi vermemeli: ${firstSentence}`);
  if (expected.months != null) {
    assert.ok(answer.includes(`${expected.months} ay`), `süre ikinci bilgi olarak verilmeli: ${answer}`);
  }
  // Ve cevap fallback ("eşleyemedim") DEĞİL.
  assert.equal(/eşleyemedim|can't match/i.test(answer), false, `çip hazır bir cevaba bağlanmalı: ${answer}`);
  await page.close();
});

// ---------------------------------------------------------------- özet çipi: tek string + doğru cevap
test('"Durumumu özetle" çipi tek standart metindir ve gerçek özete bağlanır', async () => {
  const { page } = await newPage(MOBILE);
  await page.evaluate(() => { FB_AI_CONFIG.backendUrl = ''; });
  await seed(page, { income: 90000, expenses: 20000, assets: 150000 });
  await page.evaluate(() => { setTab('home'); render(); });
  await openFullFin(page);

  const texts = await chips(page);
  assert.ok(texts.includes('Durumumu özetle'), `özet çipi tam olarak "Durumumu özetle" olmalı: ${JSON.stringify(texts)}`);
  assert.equal(texts.some((x) => /finansal durumumu özetle/i.test(x)), false, '"Finansal durumumu özetle" kalmamalı');

  await page.locator('#fcMessages .fc-quick-btn', { hasText: 'Durumumu özetle' }).click();
  await page.waitForFunction(() => !aiRequestInFlight, null, { timeout: 15000 });
  const answer = (await page.locator('#fcMessages .fc-msg.assistant').first().textContent()).trim();
  assert.equal(/eşleyemedim|can't match/i.test(answer), false, `özet çipi hazır cevaba bağlanmalı: ${answer}`);
  const expectedIncome = await page.evaluate(() => `${CUR}${fmt(totalIncome())}`);
  assert.ok(answer.includes(expectedIncome), `özet gerçek veriden gelmeli (${expectedIncome}): ${answer}`);
  await page.close();
});

// ---------------------------------------------------------------- kaynak taraması: sızmış sahte tutar yok
test('üretim kaynağında FullFin bloklarına sızmış sabit (hard-code) tutar yok', async () => {
  const src = readFileSync(path.join(appDir, 'app', 'index.html'), 'utf8');
  const start = src.indexOf('function resolveFullFinContext');
  const end = src.indexOf('function renderFullFinNote');
  assert.ok(start > 0 && end > start, 'FullFin bağlam bloğu kaynakta bulunmalı');
  // Yorum satırları hariç GERÇEK kod: örnek tutarlar yalnızca açıklamada olabilir, kodda olamaz.
  const code = src.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.equal(/₺\s*[0-9]/.test(code), false, 'kodda sabit bir ₺ tutarı olmamalı');
  assert.equal(/[0-9]{2}[.,][0-9]{3}/.test(code), false, 'kodda binlik ayraçlı sabit tutar olmamalı');
  // Tutar DAİMA canlı motordan okunur.
  assert.ok(code.includes('runMonthlyGoalCashAllocationLive()'), 'home bağlamı canlı GCAE sonucundan okumalı');
  assert.ok(code.includes('distributableCash'), 'home bağlamı canonical planlanabilir tutarı kullanmalı');
  // Çip metni tutarı şablonla üretir, sabit yazmaz.
  assert.ok(/Bu \$\{money\(amount\)\}/.test(code), 'çip metni tutarı şablondan almalı');
});

// ---------------------------------------------------------------- pulse: neon nabız (yalnızca görsel)
test('pulse etrafındaki neon nabız CSS ile çalışır, tıklamayı engellemez ve reduced-motion\'da durur', async () => {
  const { page, consoleErrors } = await newPage(MOBILE);
  const css = await page.evaluate(() => {
    const st = getComputedStyle(document.getElementById('fcLauncher'), '::after');
    return { name: st.animationName, events: st.pointerEvents, shadow: st.boxShadow };
  });
  assert.equal(css.name, 'fcHeartbeat', 'nabız animasyonu CSS keyframes ile tanımlı olmalı');
  assert.equal(css.events, 'none', 'efekt katmanı tıklamayı yakalamamalı');
  assert.ok(/rgba?\(/.test(css.shadow), 'hafif bir mint hâle olmalı');
  // İkonun kendisi ve tıklama davranışı değişmedi.
  await openFullFin(page);
  assert.equal(await page.locator('#fcLauncher').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#fcLauncher').getAttribute('aria-label'), "FullFin'i aç");
  assert.deepEqual(consoleErrors, []);
  await page.close();

  const reduced = await browser.newPage({ viewport: MOBILE, reducedMotion: 'reduce' });
  await reduced.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await reduced.waitForTimeout(400);
  const off = await reduced.evaluate(() => getComputedStyle(document.getElementById('fcLauncher'), '::after').animationName);
  assert.equal(off, 'none', 'prefers-reduced-motion altında nabız durmalı');
  await reduced.close();
});
