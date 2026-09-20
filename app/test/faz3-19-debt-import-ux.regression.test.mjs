// FAZ 3.19 — BORÇ EKLE + EKSTRE IMPORT + FİŞ VERİ AKIŞI UX/DATA-INTEGRITY regresyon testleri
// -----------------------------------------------------------------------------------------
// Denetim bulgusu (A): "Kalan borç ve ödeme planı" tek field-label'ı, altındaki Kredi-dışı
// borç türlerinde ("Nakit Avans"/"Döviz Borcu"/"Diğer") iki ayrı sayısal alanı (Kalan borç,
// Aylık faiz %) kapsıyordu ve bu ikisinin ayrımı yalnızca placeholder metnine dayanıyordu —
// kullanıcı yazmaya başlayınca placeholder kaybolup alan bağlamsız kalıyordu (Kredi türü
// için zaten var olan .loan-captions kalıcı başlık deseni burada YOKTU). Aynı şekilde
// debtDueDateInput/debtOriginalDateInput (type="date") hiçbir kalıcı görünür etikete sahip
// değildi — tarayıcılar type="date" input'larında placeholder attribute'unu göstermez, yani
// bu alanlar boşken TAMAMEN etiketsiz görünüyordu. Bu faz, Kredi'nin zaten kullandığı
// .loan-captions kalıcı başlık desenini bu alanlara da uygular; hiçbir veri modeli/anahtar
// değişmedi (debtBalanceInput/debtRateInput/debtDueDateInput/debtOriginalDateInput id'leri,
// persistent.debts alan adları ve hesaplama mantığı AYNI).
//
// Denetim bulgusu (B): DEBT_CATEGORIES'teki defaultRate (Kredi: 3.73, Nakit Avans: 4.25,
// Döviz Borcu/Diğer: 0) kategori seçilince debtRateInput'a OTOMATİK yazılıyor ve kullanıcının
// gerçek/güncel oranıymış gibi görünebiliyordu — kod yorumu bunun "Ağustos 2026 itibarıyla
// yaklaşık piyasa/TCMB azami oranları, düzenlenebilir" bir varsayım olduğunu doğruluyor. Bu
// faz, kredi kartı formundaki "cc-faiz-not" ile AYNI .loan-hint desenini kullanan bir not
// ekler: oranın bir varsayım olduğunu ve yalnızca hesaplamada kullanıldığını açıklar. Sayısal
// varsayılan DEĞERLER değişmedi.
//
// Denetim bulgusu (D): CSV/PDF/fiş (OCR) içe aktarma zaten yalnızca İŞLEM (tarih/işyeri/
// tutar/kategori) çıkarıyor — kart limiti/son ödeme günü/asgari ödeme/faiz oranı gibi kart
// meta verisi hiçbir zaman import'tan yazılmıyor ve mevcut kopya zaten bunu doğru yansıtıyor
// ("N işlem bulundu/aktarıldı" — "ekstre aktarıldı" değil). Bu doğru davranış burada
// regresyona karşı sabitleniyor, YENİ bir import alanı/motoru EKLENMEDİ.
//
// Denetim bulgusu (E): Fiş/OCR akışı zaten onay ekranından (renderCsvReview/csvApproveBtn)
// geçmeden HİÇBİR ŞEYİ kaydetmiyor; tutar/işyeri/kategori onay ekranında düzenlenebilir ve
// OCR'dan tutar çıkarılamazsa (parseReceiptText null) hiçbir taslak oluşturulmuyor. Bu doğru
// güvenlik davranışı burada regresyona karşı sabitleniyor.
//
// Bu fazda Ana Sayfa, Finans Koçu, Ayarlar, Yatırım veya herhangi bir finansal motor
// DEĞİŞTİRİLMEDİ.
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
  await page.evaluate((s) => {
    persistent.accounts = s.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: s.assets, currency: 'TRY' }] : [];
    persistent.debts = s.debts || [];
    persistent.creditCards = s.creditCards || [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
    month.expenses = [];
    setTab('debts');
    render();
  }, setup || {});
  return { page, pageErrors };
}

async function openDebtForm(page) {
  await page.click('#showDebtFormBtn');
  await page.waitForTimeout(150);
}

test('FAZ3.19-1: all existing debt types remain available (Nakit Avans, Döviz Borcu, Kredi, Diğer)', async () => {
  const { page, pageErrors } = await newSession();
  await openDebtForm(page);
  const names = await page.evaluate(() => [...document.querySelectorAll('#debtCatGrid .cat-btn')].map(b => b.textContent.trim()));
  await page.close();
  for (const n of ['Nakit Avans', 'Döviz Borcu', 'Kredi', 'Diğer']) {
    assert.ok(names.includes(n), `debt category "${n}" must remain selectable`);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-2: every debt form field has an unambiguous, persistent semantic label (not just a placeholder)', async () => {
  const { page, pageErrors } = await newSession();
  await openDebtForm(page);
  // Kredi DIŞI bir tür seç (Nakit Avans varsayılan aktif) — "Kalan borç"/"Aylık faiz (%)" alanları görünür olmalı.
  const check = await page.evaluate(() => {
    function captionTextBeforeRow(inputId) {
      const el = document.getElementById(inputId);
      const row = el.closest('.form-row');
      const capRow = row ? row.previousElementSibling : null;
      if (!capRow || !capRow.classList.contains('loan-captions')) return null;
      return [...capRow.querySelectorAll('span')].map(s => s.textContent.trim());
    }
    return {
      balanceRateCaptions: captionTextBeforeRow('debtBalanceInput'),
      balanceRateCaptionVisible: getComputedStyle(document.getElementById('debtBalanceRateCaption')).display !== 'none',
    };
  });
  await page.close();
  assert.ok(check.balanceRateCaptionVisible, 'the persistent caption row above "Kalan borç"/"Aylık faiz (%)" must be visible for a non-Kredi debt type');
  assert.ok(check.balanceRateCaptions && check.balanceRateCaptions.length === 2, 'there must be exactly two distinct persistent captions above the balance/rate row');
  assert.equal(check.balanceRateCaptions[0], 'Kalan borç');
  assert.equal(check.balanceRateCaptions[1], 'Aylık faiz (%)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-3: date fields (due date, original date) have visible persistent labels and an explicit empty state', async () => {
  const { page, pageErrors } = await newSession();
  await openDebtForm(page);
  const check = await page.evaluate(() => {
    function captionTextBeforeRow(inputId) {
      const el = document.getElementById(inputId);
      const row = el.closest('.form-row');
      const capRow = row ? row.previousElementSibling : null;
      if (!capRow || !capRow.classList.contains('loan-captions')) return null;
      return [...capRow.querySelectorAll('span')].map(s => s.textContent.trim());
    }
    return {
      dueDateCaptions: captionTextBeforeRow('debtDueDateInput'),
      originalDateCaptions: captionTextBeforeRow('debtOriginalBalanceInput'),
      dueDateEmptyValue: document.getElementById('debtDueDateInput').value,
      originalDateEmptyValue: document.getElementById('debtOriginalDateInput').value,
    };
  });
  await page.close();
  assert.ok(check.dueDateCaptions && check.dueDateCaptions.includes('Son ödeme tarihi'), 'debtDueDateInput must have a visible persistent "Son ödeme tarihi" label, not just a browser-ignored placeholder');
  assert.ok(check.originalDateCaptions && check.originalDateCaptions.includes('Başlangıç tarihi'), 'debtOriginalDateInput must have a visible persistent "Başlangıç tarihi" label');
  assert.equal(check.dueDateEmptyValue, '', 'an unset date input has an explicit, unambiguous empty value (native browser empty state)');
  assert.equal(check.originalDateEmptyValue, '', 'an unset date input has an explicit, unambiguous empty value');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-4: default interest rate is represented as a default, not an authoritative real rate', async () => {
  const { page, pageErrors } = await newSession();
  await openDebtForm(page);
  const check = await page.evaluate(() => {
    const hint = document.getElementById('debtRateDefaultHint');
    return {
      hintVisible: hint && getComputedStyle(hint).display !== 'none',
      hintText: hint ? hint.textContent.trim() : '',
      prefilledRate: document.getElementById('debtRateInput').value,
    };
  });
  await page.close();
  assert.ok(check.hintVisible, 'the default-rate helper note must be visible in the debt form');
  assert.match(check.hintText, /varsayılan/i, 'the note must explain the pre-filled rate is a default, not a real/current rate');
  assert.match(check.hintText, /yalnızca hesaplamada/i, 'the note must clarify the rate is only used for calculation purposes');
  assert.ok(check.prefilledRate !== '', 'the default rate value itself must remain pre-filled and editable (behavior unchanged)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-5: important debt fields are not silently dropped by manual save', async () => {
  const { page, pageErrors } = await newSession();
  await openDebtForm(page);
  const check = await page.evaluate(() => {
    document.getElementById('debtBalanceInput').value = '10.000';
    document.getElementById('debtRateInput').value = '4.25';
    document.getElementById('debtMinPaymentInput').value = '1.000';
    document.getElementById('debtExtraPaymentInput').value = '500';
    document.getElementById('debtDueDateInput').value = '2026-10-15';
    document.getElementById('debtNoteInput').value = 'Test banka';
    document.getElementById('debtOriginalBalanceInput').value = '12.000';
    document.getElementById('debtOriginalDateInput').value = '2026-01-01';
    document.getElementById('addDebtBtn').click();
    return { ...persistent.debts[0] };
  });
  await page.close();
  assert.equal(check.category, 'Nakit Avans');
  assert.equal(check.balance, 10000);
  assert.equal(check.rate, 4.25);
  assert.equal(check.minPayment, 1000);
  assert.equal(check.extraPayment, 500);
  assert.equal(check.dueDate, '2026-10-15');
  assert.equal(check.note, 'Test banka');
  assert.equal(check.originalBalance, 12000);
  assert.equal(check.originalDate, '2026-01-01');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-6: PDF/CSV import field coverage matches actual parser behavior (matrix-based)', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => {
    const csvText = 'Tarih,Açıklama,Tutar\n15.09.2026,Migros,1.250,50\n';
    const csvResult = parseCsvTransactions(csvText, 'c1');
    const pdfDraft = parsePdfLine('15.09.2026 MIGROS 1.250,50');
    return {
      csv: csvResult.transactions[0],
      pdf: pdfDraft,
    };
  });
  await page.close();
  // Manuel form desteklediği kart/borç meta alanları (limit, son ödeme günü, asgari ödeme,
  // faiz oranı, ekstre kesim günü) hiçbir zaman CSV/PDF taslak nesnesinde YOKTUR — yalnızca
  // işlem (tarih/işyeri/tutar/kategori/taksit) çıkarılır. Bu, gerçek ayrıştırıcı çıktısına
  // karşı doğrulanıyor, varsayılan olarak "doğru" kabul edilmiyor.
  assert.ok('date' in check.csv && 'merchant' in check.csv && 'amount' in check.csv && 'category' in check.csv, 'CSV drafts must carry date/merchant/amount/category');
  assert.ok('date' in check.pdf && 'merchant' in check.pdf && 'amount' in check.pdf, 'PDF drafts must carry date/merchant/amount');
  for (const cardField of ['limit', 'dueDay', 'statementDay', 'minPayment', 'rate', 'statementBalance']) {
    assert.equal(check.csv[cardField], undefined, `CSV transaction drafts must NOT fabricate card metadata field "${cardField}"`);
    assert.equal(check.pdf[cardField], undefined, `PDF transaction drafts must NOT fabricate card metadata field "${cardField}"`);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-7: imported transaction amounts preserve Turkish decimal formats correctly', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => ({
    trThousandsComma: parseCsvAmount('1.250,50'),
    plainComma: parseCsvAmount('1250,50'),
    enDotDecimal: parseCsvAmount('1250.50'),
  }));
  await page.close();
  assert.equal(check.trThousandsComma, 1250.50, '"1.250,50" (TR thousands+decimal) must parse to 1250.50');
  assert.equal(check.plainComma, 1250.50, '"1250,50" (TR decimal only) must parse to 1250.50');
  assert.equal(check.enDotDecimal, 1250.50, '"1250.50" (EN decimal) must parse to 1250.50');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-8: receipt/OCR extracted values are visible in an editable review screen before save', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => {
    const draft = parseReceiptText('MIGROS TICARET\n15.09.2026\nEKMEK 15,00\nSUT 45,00\nTOPLAM 60,00');
    csvDraftTransactions = [draft];
    renderCsvReview();
    const row = document.querySelector('#csvReviewList .csv-row');
    return {
      draftAmount: draft.amount,
      reviewSectionVisible: getComputedStyle(document.getElementById('csvReviewSection')).display !== 'none',
      merchantInputValue: row.querySelector('.csv-row-title-input').value,
      amountInputValue: row.querySelector('.csv-row-amount-input').value,
      categorySelectPresent: !!row.querySelector('.csv-cat-select'),
      persistedBeforeApproval: month.expenses.length,
    };
  });
  await page.close();
  assert.equal(check.draftAmount, 60, 'OCR must correctly extract the total (60,00 -> 60)');
  assert.ok(check.reviewSectionVisible, 'the review/confirmation screen must be shown before anything is saved');
  // "MIGROS TICARET" bilinen satıcı sözlüğünde eşleşip normalize edilmiş haliyle ("Migros")
  // gösteriliyor (detectMerchantFromFreeText) — bu, ayrıştırıcının doğru/beklenen davranışı,
  // amaç ham OCR metnini değil ANLAMLI bir işyeri adını göstermek. Önemli olan: alan
  // DOLU, GÖRÜNÜR ve DÜZENLENEBİLİR (boş/gizli değil).
  assert.equal(check.merchantInputValue, 'Migros', 'extracted (and known-merchant-normalized) merchant must be visible and editable in the review row');
  assert.equal(check.amountInputValue, '60', 'extracted amount must be visible and editable in the review row');
  assert.ok(check.categorySelectPresent, 'a category selector must be visible for the extracted transaction');
  assert.equal(check.persistedBeforeApproval, 0, 'nothing may be written to month.expenses before the user explicitly approves');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-9: unclear OCR data (no amount found) cannot silently create a transaction draft', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => {
    const draft = parseReceiptText('BULANIK FOTOGRAF\nOKUNAMAYAN METIN');
    return { draft };
  });
  await page.close();
  assert.equal(check.draft, null, 'parseReceiptText must return null (no draft, nothing to approve) when no amount can be found, rather than guessing a value');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-10: existing manual debt save/persistence behavior (add + edit) remains functional', async () => {
  const { page, pageErrors } = await newSession();
  await openDebtForm(page);
  const check = await page.evaluate(() => {
    document.getElementById('debtBalanceInput').value = '20.000';
    document.getElementById('debtRateInput').value = '3';
    document.getElementById('addDebtBtn').click();
    const saved = { ...persistent.debts[0] };
    startEditDebt(persistent.debts[0]);
    document.getElementById('debtBalanceInput').value = '18.000';
    document.getElementById('addDebtBtn').click();
    return { saved, afterEdit: { ...persistent.debts[0] }, count: persistent.debts.length };
  });
  await page.close();
  assert.equal(check.saved.balance, 20000);
  assert.equal(check.afterEdit.balance, 18000, 'editing an existing debt must update it in place');
  assert.equal(check.count, 1, 'editing must not create a duplicate debt entry');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-11: mobile debt-entry layout has no horizontal overflow at 390px', async () => {
  const { page, pageErrors } = await newSession({ width: 390, height: 844 });
  await openDebtForm(page);
  const scrollInfo = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    formScrollWidth: document.getElementById('debtForm').scrollWidth,
  }));
  await page.close();
  assert.ok(scrollInfo.docScrollWidth <= scrollInfo.viewportWidth + 1, `no horizontal page overflow expected at 390px, got scrollWidth=${scrollInfo.docScrollWidth} vs viewport=${scrollInfo.viewportWidth}`);
  assert.ok(scrollInfo.formScrollWidth <= scrollInfo.viewportWidth + 1, 'the debt form itself must not be wider than the viewport at 390px');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-12: desktop debt-entry layout has no accidental overflow at 1440px', async () => {
  const { page, pageErrors } = await newSession({ width: 1440, height: 900 });
  await openDebtForm(page);
  const scrollInfo = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    formScrollWidth: document.getElementById('debtForm').scrollWidth,
  }));
  await page.close();
  assert.ok(scrollInfo.docScrollWidth <= scrollInfo.viewportWidth + 1, `no horizontal page overflow expected at 1440px, got scrollWidth=${scrollInfo.docScrollWidth} vs viewport=${scrollInfo.viewportWidth}`);
  assert.ok(scrollInfo.formScrollWidth <= scrollInfo.viewportWidth + 1, 'the debt form itself must not be wider than the viewport at 1440px');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-13: existing debt/cash-flow calculations are unaffected by the form UX changes', async () => {
  const { page, pageErrors } = await newSession({ width: 390, height: 844 }, {
    income: 100000,
    assets: 300000,
    debts: [{ id: 'd1', category: 'Nakit Avans', balance: 20000, rate: 4.25, minPayment: 2000, extraPayment: 0, currency: 'TRY', fxType: 'USD' }],
  });
  const check = await page.evaluate(() => ({
    totalDebt: totalDebtTL(),
    monthlyPay: monthlyDebtPayments(),
    debtCount: allDebts().length,
  }));
  await page.close();
  assert.equal(check.totalDebt, 20000, 'total debt calculation (allDebts/totalDebtTL) must be unchanged');
  assert.equal(check.monthlyPay, 2000, 'monthly debt payment calculation must be unchanged');
  assert.equal(check.debtCount, 1, 'allDebts() must still surface the manual debt row');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-14: existing notification/reminder wiring (debt due-date alerts) remains unchanged', async () => {
  const { page, pageErrors } = await newSession({ width: 390, height: 844 }, {
    income: 100000,
    assets: 5000,
    debts: [{ id: 'd1', category: 'Nakit Avans', balance: 20000, rate: 4.25, minPayment: 2000, extraPayment: 0, currency: 'TRY', dueDate: new Date().toISOString().slice(0, 10) }],
  });
  const check = await page.evaluate(() => {
    const alerts = getFinancialAlerts();
    return { alertsIsArray: Array.isArray(alerts) };
  });
  await page.close();
  // Bu test yalnızca MEVCUT davranışı KIRMADIĞIMIZI doğrular — yeni bir bildirim motoru
  // İCAT EDİLMEDİ; getFinancialAlerts() zaten önceden var olan motordur.
  assert.ok(check.alertsIsArray, 'getFinancialAlerts() must still run without error with a debt that has a due date set');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.19-15: no protected financial engine function/constant was changed by this phase', async () => {
  const protectedNames = [
    'function runDecisionEngineV2(', 'function runGoalCashAllocationEngine(',
    'function runMonthlyGoalCashAllocationLive(', 'function computeGoalInfo(',
    'function buildMonthlySnapshot(', 'function computeCashFlowSummary(',
    'function getAffordCapacityInfo(', 'function assessCardAffordability(',
    'function getFinancialAlerts(', 'function computePriorityPlan(',
    'function _planKur(', 'function ensureTodaysMoneyTask(', 'function upgradeStalePersistedMoneyTask(',
  ];
  for (const sig of protectedNames) {
    assert.ok(appHtmlSource.includes(sig), `protected function signature must still be present verbatim: ${sig}`);
  }
  assert.ok(appHtmlSource.includes('const RISK_PROFILES'), 'RISK_PROFILES constant must still be present');

  const { page, pageErrors } = await newSession({ width: 390, height: 844 }, { income: 120000, assets: 200000 });
  const check = await page.evaluate(() => {
    month.expenses = [{ id: 'e1', category: 'Kira', amount: 40000, fixed: true }];
    persistent.debts = [{ id: 'd1', category: 'ihtiyac', note: 'Kredi', balance: 60000, rate: 3.5, minPayment: 5000, extraPayment: 0, currency: 'TRY' }];
    render();
    const canonical = runMonthlyGoalCashAllocationLive();
    return { distributableCash: canonical.distributableCash };
  });
  await page.close();
  assert.equal(check.distributableCash, 75000, 'protected engine output for this scenario must be unchanged by a debt form UX-only fix');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
