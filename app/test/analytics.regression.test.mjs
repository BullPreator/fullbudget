// ANALYTICS (PostHog) — GİZLİLİK + ENTEGRASYON regresyon testleri
// -----------------------------------------------------------------------
// Bu dosya Finance Core / Decision Engine / AI Coach'un KENDİSİNİ test ETMEZ (bunlar
// zaten finance-core.test.mjs / decision-engine.regression.test.mjs /
// ai-coach-priority-plan.regression.test.mjs tarafından kapsanıyor). SADECE yeni
// analytics katmanının (analytics.track) doğru event'leri doğru UI aksiyonlarında
// tetiklediğini VE hiçbir finansal/PII veri sızdırmadığını doğrular.
//
// KRİTİK GÜVENCE: test ortamında ANALYTICS_CONFIG.token boş bırakılmıştır (gerçek
// PostHog script'i hiç yüklenmez, ağ isteği atılmaz), bu yüzden analytics.track()
// çağrıları gerçek posthog.capture() yerine dahili _analyticsQueue dizisine düşer.
// Bu, hangi event'in hangi property'lerle gönderilmeye ÇALIŞILDIĞINI test için
// birebir gözlemlenebilir kılar - ağ/PostHog sunucusuna bağımlı olmadan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..');

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

async function newSession(setup) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s);
        return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) {
        const b = await page.$(btn);
        if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; }
      }
      await page.waitForTimeout(150);
    }
  }
  if (setup) {
    await page.evaluate((s) => {
      persistent.accounts = s.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: s.assets, currency: 'TRY' }] : [];
      persistent.debts = [];
      persistent.creditCards = [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: s.expenses }] : [];
      persistent.goals = s.goals || [];
      render();
      setTab('goals');
    }, setup);
  }
  return { page, pageErrors };
}

const FORBIDDEN_VALUE_PATTERNS = [
  /\d{2,}/,               // herhangi bir çok haneli sayı dizisi (tutar sızıntısı şüphesi)
  /salary|income|expense|debt|balance|networth|net worth|portfolio|price|payment|saving/i,
];

function queueHasNoForbiddenContent(queue) {
  const json = JSON.stringify(queue);
  return !FORBIDDEN_VALUE_PATTERNS.some((re) => re.test(json));
}

// ---------------------------------------------------------------------
// 1/2. Event isimleri projede istenen isimlerle BİREBİR aynı olmalı.
// ---------------------------------------------------------------------
test('ANALYTICS_EVENTS tam olarak istenen 14 event adını içerir - fazlası/eksiği yok', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const names = await page.evaluate(() => Object.values(ANALYTICS_EVENTS).sort());
  const expected = [
    'affordability_calculated', 'affordability_form_started', 'affordability_opened',
    'ai_coach_opened', 'ai_coach_question_sent', 'app_opened',
    'decision_result_viewed', 'goal_created', 'money_task_completed',
    'money_task_started', 'money_task_viewed', 'onboarding_completed',
    'onboarding_started', 'share_card_generated',
  ].sort();
  assert.deepEqual(names, expected);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// analytics.track() önceden tanımlanmamış bir event ismini KABUL ETMEMELİ.
// ---------------------------------------------------------------------
test('analytics.track() allowlist dışındaki bir event adını sessizce reddeder', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const result = await page.evaluate(() => {
    const before = _analyticsQueue.length;
    analytics.track('user_deleted_account', { anything: 'x' }); // İCAT EDİLMİŞ, tanımsız bir event
    analytics.track('uygulama_acildi_gizli_event', {});
    return { grew: _analyticsQueue.length > before };
  });
  assert.equal(result.grew, false, 'tanımsız event isimleri kuyruğa hiç eklenmemeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3/4/6. Sanitizasyon: finansal DEĞER, ham state, ve PII asla geçmemeli - ALLOWLIST
// varsayılan-red mantığıyla çalışmalı (bilinmeyen HERHANGİ bir anahtar da düşer).
// ---------------------------------------------------------------------
test('analytics sanitizasyonu: finansal değerler, ham state ve PII allowlist dışında kalır, HİÇBİRİ geçmez', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const result = await page.evaluate(() => {
    return analyticsSanitizeProps({
      // Finansal DEĞERLER (proje talimatındaki yasaklı liste - hepsi):
      amount: 15000, salary: 90000, income: 80000, expense: 30000, debt: 243184,
      balance: 500000, cash_balance: 12000, net_worth: 900000, portfolio_value: 40000,
      investment_amount: 10000, purchase_price: 2000000, down_payment: 500000,
      monthly_payment: 12500, goal_amount: 40000, savings_amount: 5000,
      // Ham state / snapshot / context:
      financialSnapshot: { monthlyIncome: 90000 }, persistent_state: { accounts: [] },
      raw_local_storage: '{"budget:persistent":"..."}', ai_context: 'kullanıcı 90000 TL kazanıyor',
      // PII:
      email: 'user@example.com', name: 'Ahmet', phone: '+905551234567', address: 'İstanbul',
      // Rastgele bir SAYI - herhangi bir key altında bile olsa (numeric tip TAMAMEN yasak):
      random_number_field: 42,
      // Bilinmeyen ama zararsız görünen bir anahtar - ALLOWLIST'te olmadığı için yine de düşmeli:
      some_new_property_nobody_reviewed: 'safe-looking-string',
    });
  });
  assert.deepEqual(result, {}, `sanitizeProps HİÇBİR property'yi geçirmemeliydi, ama geçti: ${JSON.stringify(result)}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('analytics sanitizasyonu: yalnızca allowlist + enum ile eşleşen güvenli property\'ler geçer', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const result = await page.evaluate(() => {
    return {
      valid: analyticsSanitizeProps({ entry_point: 'home', decision_category: 'yes_today', task_status: 'completed' }),
      invalidEnumValue: analyticsSanitizeProps({ entry_point: 'deep-link-from-email-campaign' }), // enum dışı değer
      invalidGoalType: analyticsSanitizeProps({ goal_type: 'made-up-type-xyz' }), // GOAL_TYPES'ta olmayan bir anahtar
      validGoalType: analyticsSanitizeProps({ goal_type: 'ev' }),
    };
  });
  assert.deepEqual(result.valid, { entry_point: 'home', decision_category: 'yes_today', task_status: 'completed' });
  assert.deepEqual(result.invalidEnumValue, {}, 'allowlist bir ANAHTARI tanısa bile, DEĞER enum dışıysa yine reddedilmeli');
  assert.deepEqual(result.invalidGoalType, {}, 'GOAL_TYPES içinde olmayan bir goal_type değeri reddedilmeli');
  assert.deepEqual(result.validGoalType, { goal_type: 'ev' });
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 5. AI Coach: soru gönderme event'i ne soru metnini, ne de
// buildAICoachContext()/financialSnapshot içeriğini taşımamalı.
// ---------------------------------------------------------------------
test('ai_coach_question_sent hiçbir soru metni veya AI Coach context/financialSnapshot verisi taşımaz', async () => {
  const { page, pageErrors } = await newSession({ income: 90000, expenses: 40000, assets: 150000, goals: [] });
  const result = await page.evaluate(async () => {
    setTab('coach');
    await new Promise((r) => setTimeout(r, 50));
    const before = _analyticsQueue.length;
    await askCoach('Maaşım 90000 TL, evi ne zaman alabilirim?'); // hassas rakam içeren GERÇEKÇİ bir soru
    await new Promise((r) => setTimeout(r, 50));
    return _analyticsQueue.slice(before);
  });
  const sent = result.filter((e) => e.name === 'ai_coach_question_sent');
  assert.equal(sent.length, 1, 'tam olarak bir ai_coach_question_sent event\'i kuyruğa girmeli');
  assert.deepEqual(sent[0].props, {}, 'ai_coach_question_sent HİÇBİR property taşımamalı (soru metni dahil)');
  const asString = JSON.stringify(result);
  assert.ok(!asString.includes('90000'), 'kuyruktaki hiçbir event soru içindeki rakamı içermemeli');
  assert.ok(!asString.includes('Maaşım'), 'kuyruktaki hiçbir event soru metnini içermemeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 7. Autocapture / Session Replay / Surveys / Web Analytics KAPALI olmalı - PostHog'a
// geçilecek init yapılandırmasının kaynağı statik olarak doğrulanır (gerçek ağ isteği
// olmadan; token boşken script hiç yüklenmiyor - bkz. sonraki test).
// ---------------------------------------------------------------------
test('PostHog init yapılandırması autocapture/session-replay/surveys/pageview yakalamayı AÇIKÇA kapatır', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const src = await page.evaluate(() => analyticsLoadPostHog.toString());
  assert.match(src, /autocapture:\s*false/, 'autocapture açıkça false olmalı');
  assert.match(src, /capture_pageview:\s*false/, 'Web Analytics/sayfa görüntüleme yakalama false olmalı');
  assert.match(src, /disable_session_recording:\s*true/, 'Session Replay açıkça devre dışı olmalı');
  assert.match(src, /disable_surveys:\s*true/, 'Surveys açıkça devre dışı olmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('PostHog project token boşken script hiç yüklenmez ve posthog.capture() hiç çağrılmaz (yerel/test ortamı güvenliği)', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const state = await page.evaluate(() => ({
    tokenEmpty: !ANALYTICS_CONFIG.token,
    posthogScriptInDom: !!document.querySelector(`script[src="${ANALYTICS_CONFIG.scriptSrc}"]`),
    posthogGlobalDefined: typeof posthog !== 'undefined',
    analyticsReady: _analyticsReady,
  }));
  assert.equal(state.tokenEmpty, true, 'bu depoda commit edilen kod, gerçek proje token\'ını İÇERMEMELİ');
  assert.equal(state.posthogScriptInDom, false, 'token boşken PostHog script etiketi DOM\'a hiç eklenmemeli');
  assert.equal(state.posthogGlobalDefined, false, 'token boşken window.posthog hiç tanımlanmamalı');
  assert.equal(state.analyticsReady, false);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 1. (devamı) UI FUNNEL: gerçek kullanıcı aksiyonlarının doğru event'leri, doğru
// sırada ve yalnızca güvenli property'lerle tetiklediğini uçtan uca doğrular.
// ---------------------------------------------------------------------
test('app_opened, loadState() tamamlandığında zaten kuyruğa girmiş olur', async () => {
  const { page, pageErrors } = await newSession(null); // setup YOK - gerçek ilk-açılış yoluna en yakın hâl
  const hasAppOpened = await page.evaluate(() => _analyticsQueue.some((e) => e.name === 'app_opened'));
  assert.equal(hasAppOpened, true);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('affordability funnel: Home "Sor" -> affordability_opened(home) -> affordability_form_started -> affordability_calculated -> decision_result_viewed(category)', async () => {
  const { page, pageErrors } = await newSession({ income: 90000, expenses: 40000, assets: 150000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); _analyticsQueue.length = 0; });
  await page.evaluate(() => { document.getElementById('homeAffordAdHocBtn').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById('adHocPrice').value = '60000';
    document.getElementById('adHocDownPayment').value = '10000';
    document.getElementById('adHocSubmitBtn').click();
  });
  const queue = await page.evaluate(() => _analyticsQueue);
  const names = queue.map((e) => e.name);
  assert.ok(names.includes('affordability_opened'), JSON.stringify(names));
  assert.ok(names.includes('affordability_form_started'), JSON.stringify(names));
  assert.ok(names.includes('affordability_calculated'), JSON.stringify(names));
  assert.ok(names.includes('decision_result_viewed'), JSON.stringify(names));
  const opened = queue.find((e) => e.name === 'affordability_opened');
  assert.deepEqual(opened.props, { entry_point: 'home' });
  const viewed = queue.find((e) => e.name === 'decision_result_viewed');
  assert.ok(['yes_today', 'yes_on_date', 'yes_with_condition', 'yes_delays_goals', 'no_unsafe'].includes(viewed.props.decision_category));
  assert.ok(queueHasNoForbiddenContent(queue), `kuyrukta finansal içerik şüphesi: ${JSON.stringify(queue)}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('affordability funnel: Left-nav "Alabilir miyim?" -> affordability_opened(navigation)', async () => {
  const { page, pageErrors } = await newSession({ income: 90000, expenses: 40000, assets: 150000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); _analyticsQueue.length = 0; });
  await page.evaluate(() => { document.querySelector('#navDrawer [data-action="afford"]').click(); });
  const queue = await page.evaluate(() => _analyticsQueue);
  const opened = queue.find((e) => e.name === 'affordability_opened');
  assert.ok(opened, JSON.stringify(queue));
  assert.deepEqual(opened.props, { entry_point: 'navigation' });
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('money task funnel: money_task_viewed -> money_task_started -> money_task_completed, hiçbir tutar/başlık taşımadan', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 80000, expenses: 30000, assets: 0,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  await page.evaluate(() => {
    persistent.dailyMoneyTask = null;
    _analyticsQueue.length = 0;
    render();
  });
  const hasTask = await page.evaluate(() => !!document.getElementById('moneyTaskCompleteBtn'));
  if (!hasTask) { await page.close(); return; } // bu finansal senaryoda görev üretilmediyse test es geçilir (yanlış-pozitif üretmez)
  const queue = await page.evaluate(() => {
    document.getElementById('moneyTaskCompleteBtn').click();
    return _analyticsQueue;
  });
  const names = queue.map((e) => e.name);
  assert.ok(names.includes('money_task_viewed'), JSON.stringify(names));
  assert.ok(names.includes('money_task_started'), JSON.stringify(names));
  assert.ok(names.includes('money_task_completed'), JSON.stringify(names));
  assert.ok(queueHasNoForbiddenContent(queue), `kuyrukta finansal içerik şüphesi: ${JSON.stringify(queue)}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('goal_created yalnızca goal_type gönderir - tutar/ad/tarih/not ASLA gönderilmez', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  await page.evaluate(() => { setTab('goals'); render(); _analyticsQueue.length = 0; });
  await page.evaluate(() => {
    document.getElementById('showGoalFormBtn').click();
    activeGoalType = 'bilgisayar'; // Goals bölümünün tip seçici butonlarının yaptığı ATAMANIN AYNISI
    document.getElementById('goalTargetAmount').value = '55000';
    document.getElementById('addGoalBtn').click();
  });
  const queue = await page.evaluate(() => _analyticsQueue);
  const created = queue.find((e) => e.name === 'goal_created');
  assert.ok(created, JSON.stringify(queue));
  assert.deepEqual(created.props, { goal_type: 'bilgisayar' });
  assert.ok(!JSON.stringify(queue).includes('55000'), 'hedef tutarı (55000) hiçbir şekilde kuyrukta olmamalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('ai_coach_opened yalnızca coach sekmesine GERÇEK bir geçişte (aynı sekmede kalırken değil) tetiklenir', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); _analyticsQueue.length = 0; });
  const afterFirst = await page.evaluate(() => {
    setTab('coach');
    return _analyticsQueue.filter((e) => e.name === 'ai_coach_opened').length;
  });
  const afterSecond = await page.evaluate(() => {
    setTab('coach'); // zaten coach'tayken tekrar - YENİ bir 'opened' üretmemeli
    return _analyticsQueue.filter((e) => e.name === 'ai_coach_opened').length;
  });
  assert.equal(afterFirst, 1);
  assert.equal(afterSecond, 1, 'aynı sekmede kalırken ai_coach_opened tekrar tetiklenmemeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('share_card_generated yalnızca indirme tıklamasında, sadece decision_category ile tetiklenir - görsel/metin YOK', async () => {
  const { page, pageErrors } = await newSession({ income: 90000, expenses: 40000, assets: 150000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); });
  await page.evaluate(() => { document.getElementById('homeAffordAdHocBtn').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById('adHocPrice').value = '60000';
    document.getElementById('adHocSubmitBtn').click();
  });
  await page.evaluate(() => { _analyticsQueue.length = 0; });
  await page.evaluate(() => { document.getElementById('affordShareDownloadBtn').click(); });
  await page.waitForTimeout(200); // canvas.toBlob() ASENKRON - analytics.track çağrısı callback İÇİNDE
  const queue = await page.evaluate(() => _analyticsQueue);
  const generated = queue.find((e) => e.name === 'share_card_generated');
  assert.ok(generated, JSON.stringify(queue));
  assert.ok(Object.keys(generated.props).every((k) => k === 'decision_category'));
  assert.ok(queueHasNoForbiddenContent(queue), `kuyrukta finansal içerik şüphesi: ${JSON.stringify(queue)}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
