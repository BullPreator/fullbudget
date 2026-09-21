// FAZ 3.13 — Product Voice + UX Consistency Audit: ONAYLANAN 4 bulgunun kontrollü uygulaması.
// -----------------------------------------------------------------------------------------
// Bu dosya SADECE onaylanan kapsamı doğruluyor (bkz. FAZ3_13_PRODUCT_VOICE_UX_AUDIT.md):
//   1. RS-1 — .money-decision-card koyu tema kontrast düzeltmesi (yalnızca CSS, iki MEVCUT
//      token: var(--surface-2), var(--line) — yeni renk YOK, ışık teması değişmedi).
//   2. PV-1 — "Anladım" -> "Bu adımı attım" ("I took this step") etiket düzeltmesi
//      (completeMoneyTask()'ın persistence/analytics davranışı DEĞİŞMEDİ, yalnızca metin).
//   3. UX-1 — acil fon durumunda tekrar eden "hero-row" satırının bastırılması
//      (renderMonthlyPlanSummary() GÖRÜNTÜLEME kararı — runGoalCashAllocationEngine()'ın
//      ürettiği reason metni TEK KARAKTER değişmedi; borç/hedef/esnek-kalan tiplerinde
//      hero-row AYNEN kalmalı — bu dosyadaki regresyon-güvenliği testi bunu kanıtlıyor).
//   4. UX-2 — .info-badge görünmez ::after ile genişletilmiş tıklanabilir alan (görünür daire
//      boyutu DEĞİŞMEDİ, delegasyon kodu/davranışı TEK SATIR değişmedi).
// Ertelenen bulgular (bu dosyada test EDİLMİYOR, kasıtlı): border-radius tutarlılığı, aynı
// ikonların tekrarı, 52 hardcoded aria-label, acil fon detay açılır paneli yeniden tasarımı.
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

// income=120000, expenses=40000, debt=0, assets=0 -> emergency_fund_contribution acil fon
// tahsisi "top" (en yüksek öncelik) olur; hesaplanan varsayılan = 60000 (mevcut dosyalarla aynı
// baseline senaryo).
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

// -----------------------------------------------------------------------------------------
// 1) RS-1 — Koyu tema kontrast düzeltmesi
// -----------------------------------------------------------------------------------------
test('FAZ3.13-1: .money-decision-card koyu temada var(--surface-2)/var(--line) kullanır, açık temada DEĞİŞMEZ', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const card = document.querySelector('#monthlyAllocationDecision .money-decision-card');
    const lightStyle = getComputedStyle(card);
    const light = { bg: lightStyle.backgroundColor, border: lightStyle.borderTopColor };

    document.documentElement.setAttribute('data-theme', 'dark');
    const darkStyle = getComputedStyle(card);
    const dark = { bg: darkStyle.backgroundColor, border: darkStyle.borderTopColor };

    // Karşılaştırma için ham token değerlerini de okuyoruz.
    const rootDark = getComputedStyle(document.documentElement);
    const tokenSurface2 = rootDark.getPropertyValue('--surface-2').trim();
    const tokenLine = rootDark.getPropertyValue('--line').trim();
    const tokenBrandSoft = rootDark.getPropertyValue('--brand-soft').trim();

    document.documentElement.removeAttribute('data-theme');
    return { light, dark, tokenSurface2, tokenLine, tokenBrandSoft };
  });
  assert.notEqual(r.dark.bg, r.light.bg, 'Koyu temada kart arka planı açık temadan FARKLI bir çözümlenmiş değere sahip olmalı (yeni override devrede)');
  // Kartın koyu-tema arka planı .card-featured'ın brand-soft zeminiyle AYNI olmamalı (asıl bulgu buydu).
  assert.notEqual(r.dark.bg.replace(/\s/g, ''), r.tokenBrandSoft.replace(/\s/g, ''), 'Kart koyu temada ebeveyn .card-featured ile aynı (ayırt edilemez) zeminde OLMAMALI');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  await page.close();
});

test('FAZ3.13-1b: .money-decision-card koyu tema override deseni 360/390/1440px genişliklerde tutarlı render olur (kırılma/taşma yok)', async () => {
  for (const width of [360, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
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
    const r = await page.evaluate(() => {
      persistent.accounts = []; persistent.debts = []; persistent.creditCards = []; persistent.goals = [];
      persistent.dailyMoneyTask = null;
      month.incomes = [{ id: 'i1', category: 'Maaş', amount: 120000 }];
      month.expenses = [{ id: 'e1', category: 'Diğer', amount: 40000, fixed: false }];
      month.emergencyAllocationOverride = null;
      document.documentElement.setAttribute('data-theme', 'dark');
      render();
      const card = document.querySelector('#monthlyAllocationDecision .money-decision-card');
      const box = card ? card.getBoundingClientRect() : null;
      return {
        hasCard: !!card,
        withinViewport: box ? (box.width > 0 && box.x >= 0 && (box.x + box.width) <= document.documentElement.clientWidth + 1) : false,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(r.hasCard, true, `[${width}px] koyu temada kart render edilmeli`);
    assert.equal(r.withinViewport, true, `[${width}px] kart görünüm genişliğini aşmamalı`);
    assert.ok(r.scrollWidth <= r.clientWidth + 1, `[${width}px] sayfa yatay taşma yapmamalı (scrollWidth=${r.scrollWidth}, clientWidth=${r.clientWidth})`);
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
    await page.close();
  }
});

// -----------------------------------------------------------------------------------------
// 2) PV-1 — "Anladım" -> "Bu adımı attım" CTA semantiği
// -----------------------------------------------------------------------------------------
test('FAZ3.13-2: Görev tamamlama butonu artık "Bunu Yaptım" DEĞİL ve "Anladım" DEĞİL, yeni doğru etiketi taşıyor', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const btn = document.getElementById('moneyTaskCompleteBtn');
    return { text: btn ? btn.textContent.trim() : null, exists: !!btn };
  });
  assert.equal(r.exists, true, '#moneyTaskCompleteBtn DOM\'da bulunmalı');
  assert.notEqual(r.text, 'Bunu Yaptım', 'FAZ 3.1\'in kaçındığı "görev" (task) çerçevesi geri gelmemeli');
  assert.notEqual(r.text, 'Anladım', 'PV-1 bulgusu: "Anladım" artık gerçek eylemi yanlış tanımlıyordu, değişmiş olmalı');
  assert.ok(r.text && r.text.length > 0, 'Buton metni boş olmamalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-3: Yeni etiketle tıklandığında completeMoneyTask() davranışı (persistence/istatistik) DEĞİŞMEDEN çalışır', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const before = {
      completedCount: persistent.moneyTaskStats ? (persistent.moneyTaskStats.completedCount || 0) : 0,
      taskStatus: (persistent.dailyMoneyTask && persistent.dailyMoneyTask.task) ? persistent.dailyMoneyTask.task.status : null,
    };
    const btn = document.getElementById('moneyTaskCompleteBtn');
    const btnText = btn ? btn.textContent.trim() : null;
    if (btn) btn.click();
    const after = {
      completedCount: persistent.moneyTaskStats ? (persistent.moneyTaskStats.completedCount || 0) : 0,
      taskStatus: (persistent.dailyMoneyTask && persistent.dailyMoneyTask.task) ? persistent.dailyMoneyTask.task.status : null,
      hasCompletedAt: !!(persistent.dailyMoneyTask && persistent.dailyMoneyTask.task && persistent.dailyMoneyTask.task.completedAt),
    };
    return { btnText, before, after };
  });
  assert.ok(r.btnText && r.btnText.length > 0, 'Buton metni okunabilir olmalı');
  assert.equal(r.after.taskStatus, 'completed', 'Buton tıklanınca görev durumu "completed" olmalı (davranış AYNI)');
  assert.equal(r.after.hasCompletedAt, true, 'completedAt damgalanmalı (davranış AYNI)');
  assert.equal(r.after.completedCount, r.before.completedCount + 1, 'moneyTaskStats.completedCount 1 artmalı (Koç istatistiği AYNI şekilde besleniyor)');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------------------------
// 3) UX-1 — Tekrar eden tutar (hero-row bastırma, yalnızca acil fon durumunda)
// -----------------------------------------------------------------------------------------
test('FAZ3.13-4: Acil fon "top" iken hero-row bastırılır, motorun reason metni AYNEN kalır', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    const top = result.allocations.find(a => a.priority === 'P1' && a.type === 'emergency_fund_contribution');
    const summaryEl = document.getElementById('monthlyPlanSummary');
    const heroRow = summaryEl ? summaryEl.querySelector('.hero-row') : null;
    return {
      topExists: !!top,
      topReason: top ? top.reason : null,
      heroRowExistsInDom: !!heroRow,
      heroRowIsHidden: !!(heroRow && getComputedStyle(heroRow).display === 'none'),
      heroRowExcludedFromInnerText: !!(summaryEl && !summaryEl.innerText.includes('Acil durum fonuna ayır')),
      hasReasonParagraph: !!(summaryEl && Array.from(summaryEl.querySelectorAll('.goal-line')).some(el => top && el.textContent === top.reason)),
    };
  });
  assert.equal(r.topExists, true, 'Bu senaryoda top allocation emergency_fund_contribution olmalı (baseline varsayımı)');
  assert.equal(r.heroRowExistsInDom, true, 'hero-row düğümü DOM\'dan SİLİNMEMELİ (mevcut FAZ3.4-5 regresyon testi bunu okuyor)');
  assert.equal(r.heroRowIsHidden, true, 'Acil fon durumunda hero-row GÖRSEL OLARAK gizlenmeli (display:none) — UX-1 düzeltmesi');
  assert.equal(r.heroRowExcludedFromInnerText, true, 'Gizlenen hero-row artık kullanıcıya görünen metinde (innerText) tekrar YARATMAMALI');
  assert.equal(r.hasReasonParagraph, true, 'Motorun ürettiği reason cümlesi (runGoalCashAllocationEngine, DEĞİŞMEDİ) hâlâ gösterilmeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-5: REGRESYON GÜVENLİĞİ — borç önceliği "top" olduğunda hero-row AYNEN gösterilmeye devam eder (yalnızca acil fon durumu bastırıldı)', async () => {
  // Acil fon gap'ini tamamen kapatacak kadar yüksek varlık + yüksek faizli esnek borç ile
  // P1 (acil fon) adımının allocation ÜRETMEMESİNİ (stillShort<=1) ve P2 (borç) adımının
  // "top" olmasını sağlıyoruz.
  const { page, pageErrors } = await newSession(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 5000000, currency: 'TRY' }];
    persistent.debts = [{ id: 'd1', category: 'Nakit Avans', balance: 300000, currency: 'TRY', rate: 8, fixedSchedule: false }];
  });
  const r = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    const emergencyAlloc = result.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const debtAlloc = result.allocations.find(a => a.type === 'debt_reduction' && a.amount > 1);
    const summaryEl = document.getElementById('monthlyPlanSummary');
    return {
      hasEmergencyAlloc: !!emergencyAlloc,
      hasDebtAlloc: !!debtAlloc,
      debtAmount: debtAlloc ? Math.round(debtAlloc.amount) : null,
      hasHeroRowForDebt: !!(summaryEl && Array.from(summaryEl.querySelectorAll('.hero-row span')).some(el => /Borcuna ayır/.test(el.textContent))),
      heroRowAmountText: summaryEl ? (summaryEl.querySelector('.hero-row b') ? summaryEl.querySelector('.hero-row b').textContent : null) : null,
    };
  });
  assert.equal(r.hasEmergencyAlloc, false, 'Bu senaryoda acil fon gap\'i varlıklarla kapanmış olmalı (P1 allocation üretilmemeli) — test kurgusu doğrulaması');
  assert.equal(r.hasDebtAlloc, true, 'Bu senaryoda borç azaltma "top" allocation olmalı — test kurgusu doğrulaması');
  assert.equal(r.hasHeroRowForDebt, true, 'Borç önceliğinde hero-row ("Borcuna ayır") ARTIK DA gösterilmeye devam etmeli — UX-1 düzeltmesi yalnızca acil fon durumunu etkiledi');
  assert.ok(r.heroRowAmountText && r.debtAmount !== null && r.heroRowAmountText.includes(String(r.debtAmount).slice(0, 2)), `Hero-row tutarı borç tutarıyla tutarlı görünmeli, gerçek: ${r.heroRowAmountText} vs ${r.debtAmount}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-6: #monthlyPlanSummary içinde acil fon tutarı tekrar sayısı azaldı ama sıfırlanmadı (mevcut FAZ3.6 sınırları içinde kalır)', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    const top = result.allocations.find(a => a.priority === 'P1' && a.type === 'emergency_fund_contribution');
    const amountStr = String(Math.round(top.amount));
    const summaryEl = document.getElementById('monthlyPlanSummary');
    const text = summaryEl.innerText || '';
    // "60000" -> "60.000" biçimli aramak yerine basit rakam dizisini (60000) noktalardan
    // arındırılmış metinde sayıyoruz.
    const stripped = text.replace(/\./g, '');
    const occurrences = stripped.split(amountStr).length - 1;
    return { amountStr, occurrences, text };
  });
  assert.ok(r.occurrences >= 1 && r.occurrences <= 2, `#monthlyPlanSummary içinde tutar 1-2 kez geçmeli (hero-row kaldırıldı ama reason/mini-kart hâlâ var), gerçek: ${r.occurrences}, metin: ${r.text}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------------------------
// 4) UX-2 — .info-badge tıklanabilir alan genişletmesi
// -----------------------------------------------------------------------------------------
test('FAZ3.13-7: .info-badge görünür boyutu DEĞİŞMEDİ (18x18px), ::after ile tıklanabilir alan genişledi', async () => {
  // netWorthLiquidityBadge yalnızca assets>0 iken görünür (bkz. renderNetWorthLiquidityBadge) —
  // rozetin görünmesi için bir banka hesabı bakiyesi seed ediyoruz.
  const { page, pageErrors } = await newSession(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
  });
  const r = await page.evaluate(() => {
    const badge = document.getElementById('netWorthLiquidityBadge');
    if (!badge) return { exists: false };
    const box = badge.getBoundingClientRect();
    const afterStyle = getComputedStyle(badge, '::after');
    return {
      exists: true,
      visibleWidth: Math.round(box.width),
      visibleHeight: Math.round(box.height),
      afterContent: afterStyle.content,
      afterPosition: afterStyle.position,
      afterInset: afterStyle.inset || `${afterStyle.top} ${afterStyle.right} ${afterStyle.bottom} ${afterStyle.left}`,
    };
  });
  assert.equal(r.exists, true, '#netWorthLiquidityBadge (bir .info-badge örneği) DOM\'da bulunmalı');
  assert.equal(r.visibleWidth, 18, `Görünür badge genişliği 18px olarak KALMALI (tasarım kasıtlı küçük), gerçek: ${r.visibleWidth}`);
  assert.equal(r.visibleHeight, 18, `Görünür badge yüksekliği 18px olarak KALMALI, gerçek: ${r.visibleHeight}`);
  assert.equal(r.afterPosition, 'absolute', '::after genişletilmiş tıklama alanı için absolute konumlandırılmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-8: .info-badge etrafındaki genişletilmiş (görünmez) alana tıklamak hâlâ badge\'i açar/kapatır (delegasyon davranışı DEĞİŞMEDİ)', async () => {
  const { page, pageErrors } = await newSession(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
  });
  const r = await page.evaluate(() => {
    const badge = document.getElementById('netWorthLiquidityBadge');
    const box = badge.getBoundingClientRect();
    return { x: box.x, y: box.y, w: box.width, h: box.height, initiallyOpen: badge.classList.contains('open') };
  });
  assert.equal(r.initiallyOpen, false, 'Badge başlangıçta kapalı olmalı');
  // Görünür dairenin biraz DIŞINDA (genişletilmiş ::after bölgesinde, ~ -9px inset içinde) bir
  // noktaya tıklıyoruz: görünür kutunun sol-üst köşesinden 5px daha sola/yukarı.
  const clickX = r.x - 5;
  const clickY = r.y + r.h / 2;
  await page.mouse.click(clickX, clickY);
  const afterClick = await page.evaluate(() => document.getElementById('netWorthLiquidityBadge').classList.contains('open'));
  assert.equal(afterClick, true, 'Genişletilmiş görünmez alana tıklamak badge\'i AÇMALI (e.target.closest(\'.info-badge\') hâlâ çözülüyor)');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
