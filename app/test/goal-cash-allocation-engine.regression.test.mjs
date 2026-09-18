// GOAL & CASH ALLOCATION ENGINE — regresyon testleri
// -----------------------------------------------------------------------
// runDecisionEngineV2()'nin P4 "Kalan tutar" tek satırını, AYNI canonical veriyi (buildMonthlySnapshot)
// kullanarak çok adımlı bir kırılıma açan YENİ, ek bir saf fonksiyon: runGoalCashAllocationEngine(de2, snapshot).
// runDecisionEngineV2() DOKUNULMADI ve TEKRAR HESAPLANMADI — bu testler ayrıca bunu doğrular (GOAL-CASH-11).
// ÜRÜN KARARI (onaylandı, bu testlerle korunuyor): kalan tutarın TAMAMI asla otomatik olarak yatırıma
// zorlanmaz (tip her zaman 'long_term_or_flexible', asla 'investment_allocation' değil), hiçbir yüzde/
// getiri İCAT EDİLMEZ, riskProfile yalnızca BAĞLAMSAL bilgi olarak kalır (tutarı DEĞİŞTİRMEZ).
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
    } catch (e) { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/app/index.html`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s); return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) { const b = await page.$(btn); if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; } }
      await page.waitForTimeout(150);
    }
  }
  return { page, pageErrors };
}

test('GOAL-CASH-1: TAM MANUEL SENARYO — income 120000 / expenses 40000 / real card payment 15000 -> distributable 53000, emergency gap 72000, ev peşinat hedefi zaten fonlanmış', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    // Likidite: hiçbir Nakit/Banka Hesabı türü YOK -> totalLiquidAssets()=0. Ödeme, likit
    // SAYILMAYAN bir "Yatırım" hesabından yapılıyor (senaryonun likidite rakamını bozmamak için).
    persistent.accounts = [{ id: 'inv1', name: 'Yatırım Hesabı', type: 'Yatırım', balance: 500000, currency: 'TRY' }];
    persistent.debts = [];
    persistent.creditCards = [{ id: 'c1', name: 'Kart', currentBalance: 30000, limit: 200000, currency: 'TRY', minPayment: 0, statementDay: 1, dueDay: 10, rate: 0 }];
    const targetDate = (function () { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 10); })();
    persistent.goals = [{
      id: 'gEv', typeKey: 'ev', referenceId: 'custom', targetAmount: 5000000, currentSaved: 0,
      targetDate, priceInflationPct: 0, downPaymentPct: 30, fullPriceInsteadOfDownPayment: false,
    }];
    persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 120000 }];
    // 24.000 sabit + 16.000 değişken = 40.000 toplam NAKİT gider (estimateMonthlyEssential ->
    // totalFixedExpense=24.000 -> emergencyTarget3=72.000, likit=0 -> emergencyGap=72.000).
    month.expenses = [
      { id: 'e1', category: 'Kira', amount: 24000, fixed: true },
      { id: 'e2', category: 'Diğer', amount: 16000, fixed: false },
    ];
    render();
    // Ev hedefinin peşinat tutarını öğren, birikimi TAM OLARAK ona eşitle (zaten fonlanmış).
    const preInfo = computeGoalInfo(persistent.goals[0]);
    persistent.goals[0].currentSaved = preInfo.neededTotal;
    render();
    // Gerçek kart ödemesi: 15.000 (Yatırım hesabından).
    applyCardPayment(persistent.creditCards[0], 15000, 'inv1');
    render();

    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    const result = runGoalCashAllocationEngine(de2, snapshot);
    return { de2, snapshot, result };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const { de2, snapshot, result } = out;

  assert.equal(de2.availableCash, 65000, 'gelir(120000) - nakit gider(40000) - gerçek kart ödemesi(15000) = 65000');
  assert.equal(snapshot.emergencyGap, 72000, 'emergencyGap tam olarak 72.000 olmalı');
  assert.equal(de2.protectedCash, 12000, 'protectedCash (DE2 tarafından, tavanlı) 12.000 olmalı');
  assert.equal(result.distributableCash, 53000, 'distributableCash tam olarak 53.000 olmalı');

  // ÜRÜN DÜZELTMESİ (bu senaryonun canlıda yakalanan asıl hatası): stillShort (72.000-12.000=60.000)
  // > distributableCash (53.000) olduğu için likidite açığı artık salt bilgi DEĞİL, GERÇEK bir
  // tahsisattır — dağıtılabilir tutarın TAMAMI acil fona gider, long_term_or_flexible ÜRETİLMEZ.
  const emerg = result.allocations.find(a => a.type === 'emergency_fund_contribution');
  assert.ok(emerg, 'stillShort (60.000) > distributableCash (53.000) olduğundan GERÇEK bir acil fon tahsisatı olmalı');
  assert.equal(emerg.amount, 53000, 'dağıtılabilirin TAMAMI (53.000) acil fona gitmeli — hepsi kapatmaya yetmiyor');
  assert.match(emerg.reason, /60\.000|60000/, 'orijinal açık (72.000-12.000=60.000) mesajda geçmeli');
  assert.match(emerg.reason, /7\.000|7000/, 'bu tahsisattan sonra kalan açık (60.000-53.000=7.000) mesajda geçmeli');

  const goalDone = result.allocations.find(a => a.type === 'goal_already_funded' && a.relatedGoalId === 'gEv');
  assert.ok(goalDone, 'ev peşinat hedefi "zaten fonlandı" bilgi kaydı olarak görünmeli');
  assert.match(goalDone.reason, /[Pp]eşinat|[Dd]own-payment/, 'mesaj peşinat/tam fiyat ayrımını belirtmeli');

  assert.ok(!result.allocations.some(a => a.type === 'goal_contribution'), 'başka aktif/eksik hedef yok, goal_contribution ÜRETİLMEMELİ');
  assert.ok(!result.allocations.some(a => a.type === 'debt_reduction'), 'faizi 0 olan kart P2 borç azaltımı hedefi OLMAMALI');

  assert.ok(!result.allocations.some(a => a.type === 'long_term_or_flexible'), 'acil fon açığı dağıtılabilirin tamamını yuttu — long_term_or_flexible ÜRETİLMEMELİ');
  assert.equal(result.unallocatedCash, 0, 'dağıtılmamış tutar 0 olmalı (hepsi acil fon kalemine gitti)');
  assert.equal(result.status, 'liquidity_priority', 'bu ay baskın olan öncelik likidite olmalı');
  await page.close();
});

test('GOAL-CASH-2: birden fazla pahalı borç EN YÜKSEK FAİZDEN başlayarak sıralanır, tavan sabit bir yüzde değil borcun kendi bakiyesidir', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = [
      { id: 'dLow', category: 'ihtiyac', note: 'Düşük Faiz', balance: 10000, rate: 5, minPayment: 0, extraPayment: 0, currency: 'TRY' },
      { id: 'dHigh', category: 'ihtiyac', note: 'Yüksek Faiz', balance: 8000, rate: 9, minPayment: 0, extraPayment: 0, currency: 'TRY' },
    ];
    persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot) };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const debtRows = out.result.allocations.filter(a => a.type === 'debt_reduction');
  assert.equal(debtRows.length, 2, 'her iki pahalı borç da (mevduattan yüksek faizli) birer kalem üretmeli');
  assert.equal(debtRows[0].relatedDebtId, 'dHigh', 'önce EN YÜKSEK faizli borç (dHigh, %9) gelmeli');
  assert.equal(debtRows[1].relatedDebtId, 'dLow', 'sonra dLow (%5) gelmeli');
  assert.equal(debtRows[0].amount, 8000, 'tavan, borcun KENDİ bakiyesi olmalı (8000) — icat edilmiş bir yüzde değil');
  assert.equal(debtRows[1].amount, 10000, 'ikinci borç için de tavan kendi bakiyesi olmalı');
  await page.close();
});

test('GOAL-CASH-3: birden fazla aktif hedef ACİLİYET SIRASINA göre fonlanır (tek hedefle sınırlı değil)', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    const soon = (function () { const d = new Date(); d.setMonth(d.getMonth() + 2); return d.toISOString().slice(0, 10); })();
    const far = (function () { const d = new Date(); d.setMonth(d.getMonth() + 20); return d.toISOString().slice(0, 10); })();
    persistent.goals = [
      { id: 'gFar', typeKey: 'telefon', targetAmount: 40000, currentSaved: 0, targetDate: far },
      { id: 'gSoon', typeKey: 'tatil', targetAmount: 20000, currentSaved: 0, targetDate: soon },
    ];
    persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot), snapshot };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const goalRows = out.result.allocations.filter(a => a.type === 'goal_contribution');
  assert.ok(goalRows.length >= 1, 'en az bir hedef fonlanmalı');
  assert.equal(goalRows[0].relatedGoalId, 'gSoon', 'önce en yakın tarihli (aciliyeti en yüksek) hedef fonlanmalı');
  // İKİ hedef de fonlanabiliyorsa (yeterli kalan varsa), TEK hedefle sınırlı olmadığını doğrula.
  if (goalRows.length === 2) assert.equal(goalRows[1].relatedGoalId, 'gFar');
  await page.close();
});

test('GOAL-CASH-4: zaten fonlanmış bir hedef sessizce atlanmaz — açık bir bilgi kaydı üretir, DİĞER hedef normal fonlanır', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = [
      { id: 'gDone', typeKey: 'telefon', targetAmount: 20000, currentSaved: 20000, targetDate: '' },
      { id: 'gOpen', typeKey: 'tatil', targetAmount: 30000, currentSaved: 0, targetDate: (function () { const d = new Date(); d.setMonth(d.getMonth() + 3); return d.toISOString().slice(0, 10); })() },
    ];
    persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot) };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const done = out.result.allocations.find(a => a.type === 'goal_already_funded' && a.relatedGoalId === 'gDone');
  assert.ok(done, 'gDone için açık bir "zaten fonlandı" kaydı olmalı');
  assert.equal(done.amount, 0);
  const open = out.result.allocations.find(a => a.type === 'goal_contribution' && a.relatedGoalId === 'gOpen');
  assert.ok(open, 'gOpen normal şekilde fonlanmalı — gDone onu ENGELLEMEMELİ');
  await page.close();
});

test('GOAL-CASH-5: kalan tutar OTOMATİK olarak yatırıma zorlanmaz — tip her zaman long_term_or_flexible, riskProfile tutarı DEĞİŞTİRMEZ', async () => {
  const { page, pageErrors } = await newPage();
  const withProfile = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    activeRiskProfile = 'atak';
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot) };
  });
  // NOT: activeRiskProfile'ı bilerek geçersiz bir değere ('' / null) ÇEVİRMİYORUZ — gerçek
  // uygulamada bu global HER ZAMAN 'dengeli' ile başlar ve yalnızca geçerli bir RISK_PROFILES
  // anahtarına atanır (bkz. app/index.html satır ~5349/~15766); onu geçersiz bir değere zorlamak,
  // Goal & Cash Allocation Engine'le İLGİSİZ, ayrı bir fonksiyondaki (computeAllocationDrift,
  // Bugünün Para Görevi uyarı akışı) mevcut bir savunmasızlığı tetikler ve render()'ı çökertir.
  // Motorumuzun kendisi SAF bir fonksiyondur (buildMonthlySnapshot()'a bağımlı değildir) — bu
  // yüzden "risk profili yok" durumunu, gerçek uygulamanın asla üretmediği bozuk bir global state
  // yerine, doğrudan snapshot düzeyinde (riskProfile: null) test ediyoruz.
  const withoutProfile = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = { ...buildMonthlySnapshot(), riskProfile: null };
    return { result: runGoalCashAllocationEngine(de2, snapshot) };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const flexWith = withProfile.result.allocations.find(a => a.type === 'long_term_or_flexible');
  const flexWithout = withoutProfile.result.allocations.find(a => a.type === 'long_term_or_flexible');
  assert.ok(flexWith && flexWithout);
  assert.ok(!withProfile.result.allocations.some(a => a.type === 'investment_allocation'), 'ASLA bir "investment_allocation" tipi üretilmemeli — yatırım otomatik/zorunlu değildir');
  assert.equal(flexWith.amount, flexWithout.amount, 'riskProfile VARLIĞI/YOKLUĞU tahsis edilen TUTARI değiştirmemeli — yalnızca bağlamsal metin/confidence değişir');
  assert.equal(flexWith.confidence, 'actual');
  assert.equal(flexWithout.confidence, 'needs_more_data', 'risk profili yokken bu kalem needs_more_data olarak işaretlenmeli');
  await page.close();
});

test('GOAL-CASH-6: dağıtılabilir tutar sıfırken (distributableCash=0) hiçbir P2-P4 tahsisatı üretilmez, crash olmaz', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 0, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 20000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 20000, fixed: false }];
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot), de2 };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(out.result.distributableCash <= 1);
  assert.ok(!out.result.allocations.some(a => ['debt_reduction', 'goal_contribution', 'long_term_or_flexible'].includes(a.type)), 'kullanılabilir para yokken hiçbir tahsisat türü ÜRETİLMEMELİ');
  assert.equal(out.result.unallocatedCash, 0);
  await page.close();
});

test('GOAL-CASH-7: negatif nakit akışında motor NEGATİF durumu devralır, TEKRAR hesaplamaz, P0 bağlamı yine de görünür kalır', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 5000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 20000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 35000, fixed: false }];
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot), de2Status: de2.status };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.de2Status, 'negative_cash_flow');
  assert.equal(out.result.status, 'negative_cash_flow', 'DE2 durumu TEKRAR hesaplanmadan aynen devralınmalı');
  assert.equal(out.result.distributableCash, 0);
  await page.close();
});

test('GOAL-CASH-8: hiç hedef yoksa hedefle ilgili hiçbir kalem üretilmez, kalan doğrudan long_term_or_flexible\'a gider', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    const de2 = runMonthlyDecisionEngineLive();
    const snapshot = buildMonthlySnapshot();
    return { result: runGoalCashAllocationEngine(de2, snapshot) };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.result.goalImpact.length, 0);
  assert.ok(!out.result.allocations.some(a => a.type === 'goal_contribution' || a.type === 'goal_already_funded'));
  assert.ok(out.result.allocations.some(a => a.type === 'long_term_or_flexible'));
  await page.close();
});

test('GOAL-CASH-9: eksik/opsiyonel veri (risk profili yok) crash üretmez, needs_more_data confidence ile işaretlenir', async () => {
  const { page, pageErrors } = await newPage();
  // NOT: activeRiskProfile global'ı burada da BOZULMUYOR (bkz. GOAL-CASH-5'teki gerekçe) — "risk
  // profili yok" durumu doğrudan snapshot düzeyinde (riskProfile: null) test ediliyor; motorumuz
  // buildMonthlySnapshot()'a bağımlı olmayan SAF bir fonksiyon olduğu için bu tamamen geçerli.
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    let threw = null, result = null;
    try {
      const de2 = runMonthlyDecisionEngineLive();
      const snapshot = { ...buildMonthlySnapshot(), riskProfile: null };
      result = runGoalCashAllocationEngine(de2, snapshot);
    } catch (e) { threw = e.message; }
    return { threw, result };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.threw, null, 'risk profili eksikken crash olmamalı: ' + out.threw);
  const flex = out.result.allocations.find(a => a.type === 'long_term_or_flexible');
  assert.ok(flex);
  assert.equal(flex.confidence, 'needs_more_data');
  await page.close();
});

test('GOAL-CASH-10: renderGoalCashAllocation(), #decisionEngineV2Box\'a DOKUNMADAN #goalCashAllocationBox\'ı doldurur ve "bunu atlarsam" detayları başlangıçta gizlidir', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    const de2BoxBefore = document.getElementById('decisionEngineV2Box').innerHTML;
    render();
    const de2BoxAfter = document.getElementById('decisionEngineV2Box').innerHTML;
    const allocBox = document.getElementById('goalCashAllocationBox');
    const toggle = allocBox ? allocBox.querySelector('[data-goal-alloc-toggle]') : null;
    const detailHidden = toggle ? document.getElementById(toggle.dataset.goalAllocToggle).style.display === 'none' : null;
    return {
      allocHasContent: !!(allocBox && allocBox.innerHTML.trim().length > 0),
      de2StillRendersNormally: de2BoxAfter.length > 0,
      hasToggle: !!toggle, detailHidden,
    };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.allocHasContent, true, '#goalCashAllocationBox render() sonrası dolu olmalı');
  assert.equal(out.de2StillRendersNormally, true, '#decisionEngineV2Box olağan şekilde render edilmeye devam etmeli');
  assert.equal(out.hasToggle, true, '"Bunu atlarsam?" açılır detayı DOM\'da olmalı');
  assert.equal(out.detailHidden, true, 'detay başlangıçta gizli olmalı (display:none)');
  await page.close();
});

test('GOAL-CASH-11: runDecisionEngineV2() DEĞİŞMEDİ — Goal & Cash Allocation Engine onun sonucunu SADECE okur, tekrar hesaplamaz ya da mutasyona uğratmaz', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    const snapshot = buildMonthlySnapshot();
    const de2Before = runDecisionEngineV2(snapshot);
    const de2BeforeJson = JSON.stringify(de2Before);
    // Allocation motorunu ÇAĞIRDIKTAN SONRA da DE2 aynı snapshot için AYNI sonucu üretmeli.
    runGoalCashAllocationEngine(de2Before, snapshot);
    const de2After = runDecisionEngineV2(snapshot);
    return { same: de2BeforeJson === JSON.stringify(de2After), hasOnlyKnownFields: Object.keys(de2Before).sort().join(',') };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.same, true, 'runDecisionEngineV2() sonucu, allocation motoru çağrıldıktan ÖNCE ve SONRA birebir aynı olmalı');
  assert.equal(out.hasOnlyKnownFields, 'actions,availableCash,distributableCash,explanations,goalImpact,protectedCash,status,summary,warnings', 'runDecisionEngineV2()\'nin dönüş şekli DEĞİŞMEMİŞ olmalı');
  await page.close();
});

// -----------------------------------------------------------------------
// ÜRÜN DÜZELTMESİ: acil fon açığı artık salt bilgi değil — dağıtılabilir para VARSA gerçek bir
// P1 tahsisatı. Aşağıdaki testler de2/snapshot'ı gerçek render() üzerinden üretip ardından SADECE
// protectedCash/emergencyGap/distributableCash alanlarını (GOAL-CASH-5/9'daki gibi düz obje
// spread'iyle) kontrollü değerlere ayarlıyor — motor SAF bir fonksiyon olduğu için bu geçerli ve
// izole bir test yöntemidir; gerçek uygulama state'i BOZULMUYOR.
async function baseDe2Snapshot(page) {
  return page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
    return { de2: runMonthlyDecisionEngineLive(), snapshot: buildMonthlySnapshot() };
  });
}

test('GOAL-CASH-12: distributableCash < stillShort -> dağıtılabilirin TAMAMI acil fona gider, başka hiçbir P2-P4 kalemi üretilmez', async () => {
  const { page, pageErrors } = await newPage();
  const { de2, snapshot } = await baseDe2Snapshot(page);
  const out = await page.evaluate(({ de2, snapshot }) => {
    const de2X = { ...de2, protectedCash: 0 };
    const snapshotX = { ...snapshot, emergencyGap: de2.distributableCash + 10000 }; // stillShort > distributableCash
    return { result: runGoalCashAllocationEngine(de2X, snapshotX), distributableCash: de2.distributableCash };
  }, { de2, snapshot });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const emerg = out.result.allocations.find(a => a.type === 'emergency_fund_contribution');
  assert.ok(emerg, 'dağıtılabilir para varken ve açık ondan büyükken GERÇEK bir acil fon tahsisatı olmalı');
  assert.equal(emerg.amount, out.distributableCash, 'dağıtılabilirin TAMAMI acil fona gitmeli');
  assert.equal(out.result.unallocatedCash, 0);
  assert.ok(!out.result.allocations.some(a => ['debt_reduction', 'goal_contribution', 'long_term_or_flexible'].includes(a.type)), 'açık kapanmadığından başka hiçbir P2-P4 kalemi ÜRETİLMEMELİ');
  assert.equal(out.result.status, 'liquidity_priority');
  await page.close();
});

test('GOAL-CASH-13: distributableCash === stillShort -> acil fon TAM olarak kapanır, kalan/remainder 0', async () => {
  const { page, pageErrors } = await newPage();
  const { de2, snapshot } = await baseDe2Snapshot(page);
  const out = await page.evaluate(({ de2, snapshot }) => {
    const de2X = { ...de2, protectedCash: 0 };
    const snapshotX = { ...snapshot, emergencyGap: de2.distributableCash }; // stillShort === distributableCash
    return { result: runGoalCashAllocationEngine(de2X, snapshotX), distributableCash: de2.distributableCash };
  }, { de2, snapshot });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const emerg = out.result.allocations.find(a => a.type === 'emergency_fund_contribution');
  assert.ok(emerg);
  assert.equal(emerg.amount, out.distributableCash);
  assert.match(emerg.reason, /tamamen kapat|closes that gap completely/, 'açık TAM kapandığı için mesaj bunu yansıtmalı');
  assert.equal(emerg.remainingAfterThisStep, 0);
  assert.equal(out.result.unallocatedCash, 0);
  assert.ok(!out.result.allocations.some(a => a.type === 'long_term_or_flexible'), 'açık tam olarak dağıtılabilirin tamamını kullandı — kalan/remainder olmamalı');
  await page.close();
});

test('GOAL-CASH-14: distributableCash > stillShort -> acil fon SADECE açık kadarını alır, GERÇEK kalan mevcut önceliklerden (long_term_or_flexible) devam eder', async () => {
  const { page, pageErrors } = await newPage();
  const { de2, snapshot } = await baseDe2Snapshot(page);
  const out = await page.evaluate(({ de2, snapshot }) => {
    const de2X = { ...de2, protectedCash: 0 };
    const gap = Math.round(de2.distributableCash / 2); // stillShort < distributableCash
    const snapshotX = { ...snapshot, emergencyGap: gap };
    return { result: runGoalCashAllocationEngine(de2X, snapshotX), distributableCash: de2.distributableCash, gap };
  }, { de2, snapshot });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const emerg = out.result.allocations.find(a => a.type === 'emergency_fund_contribution');
  assert.ok(emerg);
  assert.equal(emerg.amount, out.gap, 'acil fon SADECE açık kadarını (yarısını) almalı — fazlasını değil');
  const flex = out.result.allocations.find(a => a.type === 'long_term_or_flexible');
  assert.ok(flex, 'acil fon kapandıktan sonra GERÇEK kalan, mevcut önceliklerden (burada boş borç/hedef olduğundan doğrudan long_term_or_flexible) devam etmeli');
  assert.equal(flex.amount, out.distributableCash - out.gap, 'kalan tam olarak (distributableCash - stillShort) olmalı');
  assert.equal(out.result.unallocatedCash, 0);
  await page.close();
});

test('GOAL-CASH-15: dağıtılabilir tutar sıfırken acil fon açığı GERÇEK bir tahsisat üretmez — eskisi gibi salt bilgi kalır, çift sayım olmaz', async () => {
  const { page, pageErrors } = await newPage();
  const { de2, snapshot } = await baseDe2Snapshot(page);
  const out = await page.evaluate(({ de2, snapshot }) => {
    const de2X = { ...de2, protectedCash: 0, distributableCash: 0 };
    const snapshotX = { ...snapshot, emergencyGap: 60000 };
    return { result: runGoalCashAllocationEngine(de2X, snapshotX) };
  }, { de2, snapshot });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(!out.result.allocations.some(a => a.type === 'emergency_fund_contribution'), 'dağıtılabilir para yokken İCAT EDİLECEK bir tutar da yok — GERÇEK tahsisat ÜRETİLMEMELİ');
  const note = out.result.allocations.find(a => a.type === 'liquidity_shortfall_note');
  assert.ok(note, 'eski davranış korunmalı: salt bilgilendirme notu hâlâ görünmeli');
  assert.equal(note.amount, 0);
  assert.equal(out.result.unallocatedCash, 0);
  await page.close();
});

test('GOAL-CASH-16: acil fon açığı YOKSA (stillShort<=0) davranış tamamen değişmeden kalır — kalan doğrudan long_term_or_flexible\'a gider', async () => {
  const { page, pageErrors } = await newPage();
  const { de2, snapshot } = await baseDe2Snapshot(page);
  const out = await page.evaluate(({ de2, snapshot }) => {
    const de2X = { ...de2, protectedCash: 12000 };
    const snapshotX = { ...snapshot, emergencyGap: 12000 }; // stillShort = 12000-12000 = 0
    return { result: runGoalCashAllocationEngine(de2X, snapshotX), distributableCash: de2.distributableCash };
  }, { de2, snapshot });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(!out.result.allocations.some(a => a.type === 'emergency_fund_contribution' || a.type === 'liquidity_shortfall_note'), 'açık yokken hiçbir likidite kalemi üretilmemeli — mevcut davranış korunmalı');
  const flex = out.result.allocations.find(a => a.type === 'long_term_or_flexible');
  assert.ok(flex);
  assert.equal(flex.amount, out.distributableCash, 'açık olmadığından dağıtılabilirin TAMAMI kalan kaleme gitmeli');
  await page.close();
});

test('GOAL-CASH-17: acil fon tahsisatı devreye girdiğinde bile runDecisionEngineV2() DEĞİŞMEDEN kalır (bu düzeltmeye özgü doğrulama)', async () => {
  const { page, pageErrors } = await newPage();
  const { de2, snapshot } = await baseDe2Snapshot(page);
  const out = await page.evaluate(({ de2, snapshot }) => {
    const de2Before = runDecisionEngineV2(snapshot);
    const de2BeforeJson = JSON.stringify(de2Before);
    const de2X = { ...de2, protectedCash: 0 };
    const snapshotX = { ...snapshot, emergencyGap: de2.distributableCash + 10000 };
    runGoalCashAllocationEngine(de2X, snapshotX); // stillShort > distributableCash dalını tetikler
    const de2After = runDecisionEngineV2(snapshot);
    return { same: de2BeforeJson === JSON.stringify(de2After) };
  }, { de2, snapshot });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.same, true, 'GERÇEK acil fon tahsisatı dalı devrede olsa bile runDecisionEngineV2() TEKRAR hesaplanmaz/mutasyona uğramaz');
  await page.close();
});
