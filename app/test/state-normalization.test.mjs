// STATE NORMALIZATION testleri (P0 - M1 kök neden düzeltmesi, 2026-09-15)
// -----------------------------------------------------------------------
// M1: "storage" event (sekmeler arası senkron) ve yedek içe aktarma yolu,
// loadState()'in Number-tip normalizasyonundan GEÇMEDEN persistent/month'u
// doğrudan atıyordu. Sonuç: amount alanı string geldiğinde
// reduce((s,x)=>s+x.amount,0) sayısal toplama değil STRING BİRLEŞTİRME
// yapıyordu ("50000"+"60000" -> "50006000").
//
// Bu testler index.html'in GERÇEK kaynağından - normalizeMonthFinancialFields,
// normalizePersistentFinancialFields ve bunların gerçek bağımlılıkları
// (guvenliSayi, uid, migrateDebt, migratePersistentData, TUTAR_UST_SINIR,
// CURRENT_SCHEMA_VERSION) - fonksiyon adına göre çıkarılıp gerçek bir Node
// vm bağlamında çalıştırılıyor. Elle kopyalanmış paralel bir mantık YOK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'index.html');
const html = readFileSync(indexPath, 'utf-8');

// index.html'den "const NAME = ...;" biçimindeki tek satırlık bir sabiti çıkarır.
function extractConst(name) {
  const re = new RegExp(`const ${name}\\s*=\\s*[^;]+;`);
  const m = html.match(re);
  if (!m) throw new Error(`const ${name} index.html içinde bulunamadı`);
  return m[0];
}

// index.html'den "function NAME(...) { ... }" fonksiyonunun TAMAMINI, süslü
// parantez dengesini sayarak çıkarır (fonksiyon içinde template literal/regex
// içinde parantez olsa bile - basit bir denge sayacı bu dosyadaki gerçek
// fonksiyonlar için yeterli, hiçbiri string içinde dengesiz süslü parantez
// barındırmıyor).
function extractFunction(name) {
  const startRe = new RegExp(`function ${name}\\s*\\(`);
  const startMatch = startRe.exec(html);
  if (!startMatch) throw new Error(`function ${name} index.html içinde bulunamadı`);
  const braceOpenIdx = html.indexOf('{', startMatch.index);
  let depth = 0;
  let i = braceOpenIdx;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return html.slice(startMatch.index, i);
}

function loadStateNormalizationModule() {
  const source = [
    extractConst('CURRENT_SCHEMA_VERSION'),
    extractConst('TUTAR_UST_SINIR'),
    extractFunction('guvenliSayi'),
    extractFunction('uid'),
    extractFunction('migratePersistentData'),
    extractFunction('migrateDebt'),
    extractFunction('normalizeMonthFinancialFields'),
    extractFunction('normalizePersistentFinancialFields'),
    'module.exports = { normalizeMonthFinancialFields, normalizePersistentFinancialFields, guvenliSayi };',
  ].join('\n\n');

  const sandbox = { module: { exports: {} }, console };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'state-normalization-extracted.js' });
  return sandbox.module.exports;
}

const { normalizeMonthFinancialFields, normalizePersistentFinancialFields, guvenliSayi } = loadStateNormalizationModule();

// normalize fonksiyonları ayrı bir vm bağlamında (ayrı bir "realm") çalıştığı
// için döndürdükleri array/object'lerin prototype'ı bu test dosyasınınkinden
// FARKLI bir Array.prototype/Object.prototype'a sahip. assert/strict'in
// deepEqual'ı (=deepStrictEqual) prototype eşitliğini de kontrol ettiğinden,
// yapısal olarak birebir aynı olsalar bile cross-realm karşılaştırmada
// yanlışlıkla başarısız olur. JSON round-trip ile bu realm farkını
// normalize ederek YALNIZCA yapıyı karşılaştırıyoruz.
function jsonEqual(actual, expected, message) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
}

test('normalizeMonthFinancialFields / normalizePersistentFinancialFields index.html’den yüklenebiliyor', () => {
  assert.equal(typeof normalizeMonthFinancialFields, 'function');
  assert.equal(typeof normalizePersistentFinancialFields, 'function');
});

// ---------------------------------------------------------------------
// TEST A: string income/expenses/debtPayments toplama değil concatenation'a
// düşmemeli.
// ---------------------------------------------------------------------
test('TEST A: string tutarlar normalize sonrası number oluyor, concatenation olmuyor', () => {
  const month = normalizeMonthFinancialFields({
    incomes: [{ id: 'i1', category: 'Maaş', amount: '110000' }],
    expenses: [{ id: 'e1', category: 'Diğer', amount: '44067' }],
    goal: { type: 'save', amount: 0 },
  });
  assert.equal(typeof month.incomes[0].amount, 'number');
  assert.equal(typeof month.expenses[0].amount, 'number');
  const monthlyRemaining = month.incomes.reduce((s, i) => s + i.amount, 0)
    - month.expenses.reduce((s, e) => s + e.amount, 0);
  assert.equal(monthlyRemaining, 65933);
  assert.notEqual(monthlyRemaining, '11000044067'); // eski hatanın imzası
});

// ---------------------------------------------------------------------
// TEST B: iki gelir satırı - "5000" + "6000" = 11000, "50006000" DEĞİL.
// ---------------------------------------------------------------------
test('TEST B: iki string gelir satırı sayısal olarak toplanıyor', () => {
  const month = normalizeMonthFinancialFields({
    incomes: [
      { id: 'i1', category: 'Maaş', amount: '5000' },
      { id: 'i2', category: 'Kira', amount: '6000' },
    ],
    expenses: [],
  });
  const total = month.incomes.reduce((s, i) => s + i.amount, 0);
  assert.equal(total, 11000);
  assert.notEqual(String(total), '50006000');
});

// ---------------------------------------------------------------------
// TEST D: tam regresyon senaryosu (denetimde kullanılan aynı senaryo).
// ---------------------------------------------------------------------
test('TEST D: exact regression scenario (assets=500000 debt=243184 income=110000 exp=44067)', () => {
  const month = normalizeMonthFinancialFields({
    incomes: [{ id: 'i1', amount: 110000 }],
    expenses: [{ id: 'e1', amount: 44067 }],
  });
  const persistent = normalizePersistentFinancialFields({
    accounts: [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }],
    debts: [{ id: 'd1', category: 'Diğer', balance: 243184, minPayment: 0 }],
  });
  const income = month.incomes.reduce((s, i) => s + i.amount, 0);
  const expenses = month.expenses.reduce((s, e) => s + e.amount, 0);
  const assets = persistent.accounts.reduce((s, a) => s + a.balance, 0);
  const totalDebt = persistent.debts.reduce((s, d) => s + d.balance, 0);
  const remainingDays = 16;

  const netWorth = assets - totalDebt;
  const monthlyRemaining = income - expenses - 0;
  const savingsRate = (monthlyRemaining / income) * 100;
  const safeDailySpend = monthlyRemaining / remainingDays;

  assert.equal(netWorth, 256816);
  assert.equal(monthlyRemaining, 65933);
  assert.ok(Math.abs(savingsRate - 59.94) < 0.01, `savingsRate=${savingsRate}`);
  assert.ok(Math.abs(safeDailySpend - 4120.81) < 0.01, `safeDailySpend=${safeDailySpend}`);
});

// ---------------------------------------------------------------------
// TEST E: geçersiz değerler finans motoruna kontrolsüz sızmıyor.
// ---------------------------------------------------------------------
test('TEST E: geçersiz numeric değerler (""/null/undefined/"abc"/NaN/Infinity) 0’a düşüyor', () => {
  const invalidValues = ['', null, undefined, 'abc', NaN, Infinity, -Infinity];
  for (const v of invalidValues) {
    const month = normalizeMonthFinancialFields({
      incomes: [{ id: 'i1', amount: v }],
      expenses: [{ id: 'e1', amount: v }],
    });
    assert.equal(month.incomes[0].amount, 0, `income amount=${v} -> 0 olmalı`);
    assert.equal(month.expenses[0].amount, 0, `expense amount=${v} -> 0 olmalı`);
    assert.ok(Number.isFinite(month.incomes[0].amount), `income amount=${v} finite olmalı`);
  }
  // Aynı guard persistent tarafında da (accounts.balance, debts.balance, goals, kartlar…)
  const persistent = normalizePersistentFinancialFields({
    accounts: [{ id: 'a1', balance: 'abc' }],
    debts: [{ id: 'd1', balance: Infinity, minPayment: NaN }],
    goals: [{ id: 'g1', targetAmount: undefined, currentSaved: '' }],
    creditCards: [{ id: 'c1', currentBalance: 'garbage', limit: null }],
  });
  assert.equal(persistent.accounts[0].balance, 0);
  assert.ok(Number.isFinite(persistent.debts[0].balance));
  assert.equal(persistent.debts[0].balance, 0);
  assert.equal(persistent.debts[0].minPayment, 0);
  assert.equal(persistent.goals[0].targetAmount, 0);
  assert.equal(persistent.goals[0].currentSaved, 0);
  assert.equal(persistent.creditCards[0].currentBalance, 0);
  assert.equal(persistent.creditCards[0].limit, 0);
});

test('TEST E-ek: guvenliSayi TUTAR_UST_SINIR üzerindeki bozuk büyüklüğü de eler', () => {
  assert.equal(guvenliSayi(1e20), 0);
  assert.equal(guvenliSayi(Infinity), 0);
  assert.equal(guvenliSayi('50000'), 50000);
});

// ---------------------------------------------------------------------
// Eksik/bozuk dizi alanları çökertmemeli (array olmayan incomes/expenses vb.)
// ---------------------------------------------------------------------
test('eksik ya da dizi olmayan alanlar güvenli varsayılana düşüyor', () => {
  const month = normalizeMonthFinancialFields({ incomes: null, expenses: undefined });
  jsonEqual(month.incomes, []);
  jsonEqual(month.expenses, []);
  jsonEqual(month.goal, { type: 'save', amount: 0 });

  const persistent = normalizePersistentFinancialFields({ accounts: 'not-an-array', debts: null });
  jsonEqual(persistent.accounts, []);
  jsonEqual(persistent.debts, []);

  assert.equal(normalizeMonthFinancialFields(null).incomes.length, 0);
  assert.equal(normalizePersistentFinancialFields(null), null);
});

// ---------------------------------------------------------------------
// Geçerli/normal veri normalizasyondan hasarsız çıkmalı (regresyon: normal
// akış bozulmamalı).
// ---------------------------------------------------------------------
test('geçerli veri normalizasyondan değişmeden (tip hariç) çıkıyor', () => {
  const month = normalizeMonthFinancialFields({
    incomes: [{ id: 'i1', category: 'Maaş', amount: 50000, note: 'test', recurring: true, accountId: 'a1' }],
    expenses: [{ id: 'e1', category: 'Market', amount: 1200, fixed: true, cardId: 'c1' }],
    goal: { type: 'limit', amount: 5000 },
  });
  assert.equal(month.incomes[0].amount, 50000);
  assert.equal(month.incomes[0].category, 'Maaş');
  assert.equal(month.incomes[0].accountId, 'a1');
  assert.equal(month.expenses[0].fixed, true);
  assert.equal(month.expenses[0].cardId, 'c1');
  jsonEqual(month.goal, { type: 'limit', amount: 5000 });

  const persistent = normalizePersistentFinancialFields({
    accounts: [{ id: 'a1', name: 'Ana Hesap', type: 'Banka Hesabı', balance: 12345, currency: 'TRY' }],
    creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 4000, limit: 10000, minPayment: 500, rate: 4.25 }],
  });
  assert.equal(persistent.accounts[0].balance, 12345);
  assert.equal(persistent.creditCards[0].currentBalance, 4000);
  assert.equal(persistent.creditCards[0].limit, 10000);
});
