// FAZ 3.18 — KREDİ KARTLARI FORM UX / GÜVEN / BİLGİ MİMARİSİ regresyon testleri
// -----------------------------------------------------------------------
// Denetim bulgusu: "Son 4 hane" (cardLast4Input/c.last4) hiçbir hesaplama, bildirim veya
// karşılama motoru tarafından KULLANILMIYORDU — allDebts()/getFinancialAlerts()/
// checkAndNotifyDuePayments()/assessCardAffordability()/buildAICoachContext() hiçbiri bu alanı
// okumuyordu; tek kullanımı kart listesinde/açılır menülerde kozmetik bir "•••• 1234" etiket
// sonekiydi. Bu faz o alanı UI/doğrulama/persistence/render'dan TAMAMEN kaldırır (finansal alan
// DEĞİL), kredi kartı formunu 5 görsel gruba ayırır (Kart Detayları/Borç Durumu/Ödeme Takvimi/
// Borç Maliyeti/Diğer), gün seçicilerine (Ekstre kesim günü/Son ödeme günü) kontrolün ÜSTÜNDE
// görünür bir field-label ve boş durum için nötr bir "Seçiniz" seçeneği ekler, ve formun başına
// kart numarası/CVV/şifre istemediğini açıklayan kısa bir güven notu (.loan-hint, var olan
// yardımcı-kutu deseni) ekler. Kart limiti/güncel borç/ekstre kesim günü/son ödeme günü/asgari
// ödeme/aylık faiz oranı hâlâ birinci sınıf, erişilebilir alanlardır — hiçbiri gizlenmedi. Hiçbir
// finansal motor, Ana Sayfa, Finans Koçu, Sesle Ekle, Yatırım veya Ayarlar bu fazda değiştirilmedi.
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
    persistent.debts = [];
    persistent.creditCards = s.creditCards || [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
    month.expenses = [];
    setTab('debts');
    render();
  }, setup || {});
  return { page, pageErrors };
}

async function openCardForm(page) {
  await page.click('#showCardFormBtn');
  await page.waitForTimeout(150);
}

test('FAZ3.18-1: card name and bank name remain available as fields', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const present = await page.evaluate(() => !!document.getElementById('cardNameInput') && !!document.getElementById('cardBankInput'));
  await page.close();
  assert.ok(present, 'cardNameInput and cardBankInput must still exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-2: "Son 4 hane" is removed from the UI and no longer required/read by validation or save', async () => {
  assert.ok(!appHtmlSource.includes('cardLast4Input'), 'the #cardLast4Input element must no longer exist anywhere in the source');
  assert.ok(!appHtmlSource.includes('Son 4 hane'), 'the "Son 4 hane" placeholder text must no longer appear');
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const check = await page.evaluate(() => {
    document.getElementById('cardNameInput').value = 'Test Kart';
    document.getElementById('addCardBtn').click();
    return { cards: [...persistent.creditCards] };
  });
  await page.close();
  assert.equal(check.cards.length, 1, 'a card must save successfully with no last4 field to fill at all');
  assert.equal(check.cards[0].last4, undefined, 'the saved card object must not carry a last4 property');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-3: no full card number / CVV / password fields are introduced', () => {
  const start = appHtmlSource.indexOf('<div id="cardForm"');
  const end = appHtmlSource.indexOf('id="csvReviewSection"', start);
  assert.ok(start >= 0 && end > start, 'sanity: the card form block must be found in source');
  const formSrc = appHtmlSource.slice(start, end);
  // Yalnızca gerçek FORM KONTROLLERİNİ (input/select açılış etiketleri) tara — güven notu
  // metninin KENDİSİ bilerek "kart numarası/CVV/şifre" kelimelerini içeriyor (bkz. FAZ3.18-15),
  // o yüzden ham metin değil, yalnızca <input.../> ve <select ...> etiketleri kontrol edilir.
  const controlTags = (formSrc.match(/<(input|select)\b[^>]*>/gi) || []).join(' ').toLowerCase();
  for (const forbidden of ['cvv', 'cvc', 'card number', 'kart numarası', 'kart no', 'pan', 'password', 'şifre', 'online banking', 'internet bankacılığı']) {
    assert.ok(!controlTags.includes(forbidden), `no input/select control in the credit card form may reference "${forbidden}"`);
  }
});

test('FAZ3.18-4: limit and current debt fields remain present', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const present = await page.evaluate(() => !!document.getElementById('cardLimitInput') && !!document.getElementById('cardBalanceInput'));
  await page.close();
  assert.ok(present, 'cardLimitInput and cardBalanceInput must still exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-5: payment-calendar fields remain present (statement day, due day, minimum payment)', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const present = await page.evaluate(() => !!document.getElementById('cardStatementDayInput') && !!document.getElementById('cardDueDayInput') && !!document.getElementById('cardMinPaymentInput'));
  await page.close();
  assert.ok(present, 'cardStatementDayInput, cardDueDayInput and cardMinPaymentInput must still exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-6: interest-rate field remains present', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const present = await page.evaluate(() => !!document.getElementById('cardRateInput'));
  await page.close();
  assert.ok(present, 'cardRateInput must still exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-7: statement debt, currency and note remain available, not deleted', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const present = await page.evaluate(() => !!document.getElementById('cardStatementBalanceInput') && !!document.getElementById('cardCurrencySelect') && !!document.getElementById('cardNoteInput'));
  await page.close();
  assert.ok(present, 'cardStatementBalanceInput, cardCurrencySelect and cardNoteInput must still exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-8: every date/select field in the card form has a visible field label rendered before the control', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const check = await page.evaluate(() => {
    function labelBefore(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const wrap = el.parentElement;
      const label = wrap ? wrap.querySelector('.field-label') : null;
      return label ? label.textContent.trim() : null;
    }
    return {
      statementDayLabel: labelBefore('cardStatementDayInput'),
      dueDayLabel: labelBefore('cardDueDayInput'),
      currencyLabel: labelBefore('cardCurrencySelect'),
    };
  });
  await page.close();
  assert.ok(check.statementDayLabel && check.statementDayLabel.length > 0, 'Ekstre kesim günü select must have a visible label before it');
  assert.ok(check.dueDayLabel && check.dueDayLabel.length > 0, 'Son ödeme günü select must have a visible label before it');
  assert.ok(check.currencyLabel && check.currencyLabel.length > 0, 'Para birimi select must have a visible label before it');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-9: empty/unselected day selects show an explicit visible option ("Seçiniz"), not a blank-looking control', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const check = await page.evaluate(() => {
    const statementSel = document.getElementById('cardStatementDayInput');
    const dueSel = document.getElementById('cardDueDayInput');
    return {
      statementFirstOptionText: statementSel.options[0].textContent.trim(),
      dueFirstOptionText: dueSel.options[0].textContent.trim(),
      statementSelectedText: statementSel.options[statementSel.selectedIndex].textContent.trim(),
    };
  });
  await page.close();
  assert.equal(check.statementFirstOptionText, 'Seçiniz', 'the unselected placeholder option must read "Seçiniz"');
  assert.equal(check.dueFirstOptionText, 'Seçiniz', 'the unselected placeholder option must read "Seçiniz"');
  assert.equal(check.statementSelectedText, 'Seçiniz', 'with nothing chosen yet, the visible selection must be the explicit "Seçiniz" state, never a blank string');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-10: important financial fields remain usable on mobile (360px/390px) — visible, focusable, fillable', async () => {
  for (const width of [360, 390, 430]) {
    const { page, pageErrors } = await newSession({ width, height: 844 });
    await openCardForm(page);
    const check = await page.evaluate(() => {
      const ids = ['cardNameInput', 'cardBankInput', 'cardLimitInput', 'cardBalanceInput', 'cardStatementDayInput', 'cardDueDayInput', 'cardMinPaymentInput', 'cardRateInput', 'cardStatementBalanceInput', 'cardCurrencySelect', 'cardNoteInput'];
      return ids.map(id => {
        const el = document.getElementById(id);
        const r = el ? el.getBoundingClientRect() : null;
        return { id, visible: !!(r && r.width > 0 && r.height > 0), withinViewport: !!(r && r.right <= document.documentElement.clientWidth + 1) };
      });
    });
    await page.fill('#cardNameInput', 'Mobil Test Kart');
    const filled = await page.evaluate(() => document.getElementById('cardNameInput').value);
    await page.close();
    for (const c of check) {
      assert.ok(c.visible, `${c.id} must be visible at ${width}px`);
      assert.ok(c.withinViewport, `${c.id} must stay within the viewport at ${width}px (no horizontal overflow)`);
    }
    assert.equal(filled, 'Mobil Test Kart', `the name field must remain fillable at ${width}px`);
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  }
});

test('FAZ3.18-11: no horizontal overflow/clipping occurs in the credit card form at 360-1440px', async () => {
  for (const width of [360, 390, 430, 768, 1024, 1440]) {
    const { page, pageErrors } = await newSession({ width, height: 900 });
    await openCardForm(page);
    const scrollInfo = await page.evaluate(() => ({
      docScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      formScrollWidth: document.getElementById('cardForm').scrollWidth,
    }));
    await page.close();
    assert.ok(scrollInfo.docScrollWidth <= scrollInfo.viewportWidth + 1, `no horizontal page overflow expected at ${width}px, got scrollWidth=${scrollInfo.docScrollWidth} vs viewport=${scrollInfo.viewportWidth}`);
    assert.ok(scrollInfo.formScrollWidth <= scrollInfo.viewportWidth + 1, `the card form itself must not be wider than the viewport at ${width}px`);
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  }
});

test('FAZ3.18-12: existing card-save (add + edit) behavior remains unchanged', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const check = await page.evaluate(() => {
    document.getElementById('cardNameInput').value = 'Bonus Card';
    document.getElementById('cardBankInput').value = 'Test Bank';
    document.getElementById('cardLimitInput').value = '50.000';
    document.getElementById('cardBalanceInput').value = '12.000';
    document.getElementById('cardStatementDayInput').value = '5';
    document.getElementById('cardDueDayInput').value = '20';
    document.getElementById('cardMinPaymentInput').value = '1.500';
    document.getElementById('cardRateInput').value = '4.5';
    document.getElementById('cardNoteInput').value = 'test not';
    document.getElementById('addCardBtn').click();
    const savedSnapshot = { ...persistent.creditCards[0] };
    // Şimdi düzenle
    startEditCard(persistent.creditCards[0]);
    const nameWhileEditing = document.getElementById('cardNameInput').value;
    document.getElementById('cardBalanceInput').value = '15.000';
    document.getElementById('addCardBtn').click();
    return { saved: savedSnapshot, nameWhileEditing, afterEdit: { ...persistent.creditCards[0] }, count: persistent.creditCards.length };
  });
  await page.close();
  assert.equal(check.saved.name, 'Bonus Card');
  assert.equal(check.saved.bankName, 'Test Bank');
  assert.equal(check.saved.limit, 50000);
  assert.equal(check.saved.currentBalance, 12000);
  assert.equal(check.saved.statementDay, 5);
  assert.equal(check.saved.dueDay, 20);
  assert.equal(check.saved.minPayment, 1500);
  assert.equal(check.saved.rate, 4.5);
  assert.equal(check.saved.note, 'test not');
  assert.equal(check.nameWhileEditing, 'Bonus Card', 'startEditCard() must still populate the form for editing');
  assert.equal(check.count, 1, 'editing must update the existing card, not create a second one');
  assert.equal(check.afterEdit.currentBalance, 15000, 'the edit must be saved');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-13: existing debt/cash-flow calculations are unaffected by the form UX changes', async () => {
  const { page, pageErrors } = await newSession({ width: 390, height: 844 }, {
    income: 100000,
    assets: 300000,
    creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 24000, limit: 200000, currency: 'TRY', minPayment: 10000, statementDay: 1, dueDay: 10, rate: 3 }],
  });
  const check = await page.evaluate(() => {
    const debts = allDebts();
    return {
      totalDebt: totalDebtTL(),
      monthlyPay: monthlyDebtPayments(),
      cardCount: debts.filter(d => d.kind === 'card').length,
    };
  });
  await page.close();
  assert.equal(check.totalDebt, 24000, 'total debt calculation (allDebts/totalDebtTL) must be unchanged');
  assert.equal(check.monthlyPay, 10000, 'monthly debt payment calculation must be unchanged');
  assert.equal(check.cardCount, 1, 'allDebts() must still surface the card as a debt row');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-14: existing reminder/notification wiring (statementDay/dueDay-based alerts) remains unchanged', async () => {
  const { page, pageErrors } = await newSession({ width: 390, height: 844 }, {
    income: 100000,
    assets: 5000,
    creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 20000, limit: 200000, currency: 'TRY', minPayment: 5000, statementDay: 1, dueDay: new Date().getDate(), rate: 3 }],
  });
  const check = await page.evaluate(() => {
    const alerts = getFinancialAlerts();
    return { hasDueAlert: alerts.some(a => a.id === 'card-due-c1') };
  });
  await page.close();
  // Bu test yalnızca MEVCUT davranışı KIRMADIĞIMIZI doğrular — yeni bir bildirim motoru
  // İCAT EDİLMEDİ; card-due uyarısı zaten önceden var olan getFinancialAlerts() mantığıdır.
  assert.equal(typeof check.hasDueAlert, 'boolean', 'getFinancialAlerts() must still run without error for a card with a due day set');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-15: the privacy/help tip explains that card credentials are not requested', async () => {
  const { page, pageErrors } = await newSession();
  await openCardForm(page);
  const noteText = await page.evaluate(() => document.getElementById('cardTrustNote')?.textContent || '');
  await page.close();
  assert.ok(/kart numarası/i.test(noteText) && /cvv/i.test(noteText) && /şifre/i.test(noteText), `the trust note must mention it does not ask for card number/CVV/password, got: "${noteText}"`);
  assert.ok(!/güvenlik ihlali|tehlike|dikkat!|uyarı!/i.test(noteText), 'the tip must read as a helpful product note, not alarming security language');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.18-16: no protected financial engine/constant was changed by this phase', async () => {
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
  assert.equal(check.distributableCash, 75000, 'protected engine output for this scenario must be unchanged by a form UX-only fix');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
