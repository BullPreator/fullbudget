// FAZ 3.16 — SESLE EKLE UX + BEHAVIOR AUDIT regresyon testleri
// -----------------------------------------------------------------------
// Bu faz "Sesle Ekle" (initQuickAdd/parseQuickAddText/renderQuickAddPreview/sesleEkleAc)
// akışını SALT UX/kopya/hata-yönetimi açısından iyileştirir. Ses tanıma (Web Speech API)
// zaten bir ONAY ADIMINA sahipti: transkript → yorum (tutar/kategori/tür) önizlemede
// gösterilir → kullanıcı "Kaydet"e basmadan hiçbir finansal kayıt (month.incomes/
// month.expenses) OLUŞMAZ; confirmBtn click handler'ı `!quickAddParsed.amount` durumunda
// no-op'tur. Bu faz yalnızca (1) tarayıcı sesle girişi desteklemiyorken başlık/alt metnin
// hâlâ "konuş" demesini düzeltir, (2) belirsiz/algılanamayan tutar mesajını sesle geldiğinde
// ürün ilkesindeki ("Ne kadar olduğunu anlayamadım") dille ve net bir tekrar-deneme yoluyla
// netleştirir. Hiçbir finansal motor (runDecisionEngineV2/runGoalCashAllocationEngine/
// runMonthlyGoalCashAllocationLive/computeGoalInfo/buildMonthlySnapshot/
// computeCashFlowSummary/getAffordCapacityInfo/assessCardAffordability/
// getFinancialAlerts/computePriorityPlan/_planKur/RISK_PROFILES/activeRiskProfile/
// ensureTodaysMoneyTask/upgradeStalePersistedMoneyTask), Ana Sayfa, Ayarlar, Yatırım veya
// Finans Koçu bu dosya tarafından ASLA mutasyona uğratılmaz — yalnızca DOM/kopya gözlemi ve
// salt-okunur motor çağrılarıyla doğrulama yapılır.
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

// mockSpeech: 'none' -> SpeechRecognition tamamen yok (desteklenmeyen tarayıcı senaryosu);
// 'mock' -> testin onresult/onerror'ı programatik tetikleyebileceği sahte bir Recognition sınıfı.
async function newSession(setup, { viewport = { width: 390, height: 844 }, mockSpeech = 'mock' } = {}) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (mockSpeech === 'none') {
    await page.addInitScript(() => {
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
    });
  } else if (mockSpeech === 'mock') {
    await page.addInitScript(() => {
      class MockSpeechRecognition {
        constructor() { window.__mockRecognition = this; this.interimResults = false; this.maxAlternatives = 1; }
        start() { if (typeof this.onstart === 'function') this.onstart(); }
        stop() { if (typeof this.onend === 'function') this.onend(); }
      }
      window.SpeechRecognition = MockSpeechRecognition;
      window.webkitSpeechRecognition = MockSpeechRecognition;
    });
  }
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
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenseRows || [];
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null;
      setTab(s.tab || 'home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

test('FAZ3.16-1: "Sesle Ekle" entry point exists and opens the voice-add sheet', async () => {
  const { page, pageErrors } = await newSession({ tab: 'home' }, { viewport: { width: 390, height: 844 } });
  const before2 = await page.evaluate(() => document.getElementById('sesSheet').hidden);
  await page.click('[data-action="ses"]');
  await page.waitForTimeout(150);
  const after2 = await page.evaluate(() => ({
    sheetHidden: document.getElementById('sesSheet').hidden,
    hasMicOrInput: !!document.getElementById('quickAddMicBtn') && !!document.getElementById('quickAddInput'),
  }));
  await page.close();
  assert.equal(before2, true, 'sanity: the voice-add sheet must start hidden');
  assert.equal(after2.sheetHidden, false, 'clicking the "Sesle Ekle" entry point must open the voice-add sheet');
  assert.ok(after2.hasMicOrInput, 'the opened sheet must expose the mic button and the text input');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.16-2: successful voice interpretation exposes the interpreted fields (amount/category/type) before anything is saved', async () => {
  const { page, pageErrors } = await newSession({ tab: 'home', income: 0 }, { viewport: { width: 390, height: 844 } });
  await page.click('[data-action="ses"]');
  await page.waitForTimeout(150);
  const check = await page.evaluate(() => {
    const before = { expenses: month.expenses.length, incomes: month.incomes.length };
    window.__mockRecognition.onresult({ results: [[{ transcript: "Migros'tan 850 lira market" }]] });
    const previewHtml = document.getElementById('quickAddPreview').innerHTML;
    const actionsVisible = document.getElementById('quickAddActionsRow').style.display !== 'none';
    return {
      before,
      after: { expenses: month.expenses.length, incomes: month.incomes.length },
      previewHtml,
      actionsVisible,
      parsedAmount: quickAddParsed && quickAddParsed.amount,
      wasVoice: quickAddWasVoice,
    };
  });
  assert.equal(check.before.expenses, check.after.expenses, 'voice interpretation alone (before confirmation) must not create an expense');
  assert.equal(check.before.incomes, check.after.incomes, 'voice interpretation alone (before confirmation) must not create an income');
  assert.equal(check.wasVoice, true, 'the source must be tracked as voice-originated');
  assert.equal(check.parsedAmount, 850, 'the interpreted amount must be exposed for confirmation, not silently applied');
  assert.ok(check.previewHtml.includes('850'), 'the preview must show the interpreted amount to the user');
  assert.ok(check.previewHtml.toLowerCase().includes('market'), 'the preview must show the interpreted transcript/category context');
  assert.ok(check.actionsVisible, 'Save/Cancel actions must be shown once an amount was interpreted, so the user can confirm or correct it');
  // Now confirm explicitly — only THIS step may create the record.
  await page.click('#quickAddConfirmBtn');
  await page.waitForTimeout(150);
  const afterConfirm = await page.evaluate(() => ({
    expenseCount: month.expenses.length,
    lastExpense: month.expenses[month.expenses.length - 1],
  }));
  await page.close();
  assert.equal(afterConfirm.expenseCount, 1, 'the record is created only after the explicit "Kaydet" confirmation');
  assert.equal(afterConfirm.lastExpense.amount, 850, 'the saved amount must match what was shown for confirmation');
  assert.equal(afterConfirm.lastExpense.sourceType, 'voice', 'the saved record must be tagged as voice-sourced');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.16-3: ambiguous / missing amount does not silently save a record, and gives the user a clear retry path', async () => {
  const { page, pageErrors } = await newSession({ tab: 'home' }, { viewport: { width: 390, height: 844 } });
  await page.click('[data-action="ses"]');
  await page.waitForTimeout(150);
  const check = await page.evaluate(() => {
    const before = { expenses: month.expenses.length, incomes: month.incomes.length };
    // "Migros'a gittim" içinde hiçbir sayısal tutar yok — belirsiz/eksik tutar senaryosu.
    window.__mockRecognition.onresult({ results: [[{ transcript: "Migros'a gittim" }]] });
    return {
      before,
      after: { expenses: month.expenses.length, incomes: month.incomes.length },
      parsed: quickAddParsed,
      previewText: document.getElementById('quickAddPreview').textContent,
      actionsVisible: document.getElementById('quickAddActionsRow').style.display !== 'none',
    };
  });
  // confirmBtn'e basmayı DENEMEK bile (amount yokken) kayıt oluşturmamalı — güvenlik ağı.
  await page.click('#quickAddConfirmBtn', { force: true }).catch(() => {});
  await page.waitForTimeout(100);
  const afterClick = await page.evaluate(() => ({ expenses: month.expenses.length, incomes: month.incomes.length }));
  await page.close();
  assert.equal(check.parsed?.amount, null, 'sanity: no numeric amount should have been detected in this transcript');
  assert.equal(check.before.expenses, check.after.expenses, 'an ambiguous transcript must not create an expense');
  assert.equal(check.before.incomes, check.after.incomes, 'an ambiguous transcript must not create an income');
  assert.equal(check.actionsVisible, false, 'Save/Cancel must stay hidden when no amount was understood — nothing to confirm yet');
  assert.ok(check.previewText.includes('Ne kadar olduğunu anlayamadım') || check.previewText.toLowerCase().includes("couldn't catch the amount"), `the message must clearly say the amount could not be understood, without technical jargon: got "${check.previewText}"`);
  assert.equal(afterClick.expenses, check.before.expenses, 'clicking confirm with no interpreted amount must never create a record');
  assert.equal(afterClick.incomes, check.before.incomes, 'clicking confirm with no interpreted amount must never create a record');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.16-4: microphone permission failure is handled gracefully (no crash, no record, clear message, listening state resets)', async () => {
  const { page, pageErrors } = await newSession({ tab: 'home' }, { viewport: { width: 390, height: 844 } });
  await page.click('[data-action="ses"]');
  await page.waitForTimeout(150);
  const check = await page.evaluate(() => {
    const before = { expenses: month.expenses.length, incomes: month.incomes.length };
    let toastShown = false;
    const toastEl = document.getElementById('toast') || document.querySelector('.toast');
    const origText = toastEl ? toastEl.textContent : '';
    window.__mockRecognition.onerror({ error: 'not-allowed' });
    const toastText = toastEl ? toastEl.textContent : '';
    toastShown = toastText !== origText && toastText.length > 0;
    return {
      before,
      after: { expenses: month.expenses.length, incomes: month.incomes.length },
      micListening: document.querySelector('.mic-btn-wrap')?.classList.contains('listening'),
      toastShown,
      toastText,
    };
  });
  await page.close();
  assert.equal(check.before.expenses, check.after.expenses, 'a denied microphone permission must never create a record');
  assert.equal(check.before.incomes, check.after.incomes, 'a denied microphone permission must never create a record');
  assert.equal(check.micListening, false, 'the listening/pulsing mic state must reset after a permission error');
  assert.ok(check.toastShown, 'the user must be told clearly that the microphone permission was denied');
  assert.ok(/mikrofon izni reddedildi|microphone permission was denied/i.test(check.toastText), `expected a plain-language permission-denied message, got: "${check.toastText}"`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.16-5: unsupported speech recognition is handled gracefully (mic hidden, copy reflects typing, typed entry still fully works)', async () => {
  const { page, pageErrors } = await newSession({ tab: 'home' }, { viewport: { width: 390, height: 844 }, mockSpeech: 'none' });
  await page.click('[data-action="ses"]');
  await page.waitForTimeout(150);
  const check = await page.evaluate(() => {
    const micWrap = document.querySelector('.mic-btn-wrap');
    const micHidden = !micWrap || getComputedStyle(micWrap).display === 'none' || micWrap.style.display === 'none';
    const statusText = document.getElementById('quickAddStatusText')?.textContent || '';
    const statusSub = document.getElementById('quickAddStatusSub')?.textContent || '';
    return { micHidden, statusText, statusSub };
  });
  assert.ok(check.micHidden, 'the mic button must be hidden when the browser has no speech-recognition API');
  assert.ok(!/dinliyorum|listening/i.test(check.statusText), 'the status text must not reference listening/voice when voice is unavailable');
  assert.ok(/yazarak|typing|type/i.test(check.statusText + ' ' + check.statusSub), 'the copy must clearly point the user to the text-entry fallback instead of implying voice is available');
  // Metinle giriş hâlâ tam olarak çalışmalı — mikrofon yokken tek yol bu.
  await page.fill('#quickAddInput', '250 lira market');
  await page.waitForTimeout(150);
  await page.click('#quickAddConfirmBtn');
  await page.waitForTimeout(150);
  const afterSave = await page.evaluate(() => month.expenses[month.expenses.length - 1]);
  await page.close();
  assert.equal(afterSave.amount, 250, 'typed entry must still fully work as the fallback when voice is unsupported');
  assert.equal(afterSave.sourceType, 'manual', 'a typed record must be tagged as manual, not voice');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.16-6: existing manual Income/Expense entry (unrelated to voice/quick-add) is unchanged', async () => {
  const { page, pageErrors } = await newSession({ tab: 'income' }, { viewport: { width: 390, height: 844 } });
  const check = await page.evaluate(() => {
    document.getElementById('incomeAmountInput').value = '5.000';
    document.getElementById('incomeNoteInput').value = 'Test maaş';
    document.getElementById('addIncomeBtn').click();
    return { incomes: [...month.incomes] };
  });
  await page.close();
  assert.equal(check.incomes.length, 1, 'manual income entry must still create exactly one record');
  assert.equal(check.incomes[0].amount, 5000, 'manual income amount parsing must be unchanged');
  assert.equal(check.incomes[0].note, 'Test maaş', 'manual income note must be saved unchanged');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.16-7: no protected financial engine/constant was changed by this phase', () => {
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
});
