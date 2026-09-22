// EMERGENCY ALLOCATION OVERRIDE — kullanıcının "bu ay gerçekçi olarak ayırabileceğim tutar"ı
// canonical Goal & Cash Allocation Engine'in waterfall'ına GİRDİ olarak vermesi.
// -----------------------------------------------------------------------------------------
// Denetim: mevcut acil fon tahsisi runGoalCashAllocationEngine()'ın ADIM 2'sinde
// (emergency_fund_contribution) hesaplanıyor: amt = min(remaining, stillShort) — stillShort =
// emergencyGap - protectedCash. Bu HER ZAMAN "elden geldiğince kapat" mantığıyla, kullanıcının
// o ay gerçekten ayırabileceği tutarı hiç sormadan çalışıyordu. Bu değişiklik:
//   - runDecisionEngineV2()/runGoalCashAllocationEngine()'ın kendisine YENİ bir motor EKLEMEDİ,
//     yalnızca ADIM 2'nin GİRDİSİNİ (hesaplanan varsayılan yerine, varsa kullanıcı override'ı)
//     değiştirdi — waterfall'ın YAPISI (sıra, diğer adımlar, remaining zinciri) AYNEN duruyor.
//   - Override, month.emergencyAllocationOverride'da (yalnızca CARİ AYA ait — month, ay
//     değişince MONTH_KEY rotasyonuyla sıfırlanır) tutulur; buildMonthlySnapshot() bunu
//     snapshot.emergencyAllocationOverride olarak taşır, emergencyGap/protectedCash/
//     emergencyTarget3'e HİÇ dokunmaz.
//   - Tahsis edilmeyen fark waterfall'ın `remaining` değişkeninde kalır ve borç/hedef/esnek-kalan
//     adımlarına doğal olarak akar (İKİNCİ bir allocation sistemi YOK).
//   - "Sıradaki Adımım" (ensureTodaysMoneyTask/reconcilePersistedEmergencyTask) ve günlük güvenli
//     harcama (getCanonicalFreeSpendingPoolTL) ZATEN aynı runGoalCashAllocationEngine() sonucunu
//     okuyor — bu dosyada YENİDEN senkronize edilmedi, var olan tek-kaynak mimarisi sayesinde
//     otomatik olarak hizalı kalıyorlar.
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

// Stage'lerdeki (FAZ 3.20) acceptance senaryosuyla AYNI: income=120000, expenses=40000, debt=0,
// assets=0 -> protectedCash=12000, distributableCash=68000, stillShort(=hesaplanan varsayılan)=60000.
async function newSession(setup) {
  const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
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
  await page.evaluate(() => {
    persistent.accounts = [];
    persistent.debts = [];
    persistent.creditCards = [];
    persistent.goals = [];
    persistent.dailyMoneyTask = null;
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 120000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 40000, fixed: false }];
    month.emergencyAllocationOverride = null;
  });
  if (setup) await page.evaluate(setup);
  await page.evaluate(() => render());
  return { page, pageErrors };
}

async function openPlanDetail(page) {
  await page.evaluate(() => {
    const wrap = document.getElementById('planDetailWrap');
    if (wrap) wrap.hidden = false;
  });
}

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-01: varsayılan hesaplanan tahsis doğru
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-01: override yokken hesaplanan varsayılan tahsis 60000', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const row = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    return { amount: row ? row.amount : null, calculatedAmount: row ? row.calculatedAmount : null, isOverridden: row ? row.isOverridden : null, distributableCash: allocation.distributableCash };
  });
  assert.equal(r.distributableCash, 68000);
  assert.equal(Math.round(r.amount), 60000, `Beklenen varsayılan tahsis 60000, gerçek: ${r.amount}`);
  assert.equal(Math.round(r.calculatedAmount), 60000);
  assert.equal(r.isOverridden, false);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-02: kullanıcı daha düşük tutar girince kalan distributable doğru geri dönüyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-02: override=20000 iken kalan (long_term_or_flexible) 48000', async () => {
  const { page, pageErrors } = await newSession();
  await openPlanDetail(page);
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000');
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    const flexRow = allocation.allocations.find(a => a.type === 'long_term_or_flexible');
    return {
      emergencyAmount: emergencyRow ? emergencyRow.amount : null,
      isOverridden: emergencyRow ? emergencyRow.isOverridden : null,
      calculatedAmount: emergencyRow ? emergencyRow.calculatedAmount : null,
      flexAmount: flexRow ? flexRow.amount : 0,
      distributableCash: allocation.distributableCash,
    };
  });
  assert.equal(Math.round(r.emergencyAmount), 20000, `Emergency tahsisi 20000 olmalı, gerçek: ${r.emergencyAmount}`);
  assert.equal(r.isOverridden, true);
  assert.equal(Math.round(r.calculatedAmount), 60000, 'Hesaplanan varsayılan hâlâ ayrıca raporlanmalı');
  assert.equal(Math.round(r.flexAmount), 48000, `68000-20000=48000 waterfall'a geri dönmeli, gerçek: ${r.flexAmount}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-03: kullanıcı daha yüksek tutar girince distributable cash'i aşamıyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-03: override=999999 girilse bile tahsis distributableCash (68000) ile sınırlı', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('999999');
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    return { emergencyAmount: emergencyRow ? emergencyRow.amount : null, distributableCash: allocation.distributableCash, unallocatedCash: allocation.unallocatedCash };
  });
  assert.equal(Math.round(r.emergencyAmount), 68000, `Tahsis distributableCash'i aşmamalı, gerçek: ${r.emergencyAmount}`);
  assert.ok(r.emergencyAmount <= r.distributableCash + 0.01, 'Tahsis distributableCash\'ten büyük olamaz');
  assert.equal(Math.round(r.unallocatedCash), 0);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-04: override sadece ilgili aya ait
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-04: override yalnızca month nesnesinde tutulur, persistent\'e/başka bir aya YAZILMAZ', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000');
    const carriesOnMonth = month.emergencyAllocationOverride === 20000;
    const notOnPersistent = !('emergencyAllocationOverride' in persistent);
    // Ay değişimini simüle et: yeni bir 'month' nesnesi (gerçek uygulamanın ay-rotasyon
    // mantığıyla AYNI şekilde, bkz. index.html ~16700 civarı "month = {incomes:[],...}").
    const freshMonth = normalizeMonthFinancialFields({ incomes: [], expenses: [], goal: { type: 'save', amount: 0 } });
    return { carriesOnMonth, notOnPersistent, freshMonthOverride: freshMonth.emergencyAllocationOverride };
  });
  assert.equal(r.carriesOnMonth, true, 'override cari ayın month nesnesinde tutulmalı');
  assert.equal(r.notOnPersistent, true, 'override persistent (aylar-arası kalıcı state) içine YAZILMAMALI');
  assert.equal(r.freshMonthOverride, null, 'yeni/taze bir ay override\'ı DEVRALMAMALI');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-05: override kaldırılınca default hesaplamaya dönüyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-05: override temizlenince (boş string) tahsis tekrar hesaplanan 60000\'e döner', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000');
    const overridden = runMonthlyGoalCashAllocationLive().allocations.find(a => a.type === 'emergency_fund_contribution').amount;
    setEmergencyAllocationOverride(''); // reset
    const afterReset = runMonthlyGoalCashAllocationLive().allocations.find(a => a.type === 'emergency_fund_contribution');
    return { overridden, afterResetAmount: afterReset.amount, afterResetIsOverridden: afterReset.isOverridden, monthField: month.emergencyAllocationOverride };
  });
  assert.equal(Math.round(r.overridden), 20000);
  assert.equal(Math.round(r.afterResetAmount), 60000, `Reset sonrası varsayılana dönmeli, gerçek: ${r.afterResetAmount}`);
  assert.equal(r.afterResetIsOverridden, false);
  assert.equal(r.monthField, null);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-06: Sıradaki Adımım ve canonical allocation aynı tutarı gösteriyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-06: override sonrası "Sıradaki Adımım" canonical emergency tahsisiyle senkron', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000'); // zaten render() tetikler (bkz. setEmergencyAllocationOverride)
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    const task = persistent.dailyMoneyTask && persistent.dailyMoneyTask.task;
    return { canonicalAmount: emergencyRow.amount, taskAmount: task ? task.amount : null, taskCategory: task ? moneyTaskCategoryFromStep(task) : null };
  });
  assert.equal(r.taskCategory, 'acil_fon', `"Sıradaki Adımım" acil fon kategorisinde olmalı, gerçek: ${r.taskCategory}`);
  assert.equal(Math.round(r.taskAmount), Math.round(r.canonicalAmount), `Sıradaki Adımım (${r.taskAmount}) canonical (${r.canonicalAmount}) ile eşleşmeli`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-07: override sonrası canonical serbest/esnek (long_term_or_flexible) havuz
// beklenen tutarı yansıtır
// -----------------------------------------------------------------------
// RP-1 (2026-09): bu test eskiden Home ring'inin DOM'daki günlük tempo gösterimini
// (getCanonicalFreeSpendingPoolTL/computeSafeDailySpendTempo/#dailyAmountNum) de doğruluyordu;
// ring kaldırıldığı için o kısım çıkarıldı. ÇEKİRDEK doğrulama (override sonrası canonical
// GCAE'nin 'long_term_or_flexible' satırının doğru tutarı üretmesi) KORUNDU — artık ring-only
// yardımcı fonksiyon yerine doğrudan canonical allocation satırından okunuyor.
test('EMERGENCY-OVERRIDE-07: override=20000 iken canonical serbest/esnek kalan (long_term_or_flexible=48000) doğru', async () => {
  const { page, pageErrors } = await newSession();
  await page.evaluate(() => { setEmergencyAllocationOverride('20000'); });
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const flexRow = allocation.allocations.find(a => a && a.type === 'long_term_or_flexible');
    const pool = flexRow ? Math.max(0, Number(flexRow.amount) || 0) : 0;
    return { pool };
  });
  assert.equal(Math.round(r.pool), 48000, `Serbest/esnek kalan 48000 olmalı, gerçek: ${r.pool}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-08: sayfa yenileme sonrası override korunuyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-08: override persist edilir ve sayfa yenilenince (aynı ay) korunur', async () => {
  const { page, pageErrors } = await newSession();
  await page.evaluate(async () => {
    setEmergencyAllocationOverride('20000');
    // persistMonth() 250ms debounce'lu — testte gerçek storage yazımını bekle.
    await new Promise(r => setTimeout(r, 500));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800); // storage'dan yükleme + ilk render
  const r = await page.evaluate(() => ({
    monthField: month.emergencyAllocationOverride,
  }));
  assert.equal(Math.round(r.monthField), 20000, `Sayfa yenileme sonrası override korunmalı, gerçek: ${r.monthField}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EK: UI — input, hedef/korunan/kalan-ihtiyaç satırları ve "zorunlu" dilinin YOKLUĞU
// -----------------------------------------------------------------------
test('EK: Acil Fon override UI\'ı Hedef/Korunan nakit/Kalan ihtiyaç gösterir ve zorlayıcı dil kullanmaz', async () => {
  const { page, pageErrors } = await newSession();
  await openPlanDetail(page);
  const r = await page.evaluate(() => {
    render();
    const wrapText = document.getElementById('planPriorityGap').innerText;
    const input = document.getElementById('emergencyAllocOverrideInput');
    return { wrapText, inputValue: input ? input.value : null, hasInput: !!input };
  });
  assert.equal(r.hasInput, true, 'emergencyAllocOverrideInput DOM\'da bulunmalı');
  // 2026-09 UI GÜNCELLEMESİ: input artık ekranda Türkçe binlik ayraçla ("60.000") geliyor
  // (bkz. renderMonthlyAllocationDecision) — ayraç noktalarını kaldırıp sayıya çeviriyoruz.
  const numericInputValue = Number(String(r.inputValue).replace(/\./g, ''));
  assert.equal(Math.round(numericInputValue), 60000, `Input varsayılan olarak hesaplanan tutarla (binlik ayraçlı) dolu gelmeli, gerçek: ${r.inputValue}`);
  assert.ok(/\./.test(r.inputValue), `Input varsayılan değeri Türkçe binlik ayraçla gösterilmeli (nokta içermeli), gerçek: ${r.inputValue}`);
  assert.ok(/Hedef/.test(r.wrapText) && /Korunan nakit/.test(r.wrapText) && /Kalan ihtiyaç/.test(r.wrapText), `Beklenen satırlar eksik: ${r.wrapText}`);
  assert.ok(!/zorunlu|yeterli|doğru karar|harcamalısın/i.test(r.wrapText), `Metin zorlayıcı/yönlendirici dil içermemeli: ${r.wrapText}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// 2026-09 UI GÜNCELLEMESİ: "Bu ay ayıracağım" artık kendi vurgulu mini-kartında
// (#monthlyAllocationDecision), "Detayları gör" ile açılan #planDetailWrap'İN DIŞINDA/görünür
// yüzde duruyor; ayrıca yazarken canlı Türkçe binlik noktalama ve normalize edilmiş commit.
// -----------------------------------------------------------------------
test('EK-UI-1: Bu ay ayıracağım kartı #planDetailWrap dışında, kartın görünür yüzünde durur', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render(); // "Detayları gör" AÇILMADAN, yani #planDetailWrap hidden iken
    const decisionEl = document.getElementById('monthlyAllocationDecision');
    const wrapEl = document.getElementById('planDetailWrap');
    const input = document.getElementById('emergencyAllocOverrideInput');
    return {
      hasDecisionEl: !!decisionEl,
      decisionHasCard: !!(decisionEl && decisionEl.querySelector('.money-decision-card')),
      wrapIsHidden: !!(wrapEl && wrapEl.hasAttribute('hidden')),
      inputInsideDecisionEl: !!(decisionEl && input && decisionEl.contains(input)),
      inputInsideWrap: !!(wrapEl && input && wrapEl.contains(input)),
    };
  });
  assert.equal(r.hasDecisionEl, true, '#monthlyAllocationDecision DOM\'da bulunmalı');
  assert.equal(r.decisionHasCard, true, '#monthlyAllocationDecision içinde .money-decision-card render edilmeli');
  assert.equal(r.wrapIsHidden, true, '#planDetailWrap "Detayları gör" tıklanmadan hidden kalmalı (davranış değişmedi)');
  assert.equal(r.inputInsideDecisionEl, true, 'emergencyAllocOverrideInput artık #monthlyAllocationDecision içinde olmalı');
  assert.equal(r.inputInsideWrap, false, 'emergencyAllocOverrideInput artık gizli #planDetailWrap içinde OLMAMALI (asıl kaldırılan sorun)');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-2: Bu ay ayıracağım input\'u yazarken Türkçe binlik ayraçla canlı formatlanır', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    input.focus();
    input.value = '';
    // Kullanıcı "120000" yazıyor gibi simüle ediyoruz (input event'i attachThousandsInput'u tetikler).
    input.value = '120000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const afterTyping = input.value;
    input.value = '1500000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const afterTyping2 = input.value;
    return { afterTyping, afterTyping2 };
  });
  assert.equal(r.afterTyping, '120.000', `120000 yazınca "120.000" görünmeli, gerçek: ${r.afterTyping}`);
  assert.equal(r.afterTyping2, '1.500.000', `1500000 yazınca "1.500.000" görünmeli, gerçek: ${r.afterTyping2}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-3: Binlik ayraçlı görüntü değeri commit edildiğinde doğru numeric tutar olarak kaydedilir (1000 kat hata YOK)', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    // Not: distributableCash bu senaryoda 68000, bu yüzden distributableCash'i AŞMAYAN bir
    // (ve hesaplanan varsayılan 60000'den farklı) bir tutar seçiyoruz — amaç engine'in kendi
    // "min(remaining, override)" sınırlamasını değil, yalnızca ekran->numeric ayrıştırmasını
    // (1000 kat hata olup olmadığını) doğrulamak (EMERGENCY-OVERRIDE-03 zaten üst sınır capping'ini
    // ayrıca test ediyor).
    input.value = '45.000'; // kullanıcı yazdıktan sonra ekranda duran binlik ayraçlı hâl
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return {
      monthField: month.emergencyAllocationOverride,
      emergencyAmount: runMonthlyGoalCashAllocationLive().allocations.find(a => a.type === 'emergency_fund_contribution').amount,
    };
  });
  assert.equal(Math.round(r.monthField), 45000, `Binlik ayraçlı "45.000" commit edilince 45000 olarak kaydedilmeli (45 DEĞİL), gerçek: ${r.monthField}`);
  assert.equal(Math.round(r.emergencyAmount), 45000, `Motorun kullandığı tutar da 45000 olmalı, gerçek: ${r.emergencyAmount}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-4: Reset linki tıklanınca override kalkar ve hesaplanan tutar satırı kaybolur', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    setEmergencyAllocationOverride('20000');
    const beforeReset = {
      overridden: month.emergencyAllocationOverride,
      hasResetLink: !!document.querySelector('#monthlyAllocationDecision [data-emergency-override-reset]'),
      hasCalculatedLine: /Hesaplanan tutar/.test(document.getElementById('monthlyAllocationDecision').innerText),
    };
    document.querySelector('#monthlyAllocationDecision [data-emergency-override-reset]').click();
    const afterReset = {
      overridden: month.emergencyAllocationOverride,
      hasResetLink: !!document.querySelector('#monthlyAllocationDecision [data-emergency-override-reset]'),
    };
    return { beforeReset, afterReset };
  });
  assert.equal(Math.round(r.beforeReset.overridden), 20000);
  assert.equal(r.beforeReset.hasResetLink, true, 'Override varken reset linki #monthlyAllocationDecision içinde görünmeli');
  assert.equal(r.beforeReset.hasCalculatedLine, true, 'Override varken "Hesaplanan tutar" satırı görünmeli');
  assert.equal(r.afterReset.overridden, null, 'Reset sonrası override kalkmalı');
  assert.equal(r.afterReset.hasResetLink, false, 'Reset sonrası reset linki kaybolmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// 2026-09 EK DOĞRULAMA TURU: yapıştırma, ortadan düzenleme, geçersiz/negatif değer (gerçek DOM
// input akışı üzerinden — doğrudan fonksiyon çağrısı değil), ekran<->numeric ayrımının açık
// kanıtı, ve kullanıcının girdiği tutarın GERÇEKTEN motora (Goal & Cash Allocation Engine) girdi
// olarak gittiğinin (motor MANTIĞININ değil, motorun aldığı SAYISAL DEĞERİN değiştiğinin) kanıtı.
// -----------------------------------------------------------------------
test('EK-UI-5: 50000/120000/1500000 canlı yazımda doğru Türkçe binlik formata dönüşür', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    function typeDigits(digits) {
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      for (const ch of digits) {
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return input.value;
    }
    return {
      v50000: typeDigits('50000'),
      v120000: typeDigits('120000'),
      v1500000: typeDigits('1500000'),
    };
  });
  assert.equal(r.v50000, '50.000', `50000 yazınca "50.000" olmalı, gerçek: ${r.v50000}`);
  assert.equal(r.v120000, '120.000', `120000 yazınca "120.000" olmalı, gerçek: ${r.v120000}`);
  assert.equal(r.v1500000, '1.500.000', `1500000 yazınca "1.500.000" olmalı, gerçek: ${r.v1500000}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-6: yapıştırılan binlik ayraçlı/karışık bir değer doğru normalize edilir (paste)', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    input.focus();
    input.value = '';
    // Kullanıcının panosundan "75.500" yapıştırdığını simüle ediyoruz (paste sonrası tarayıcı
    // input.value'yu zaten günceller, ardından 'input' event'i tetiklenir — attachThousandsInput
    // bunu diğer tüm .money-input alanlarıyla aynı şekilde ele alır, paste için özel kod yoktur).
    const dt = new DataTransfer();
    dt.setData('text/plain', '75.500');
    const pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(pasteEvent);
    input.value = '75.500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const displayed = input.value;
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return { displayed, monthField: month.emergencyAllocationOverride };
  });
  assert.equal(r.displayed, '75.500', `Yapıştırılan "75.500" ekranda binlik ayraçlı kalmalı, gerçek: ${r.displayed}`);
  assert.equal(Math.round(r.monthField), 75500, `Yapıştırılan değer commit edilince 75500 olarak kaydedilmeli (755 veya 75500000 DEĞİL), gerçek: ${r.monthField}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-7: sayının ortasına ekleme/düzenleme yapılırken cursor konumu ve değer doğru kalır', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    input.focus();
    input.value = '50.000';
    input.dispatchEvent(new Event('input', { bubbles: true })); // reformat: "50.000" (değişmez)
    // "50" ile "000" arasına (nokta öncesi, index 2) "9" ekle -> rakamlar: 50 + 9 + 000 = 509000
    const pos = 2;
    input.setSelectionRange(pos, pos);
    input.setRangeText('9', pos, pos, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { value: input.value, cursorPos: input.selectionStart };
  });
  assert.equal(r.value, '509.000', `Ortaya "9" eklenince "509.000" olmalı, gerçek: ${r.value}`);
  // Cursor, eklenen rakamdan hemen sonra kalmalı (3. rakamdan sonra = "509" dan sonra, nokta öncesi index 3).
  assert.equal(r.cursorPos, 3, `Cursor eklenen rakamdan hemen sonra kalmalı, gerçek pos: ${r.cursorPos}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-8: geçersiz/negatif/anlamsız input DOM üzerinden girilirse mevcut (DEĞİŞTİRİLMEYEN) finansal davranış aynen korunur', async () => {
  // NOT: setEmergencyAllocationOverride()'ın "abc" gibi rakamsız girdilerde 0'a düşme davranışı
  // (isFinite(Number(''))===false DEĞİL, Number('')===0 olduğu için) bu UI değişikliğinden ÖNCE de
  // vardı — eski regex'te de `.replace(/[^\d.,-]/g,'')` "abc" için '' üretiyor, Number('')=0 oluyordu.
  // Doğrulama: git show HEAD:app/index.html'deki ESKİ fonksiyon da AYNI girdide AYNI sonucu (0) veriyor.
  // Bu test, "mevcut finansal davranış korunsun" gereksinimini bu GERÇEK (0'a düşme) davranışa göre
  // doğruluyor — davranışı DEĞİŞTİRMEDEN, yalnızca binlik ayraçlı ("−5.000" gibi) girdilerin de aynı
  // şekilde ele alındığını kanıtlıyor.
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    function commit(rawText) {
      input.value = rawText;
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return { monthField: month.emergencyAllocationOverride, calcAmount: Math.round(runMonthlyGoalCashAllocationLive().allocations.find(a => a.type === 'emergency_fund_contribution').amount) };
    }
    const negative = commit('-5.000'); // negatif -> reddedilir (n>=0 kontrolü), null'a düşer
    const garbage = commit('abc'); // rakamsız -> Number('')=0 (mevcut/değişmeyen davranış)
    const empty = commit(''); // boş -> override KALDIRILIR (null), madde 11'in "varsayılana dön" davranışı
    return { negative, garbage, empty };
  });
  assert.equal(r.negative.monthField, null, `Negatif "-5.000" override olarak KAYDEDİLMEMELİ (n>=0 kontrolü), gerçek: ${r.negative.monthField}`);
  assert.equal(r.negative.calcAmount, 60000, `Negatif değer reddedilince hesaplanan varsayılana (60000) dönmeli, gerçek: ${r.negative.calcAmount}`);
  assert.equal(r.garbage.monthField, 0, `Rakamsız "abc" girdisinde ESKİ davranış AYNEN korunmalı (Number('')=0), gerçek: ${r.garbage.monthField}`);
  assert.equal(r.empty.monthField, null, `Boş değer override\'ı KALDIRMALI (null), gerçek: ${r.empty.monthField}`);
  assert.equal(r.empty.calcAmount, 60000, `Boş değerde hesaplanan varsayılana (60000) dönmeli, gerçek: ${r.empty.calcAmount}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-9: ekrandaki formatlı değer (display) ile motorun kullandığı numeric değer birbirinden GERÇEKTEN ayrışmış', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');
    input.value = '30.000';
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return {
      // Ekranda hâlâ NOKTALI (formatlı) string duruyor mu?
      displayedIsFormattedString: input.value,
      // month.emergencyAllocationOverride SAF SAYI mı (nokta/virgül İÇERMEYEN bir number tipi)?
      numericTypeofIsNumber: typeof month.emergencyAllocationOverride,
      numericValue: month.emergencyAllocationOverride,
    };
  });
  assert.equal(r.displayedIsFormattedString, '30.000', 'Ekranda binlik ayraçlı string kalmalı');
  assert.equal(r.numericTypeofIsNumber, 'number', 'Motorun kullandığı depolanan değer saf JS number tipinde olmalı');
  assert.equal(r.numericValue, 30000, `Depolanan numeric değer 30000 olmalı (30 DEĞİL, "30.000" string'i DEĞİL), gerçek: ${r.numericValue}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('EK-UI-10: kullanıcı tutarı değiştirince Goal & Cash Allocation Engine\'in aldığı numeric değer değişir, motor MANTIĞI (waterfall yapısı) değişmez', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    render();
    const input = document.getElementById('emergencyAllocOverrideInput');

    // 1) Override YOKKEN motorun ürettiği sonuç (baseline).
    const before = runMonthlyGoalCashAllocationLive();
    const beforeEmergency = before.allocations.find(a => a.type === 'emergency_fund_contribution');
    const beforeFlex = before.allocations.find(a => a.type === 'long_term_or_flexible');

    // 2) Kullanıcı UI üzerinden "25.000" girip commit ediyor (input -> blur, gerçek akış).
    input.value = '25.000';
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    const after = runMonthlyGoalCashAllocationLive();
    const afterEmergency = after.allocations.find(a => a.type === 'emergency_fund_contribution');
    const afterFlex = after.allocations.find(a => a.type === 'long_term_or_flexible');

    return {
      distributableCashBefore: before.distributableCash,
      distributableCashAfter: after.distributableCash,
      beforeEmergencyAmount: Math.round(beforeEmergency.amount),
      afterEmergencyAmount: Math.round(afterEmergency.amount),
      beforeFlexAmount: Math.round(beforeFlex ? beforeFlex.amount : 0),
      afterFlexAmount: Math.round(afterFlex ? afterFlex.amount : 0),
      afterCalculatedAmount: Math.round(afterEmergency.calculatedAmount),
      afterIsOverridden: afterEmergency.isOverridden,
    };
  });
  // Motorun YAPISI (distributableCash, waterfall'ın toplam pastası) DEĞİŞMEDİ.
  assert.equal(r.distributableCashBefore, r.distributableCashAfter, 'distributableCash (motorun waterfall girdisi) değişmemeli — yalnızca dağıtım girdisi değişti');
  // Ama motorun ADIM 2'ye verdiği GİRDİ (emergency tahsis miktarı) DEĞİŞTİ: 60000 (hesaplanan) -> 25000 (kullanıcı).
  assert.equal(r.beforeEmergencyAmount, 60000, `Override öncesi hesaplanan varsayılan 60000 olmalı, gerçek: ${r.beforeEmergencyAmount}`);
  assert.equal(r.afterEmergencyAmount, 25000, `Kullanıcı 25.000 girince motor 25000 kullanmalı, gerçek: ${r.afterEmergencyAmount}`);
  assert.notEqual(r.beforeEmergencyAmount, r.afterEmergencyAmount, 'Kullanıcı tutarı değiştirince motorun aldığı numeric değer DEĞİŞMELİ');
  // calculatedAmount (varsayılan) HÂLÂ 60000 olarak ayrıca raporlanmaya devam ediyor — motor "hesaplama" mantığı bozulmadı.
  assert.equal(r.afterCalculatedAmount, 60000, 'Hesaplanan varsayılan (motorun kendi formülü) override sonrasında da değişmeden raporlanmalı');
  assert.equal(r.afterIsOverridden, true, 'isOverridden bayrağı true olmalı');
  // Farkın waterfall'ın geri kalanına (long_term_or_flexible) doğal olarak aktığı doğrulanıyor —
  // yeni bir allocation sistemi İCAT EDİLMEDİĞİNİN kanıtı: 60000-25000=35000 fazlalık esnek kalana dönmeli.
  assert.equal(r.afterFlexAmount - r.beforeFlexAmount, 35000, `Tahsis edilmeyen fark (35000) waterfall'ın esnek/kalan adımına akmalı, gerçek fark: ${r.afterFlexAmount - r.beforeFlexAmount}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
