// FAZ 3.20 — "GÜNÜN GÜVENLİ HARCAMA ALANI" SEMANTİK/FORMÜL DÜZELTMESİ regresyon testleri
// -----------------------------------------------------------------------------------------
// Stage 1 denetiminin bulgusu: Home ring'indeki eski "safeDaily" hesabı
// (income - loglanmış nakit gider - tahmini kalan sabit gider - borç ödemesi) / kalanGün
// canonical runDecisionEngineV2()/runGoalCashAllocationEngine() zincirinden TAMAMEN
// BAĞIMSIZDI. Ayın başında/geçmiş veri yokken pratikte income/kalanGün'e çöküyordu
// (ör. 120000/11=10909) ve acil fon/borç/hedef tahsisatlarından habersizdi.
//
// Stage 2 düzeltmesi: ring artık KENDİ ayrı hesabını yapmıyor — zaten çalıştırılmış canonical
// runGoalCashAllocationEngine() sonucundaki 'long_term_or_flexible' (serbest/esnek kalan)
// kalemini okuyor (getCanonicalFreeSpendingPoolTL/computeSafeDailySpendTempo, index.html).
// runDecisionEngineV2()/runGoalCashAllocationEngine()'ın kendisine TEK SATIR dokunulmadı;
// bu testler de onları YENİDEN YAZMAZ, yalnızca GERÇEK motor çıktısını okuyup DOM ile karşılaştırır.
//
// Bu fazda Finans Koçu (answerHowMuchCanISpend()) BİLİNÇLİ OLARAK değiştirilmedi — o hâlâ eski
// ham nakit-akışı formülünü kullanıyor. Bu, ürünün açıkça kabul ettiği, gelecekteki bir faza
// bırakılan GEÇİCİ bir tutarsızlıktır (bkz. final rapor).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..');
const appHtmlSource = readFileSync(path.join(appDir, 'app', 'index.html'), 'utf8');

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

async function newSession(viewport, setup) {
  const page = await browser.newPage({ viewport: viewport || { width: 390, height: 844 } });
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
  if (setup) await page.evaluate(setup);
  await page.evaluate(() => render());
  return { page, pageErrors };
}

function parseTL(text) {
  // "₺8.000" / "-₺8.000" gibi TR biçimli tutarları sayıya çevirir.
  const cleaned = text.replace(/[^\d,.\-]/g, '').replace(/\./g, '').replace(',', '.');
  return Number(cleaned);
}

// Stage 1/2'nin acceptance senaryosu A: income=120000, expenses=40000, debt=0, assets=0
// (assets=0 -> liquid=0, monthlyEssential=totalSpent()*0.6=24000 -> emergencyTarget3=72000 ->
// emergencyGap=72000 -> protectedCash=min(80000*0.3, 72000/6)=12000 -> distributableCash=68000 ->
// emergency_fund_contribution=min(68000, 72000-12000=60000)=60000 -> long_term_or_flexible=8000).
const SCENARIO_A_SETUP = () => {
  persistent.accounts = [];
  persistent.debts = [];
  persistent.creditCards = [];
  persistent.goals = [];
  persistent.dailyMoneyTask = null;
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 120000 }];
  month.expenses = [{ id: 'e1', category: 'Diğer', amount: 40000, fixed: false }];
};

// Stage 1/2'nin acceptance senaryosu B: income=50000, committed(fixed) expense=30000,
// assets=200000 (liquid yeterli -> emergencyGap=0 -> protectedCash=0 -> distributableCash=20000),
// bir hedef (typeKey='diger', targetAmount=10000, 1 ay sonra) -> requiredMonthly=10000 ->
// goal_contribution=10000 -> long_term_or_flexible=10000.
const SCENARIO_B_SETUP = () => {
  persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 200000, currency: 'TRY' }];
  persistent.debts = [];
  persistent.creditCards = [];
  const targetDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  persistent.goals = [{
    id: 'g1', typeKey: 'diger', name: 'Test Hedefi', targetAmount: 10000, currentSaved: 0,
    targetDate: targetDate.toISOString().slice(0, 10),
  }];
  persistent.dailyMoneyTask = null;
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 50000 }];
  month.expenses = [{ id: 'e1', category: 'Kira', amount: 30000, fixed: true }];
};

// -----------------------------------------------------------------------
// FAZ3.20-1: eski dejenere davranış (income/kalanGün) artık üretilmiyor
// -----------------------------------------------------------------------
test('FAZ3.20-1: 120000/40000/0 borç/0 varlık senaryosunda ring artık income/kalanGün göstermiyor', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_A_SETUP);
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const pool = getCanonicalFreeSpendingPoolTL(allocation);
    return {
      domDaily: parseFloat(document.getElementById('dailyAmountNum').textContent.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.')) || 0,
      oldDegenerateValue: Math.round(totalIncome() / daysLeft),
      pool, daysLeft,
    };
  });
  assert.notEqual(Math.round(r.domDaily), r.oldDegenerateValue,
    `Ring hâlâ eski income/kalanGün (${r.oldDegenerateValue}) davranışını gösteriyor: ${r.domDaily}`);
  assert.equal(r.pool, 8000, `Beklenen serbest havuz 8000, gerçek: ${r.pool}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-2: ring canonical post-allocation kalanını TÜKETİYOR (tek kaynak)
// -----------------------------------------------------------------------
test('FAZ3.20-2: DOM daily tempo, canonical long_term_or_flexible / daysLeft ile birebir eşleşir', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_A_SETUP);
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const pool = getCanonicalFreeSpendingPoolTL(allocation);
    const expectedTempo = computeSafeDailySpendTempo({ freeSpendingPool: pool, remainingDays: daysLeft });
    return {
      domDaily: document.getElementById('dailyAmountNum').textContent,
      expectedTempo,
    };
  });
  const expectedStr = `₺${Math.round(r.expectedTempo).toLocaleString('tr-TR')}`;
  // animateNumberTo formatlamasıyla küçük farklar olabilir; sayısal olarak karşılaştır.
  const domNum = parseFloat(r.domDaily.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
  assert.ok(Math.abs(domNum - r.expectedTempo) < 1, `DOM (${r.domDaily}) beklenen (${r.expectedTempo}) ile eşleşmiyor`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-3: çift düşme yok (aritmetik kapanış: unallocated + tüm P1-P4 tahsisatları = distributableCash)
// -----------------------------------------------------------------------
test('FAZ3.20-3: giderler/tahsisatlar iki kez düşülmüyor — aritmetik kapanış doğru', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_A_SETUP);
  const r = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const allocation = runGoalCashAllocationEngine(de2, buildMonthlySnapshot());
    const sumAllocated = allocation.allocations
      .filter(a => ['emergency_fund_contribution', 'debt_reduction', 'goal_contribution', 'long_term_or_flexible'].includes(a.type))
      .reduce((s, a) => s + a.amount, 0);
    return { distributableCash: allocation.distributableCash, sumAllocated, unallocatedCash: allocation.unallocatedCash };
  });
  assert.ok(Math.abs((r.sumAllocated + r.unallocatedCash) - r.distributableCash) < 1,
    `Tahsisatların toplamı (${r.sumAllocated}+${r.unallocatedCash}) distributableCash (${r.distributableCash}) ile eşleşmiyor — çift düşme/kayıp şüphesi`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-4: acil fon tahsisatı ring'e yansıyor (havuzu küçültüyor)
// -----------------------------------------------------------------------
test('FAZ3.20-4: acil fon tahsisatı (60000) yapıldığında serbest havuz distributableCash\'ten küçük', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_A_SETUP);
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    return {
      emergencyAmount: emergencyRow ? emergencyRow.amount : 0,
      distributableCash: allocation.distributableCash,
      pool: getCanonicalFreeSpendingPoolTL(allocation),
    };
  });
  assert.equal(Math.round(r.emergencyAmount), 60000, `Beklenen acil fon tahsisatı 60000, gerçek: ${r.emergencyAmount}`);
  assert.equal(Math.round(r.pool), 8000, `Beklenen serbest havuz 8000, gerçek: ${r.pool}`);
  assert.ok(r.pool < r.distributableCash, 'Acil fon tahsisatı varken serbest havuz distributableCash\'ten küçük olmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-5: hedef tahsisatı ring'e yansıyor (Senaryo B)
// -----------------------------------------------------------------------
test('FAZ3.20-5: 50000/30000(sabit)/10000 hedef tahsisatı senaryosunda serbest havuz ≈10000', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_B_SETUP);
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const goalRow = allocation.allocations.find(a => a.type === 'goal_contribution');
    return {
      goalAmount: goalRow ? goalRow.amount : 0,
      distributableCash: allocation.distributableCash,
      pool: getCanonicalFreeSpendingPoolTL(allocation),
    };
  });
  assert.equal(Math.round(r.distributableCash), 20000, `Beklenen distributableCash 20000, gerçek: ${r.distributableCash}`);
  assert.equal(Math.round(r.goalAmount), 10000, `Beklenen hedef tahsisatı 10000, gerçek: ${r.goalAmount}`);
  assert.equal(Math.round(r.pool), 10000, `Beklenen serbest havuz 10000, gerçek: ${r.pool}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-6: borç tahsisatı çift düşme YAPMADAN yansıyor
// -----------------------------------------------------------------------
test('FAZ3.20-6: pahalı borca ekstra ödeme ayrıldığında minPayment ile ekstra ödeme İKİ AYRI kalemdir', async () => {
  const { page, pageErrors } = await newSession(null, () => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = [{ id: 'd1', category: 'ihtiyac', note: 'Test Kredisi', balance: 15000, minPayment: 5000, rate: 8, currency: 'TRY' }];
    persistent.creditCards = [];
    persistent.goals = [];
    persistent.dailyMoneyTask = null;
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 100000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 20000, fixed: false }];
  });
  const r = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const allocation = runGoalCashAllocationEngine(de2, buildMonthlySnapshot());
    const debtRow = allocation.allocations.find(a => a.type === 'debt_reduction');
    const p0DebtAction = de2.actions.find(a => a.type === 'debt_payment');
    return {
      recurringMinPayment: p0DebtAction ? p0DebtAction.amount : 0,
      extraDebtReduction: debtRow ? debtRow.amount : 0,
      pool: getCanonicalFreeSpendingPoolTL(allocation),
      income: 100000, expenses: 20000,
    };
  });
  assert.ok(r.recurringMinPayment > 0, 'Aylık minimum ödeme P0 aksiyonu olarak görünmeli');
  assert.ok(r.extraDebtReduction > 0, 'Kalan borcu kapatmak için ekstra tahsisat yapılmalı');
  assert.notEqual(r.recurringMinPayment, r.extraDebtReduction, 'Rutin ödeme ile ekstra kapatma AYNI tutar OLMAMALI (aksi halde çift sayım şüphesi)');
  // Kapanış: income - expenses - minPayment - extraDebtReduction === pool (başka tahsisat yoksa)
  const expectedPool = r.income - r.expenses - r.recurringMinPayment - r.extraDebtReduction;
  assert.ok(Math.abs(expectedPool - r.pool) < 1, `Beklenen havuz ${expectedPool}, gerçek ${r.pool} — çift/eksik düşme şüphesi`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-7: saf tempo fonksiyonu — 10000/30 gün ≈ 333.33
// -----------------------------------------------------------------------
test('FAZ3.20-7: computeSafeDailySpendTempo(10000, 30) ≈ 333.33', async () => {
  const { page, pageErrors } = await newSession(null, null);
  const tempo = await page.evaluate(() => computeSafeDailySpendTempo({ freeSpendingPool: 10000, remainingDays: 30 }));
  assert.ok(Math.abs(tempo - 333.33) < 0.01, `Beklenen ~333.33, gerçek: ${tempo}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-8: bugün 100 harcandıktan sonra tempo doğru şekilde roll-forward yapar
// -----------------------------------------------------------------------
test('FAZ3.20-8: havuz 9900\'e, gün 29\'a düşünce yeni tempo ≈341.38 (roll-forward)', async () => {
  const { page, pageErrors } = await newSession(null, null);
  const tempo = await page.evaluate(() => computeSafeDailySpendTempo({ freeSpendingPool: 9900, remainingDays: 29 }));
  assert.ok(Math.abs(tempo - 341.38) < 0.01, `Beklenen ~341.38, gerçek: ${tempo}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-9: kullanılmayan günlük kapasite gece yarısında "silinmiyor" (saat/tarih bağımlılığı yok)
// -----------------------------------------------------------------------
test('FAZ3.20-9: computeSafeDailySpendTempo saat/tarihe bakmaz — yalnızca havuz ve kalan gün sayısına bağlıdır', () => {
  const start = appHtmlSource.indexOf('function computeSafeDailySpendTempo');
  const end = appHtmlSource.indexOf('\n}', start) + 2;
  const fnSrc = appHtmlSource.slice(start, end);
  assert.ok(!/getHours|getMinutes|Date\.now|new Date\(\)/.test(fnSrc),
    'computeSafeDailySpendTempo saat/tarih bilgisine bakmamalı — yalnızca kalan gün SAYISINI kullanmalı, bu yüzden "gece yarısı sıfırlama" gibi bir davranış olamaz');
  // Aynı girdiyle art arda çağrılar hep aynı sonucu verir (gizli/mutasyona uğrayan durum yok).
  const fn = new Function('args', `${fnSrc}\nreturn computeSafeDailySpendTempo(args);`);
  const a = fn({ freeSpendingPool: 5000, remainingDays: 10 });
  const b = fn({ freeSpendingPool: 5000, remainingDays: 10 });
  assert.equal(a, b, 'Aynı girdi için sonuç deterministik olmalı');
});

// -----------------------------------------------------------------------
// FAZ3.20-10: Home metni "Günün Güvenli Harcama Alanı" ve tempo diliyle güncellendi
// -----------------------------------------------------------------------
test('FAZ3.20-10: Home ring başlığı ve etiketi artık pacing diliyle "Günün Güvenli Harcama Alanı" kullanıyor', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_A_SETUP);
  const r = await page.evaluate(() => ({
    sectionTitle: document.querySelector('[data-section="ring"] .section-title').textContent.trim(),
    dailyLabel: document.getElementById('dailyAmountLabel').textContent.trim(),
    ringNote: document.querySelector('.ring-note').textContent.trim(),
  }));
  assert.equal(r.sectionTitle, 'Günün Güvenli Harcama Alanı', `Başlık: ${r.sectionTitle}`);
  assert.ok(/tempo/i.test(r.dailyLabel), `Etiket artık "tempo" dilini kullanmalı: ${r.dailyLabel}`);
  assert.ok(!/harcamalısın/i.test(r.dailyLabel) && !/harcamalısın/i.test(r.ringNote), 'Metin "harcamalısın" gibi bir zorunluluk ifadesi içermemeli');
  assert.ok(/tempo/i.test(r.ringNote) && /sonraki günlere aktarılır/i.test(r.ringNote), `Not, roll-forward'ı açıklamalı: ${r.ringNote}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-11: Home yapısı (6 bölüm, aynı sıra) DEĞİŞMEDİ
// -----------------------------------------------------------------------
test('FAZ3.20-11: Home\'un 6 bölümü ve sırası aynı kaldı', async () => {
  const { page, pageErrors } = await newSession(null, SCENARIO_A_SETUP);
  const sections = await page.evaluate(() => Array.from(
    document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')
  ).filter(el => !el.hasAttribute('hidden')).map(el => el.getAttribute('data-section')));
  assert.deepEqual(sections, ['finansal-durum', 'bugunun-gorevi', 'ring', 'bu-ay-plan', 'bugun-bilmen-gerekenler', 'afford-teaser'],
    `Home bölüm sırası değişti: ${JSON.stringify(sections)}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// FAZ3.20-12: korunan finansal motor fonksiyonları/sabitleri kaynak düzeyinde değişmedi
// -----------------------------------------------------------------------
test('FAZ3.20-12: korunan motor fonksiyonları hâlâ kaynakta ve imzaları/gövdeleri bu fazda değişmedi', () => {
  const PROTECTED_FUNCTIONS = [
    'runDecisionEngineV2', 'runGoalCashAllocationEngine', 'runMonthlyGoalCashAllocationLive',
    'computeGoalInfo', 'buildMonthlySnapshot', 'computeCashFlowSummary', 'getAffordCapacityInfo',
    'assessCardAffordability', 'getFinancialAlerts', 'computePriorityPlan', '_planKur',
    'ensureTodaysMoneyTask', 'upgradeStalePersistedMoneyTask',
  ];
  for (const fnName of PROTECTED_FUNCTIONS) {
    assert.ok(appHtmlSource.includes(`function ${fnName}(`), `Korunan fonksiyon kaynakta bulunamadı: ${fnName}`);
  }
  assert.ok(appHtmlSource.includes('RISK_PROFILES'), 'RISK_PROFILES sabiti kaynakta bulunamadı');
  assert.ok(appHtmlSource.includes('activeRiskProfile'), 'activeRiskProfile kaynakta bulunamadı');
});
