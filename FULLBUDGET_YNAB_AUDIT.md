# FullBudget — YNAB Ortak Özellik Audit Raporu

**Tarih:** 2026-09-21
**Kapsam:** Salt okunur kod/ürün denetimi. **Hiçbir kod değiştirilmedi.**
**Baz commit:** `ec27d6b` (decision-engine-v1)
**Dosya:** `app/index.html` (~20.900 satır, tek dosya SPA) + `app/test/*.mjs` (345 test, tümü yeşil)

---

## 1. Executive Summary

FullBudget'ın gelir/gider/kategori/aylık-plan/hedef/borç/kredi-kartı/geçmiş/ay-geçişi gibi YNAB ile ortak olan temel finans altyapısı **sağlam ve büyük ölçüde tek-kaynaklı (single source of truth)** kurulmuş durumda. Kod içinde, önceki fazlarda tam da bu tür double-counting/tutarsızlık hatalarını düzeltmek için yazılmış açıklayıcı yorumlar var (`buildMonthlySnapshot()`, `totalIncome()`/`totalSpent()` etrafında) — bu, ekibin zaten bu riskleri bildiğinin ve bir kısmını kapattığının kanıtı.

Buna rağmen denetimde **2 adet P0 (gerçek finansal doğruluk) bulgusu**, **5 adet P1 (tutarlılık/UX) bulgusu** ve **birkaç P2 (temizlik/polish) bulgusu** tespit edildi. Hiçbiri Decision Engine, Goal & Cash Allocation Engine, Protected Liquidity veya Distributable Cash'in kendi matematiğinde değil — hepsi bu motorların **etrafındaki** besleme/senkronizasyon noktalarında.

**"Günün Güvenli Harcama Alanı"** talep edildiği gibi bu raporda **DEFER / CURRENTLY REMOVED** kabul edilmiştir (bkz. Bölüm 9). Not: özellik şu an kodda hâlâ Home'un 6 sabit bölümünden biri olarak render ediliyor ve FAZ 3.20'de canonical motora bağlandı; bu rapor onu **kaldırmıyor**, yalnızca "kaldırılsaydı ne olurdu" sorusunu kanıta dayalı olarak yanıtlıyor (kullanıcı talebi buydu).

FullBudget'ın özgün mimarisi (Decision Engine, Allocation Engine, Protected Liquidity, Distributable Cash, Emergency Allocation Override, Sıradaki Adımım, Alabilir miyim?, Bunu atlarsam ne olur?, AI'ın hesap yapmaması) **bu denetimde önerilen hiçbir maddeyle değiştirilmiyor veya YNAB'a benzetilmiyor** — tüm öneriler bu mimariyi aynen koruyarak, sadece etrafındaki veri besleme noktalarını iyileştiriyor.

---

## 2. YNAB vs FullBudget Ortak Özellik Matrisi

| # | Alan | Sınıf | Not |
|---|---|---|---|
| 1 | Gelir (tek seferlik + recurring) | **A** | Ortak ve gerekli, mevcut, sağlam |
| 2 | Gider / işlem (transaction) | **A** | Ortak ve gerekli, mevcut, sağlam |
| 3 | Kategori (etiketleme/gruplama) | **A** | Ortak ve gerekli, mevcut |
| 3b | Kategori bazlı "Assigned/Activity/Available" (envelope bütçe) | **C** | YNAB'a özgü zero-based bütçeleme modeli — FullBudget'ın "bu ay paramla ne yapmalıyım" karar-destek mimarisiyle örtüşmüyor. **DO NOT ADD.** |
| 4 | Aylık plan (bir ayın gelir/gider/tahsis görünümü) | **A + B karışık** | Kavram olarak ortak (A); mekanizma (Decision Engine + Allocation waterfall) FullBudget'a özgü (B) — **motoru DEĞİL, kavramı** YNAB ile paylaşıyor |
| 5 | Planlı / yaklaşan ödemeler (reminders) | **A** | Ortak ve gerekli, mevcut — ama nakit akışı tahminine dahil değil (bkz. Bölüm 3.6, P1) |
| 6 | Hedefler | **A** | Ortak ve gerekli, mevcut — ama düzenlenemiyor (bkz. Bölüm 3.5, P0) |
| 7 | Borçlar | **A** | Ortak ve gerekli, mevcut, TR'ye uygun |
| 8 | Kredi kartları | **A** | Ortak ve gerekli, mevcut, TR'ye uygun (ekstre/kesim/son ödeme ayrımı zaten doğru) |
| 9 | Raporlar / geçmiş | **A** (sade haliyle) | Basit aylık özet + tek bir net-worth grafiği yeterli; genişletilmiş çoklu-grafik raporlama **C — DO NOT ADD** |
| 10 | Ay geçişi | **A** | Ortak ve gerekli — ama canlı tetiklenmiyor (bkz. Bölüm 3.9, P0) |

**C grubu (YNAB'da var, FullBudget'a şu an gereksiz)** — sırf YNAB'da var diye önerilmedi, her biri FullBudget'ın "bu ay paramla ne yapmalıyım" tek-soru mimarisiyle ya çelişiyor ya da gereksiz karmaşıklık ekliyor. Ayrıntı Bölüm 8'de.

---

## 3. Ortak Özellikler — Detaylı Analiz

### 3.1 Gelir

- **YNAB:** Gelir bir "işlem" olarak girilir, doğrudan "To Be Budgeted" havuzuna eklenir; kategori ataması gerektirmez.
- **FullBudget:** `month.incomes[]` — `{id, category, amount, note, recurring, accountId}` (`normalizeMonthFinancialFields`, index.html:5992-5995). Kategori sabit enum: Maaş/Kira/Diğer. **Tarih alanı yok** (kod içi yorum bunu açıkça belirtiyor, index.html:9827). Recurring gelirler `persistent.recurringIncomes` şablonlarından `runMonthlyAutomation()` ile ay başına bir kez, idempotent bir `lastAutoMonth` kilidiyle uygulanıyor (index.html:6544-6554).
- **Benzerlik:** Kavram olarak aynı; her ikisi de gelir kaydını doğrudan aylık akışa katıyor.
- **Fark:** FullBudget'ta gelirin tarihi yok (YNAB'da var). Bu, ay-içi zamanlama analizi gerektiren hiçbir hesaplamayı şu an etkilemiyor çünkü tüm gelir hesaplamaları aylık toplam (`totalIncome()`) üzerinden yapılıyor.
- **Risk:** Düşük. `totalIncome()` (index.html:6641) **tek kaynak** — grep'te tüm ~25 kullanım noktası bu fonksiyonu çağırıyor, ikinci bir "toplam gelir" hesaplaması bulunamadı.
- **Öneri: KEEP.** Tarih alanı eksikliği bugün hiçbir hesaplamayı bozmuyor; ileride "bu ay içinde ne zaman gelir bekleniyor" gibi bir özellik istenirse ayrı değerlendirilebilir (bu audit kapsamında önerilmiyor).

### 3.2 Gider / İşlemler

- **YNAB:** Her işlem bir kategoriye atanır ve o kategorinin "Activity"sini azaltır.
- **FullBudget:** `month.expenses[]` — `{id, category, subcategory, amount, note, date, fixed, recurring, accountId, cardId, installment, sourceType, catConfidence}` (index.html:5996-6002). Kategori sabit enum, 10 kalem. `fixed` ve `recurring` ayrı bayraklar (fixed = "sabit gider" etiketi, recurring = otomatik ay-başı tekrar şablonu). Ekleme/düzenleme/silme fonksiyonları mevcut (index.html:16029, 16006, 9815).
- **Benzerlik:** Kavram ve CRUD akışı ortak.
- **Fark:** Kategori başına bütçe/limit yok (bkz. 3.3). "Fixed" kavramı YNAB'ın recurring/scheduled ayrımından biraz farklı — burada sadece bir etiket, otomatik tekrar değil (otomatik tekrar `recurring` bayrağıyla ayrı).
- **Risk:** Düşük. `totalSpent()`/`totalFixedExpense()`/`totalVariableExpense()` (index.html:6643/6644/6678) her biri **tek yerde** tanımlı ve tüm tüketiciler (~15 çağrı noktası) bunları kullanıyor — ikinci bir "toplam gider" hesaplaması yok.
- **Küçük DRY notu (P2):** "Kalan sabit gider tahmini" (`remainingFixedEstimate = lastMonthFixed - fixedSpent`) mantığı iki ayrı yerde birebir kopyalanmış (index.html:9360-9362 ve 14668-14669). Bugün senkron ama tek fonksiyona çıkarılması ileride sapmayı önler.
- **Öneri: KEEP** (ana model); **IMPROVE (P2)** — remainingFixedEstimate'i tek fonksiyona çıkar (bkz. IP-6).

### 3.3 Kategoriler

- **YNAB:** Her kategori "Assigned / Activity / Available" üçlüsüyle bir mini-bütçe gibi davranır (zero-based budgeting).
- **FullBudget:** Kategoriler sadece **etiket** — `INCOME_CATEGORIES`/`CATEGORIES` sabit enum'ları (index.html:5098-5106), harcama gruplama/donut-chart için kullanılıyor (index.html:8123, 9658, 9911, 15274, 16828). Kategori başına "ne kadar ayrıldı / ne kadar harcandı / ne kadar kaldı" takibi **yok**. Kullanılmayan bir `persistent.categoryBudgets` alanı tanımlı ama grep'te başka hiçbir yerde okunmuyor/yazılmıyor (index.html:5456) — muhtemelen eski/atıl bir stub.
- **Benzerlik:** Etiketleme/gruplama ortak.
- **Fark:** Envelope bütçeleme modeli hiç yok — bu **kasıtlı bir mimari fark**, FullBudget'ın "toplam nakit akışı + öncelik motoru" yaklaşımıyla tutarlı.
- **Risk:** Yok (mevcut model kendi içinde tutarlı).
- **Öneri:**
  - Kategori bazlı **envelope bütçeleme (Assigned/Activity/Available)**: **DO NOT ADD** — FullBudget'ın tek-soru mimarisiyle çelişir, yeni bir "ikinci karar sistemi" yaratır.
  - Kategori bazlı **basit karşılaştırma raporu** ("bu ay vs geçen ay kategori kırılımı"): zaten toplanan `history[].categoryBreakdown` verisini (index.html:9654-9659) kullanarak **IMPROVE (P2)** olarak önerilir — yeni hesap motoru gerektirmez, sadece var olan veriyi başka bir görünümde gösterir (bkz. IP-8).
  - `persistent.categoryBudgets` atıl alanı: **DEFER** — şu an dokunmaya gerek yok, ne okunuyor ne yazılıyor, zararsız.

### 3.4 Aylık Plan (Decision Engine + Goal & Cash Allocation Engine)

- **YNAB:** Kullanıcı her kuruşu elle bir kategoriye atar ("Give Every Dollar a Job").
- **FullBudget:** `runDecisionEngineV2(snapshot)` (index.html:12586-12730) saf bir fonksiyon; `DECISION_STATUS` = NEEDS_MORE_DATA / NEGATIVE_CASH_FLOW / PROTECT_LIQUIDITY / DEBT_PRIORITY / GOAL_PRIORITY / SAFE_TO_ALLOCATE. Sonra `runGoalCashAllocationEngine(de2, snapshot)` (index.html:12825-13005) altı adımlı bir waterfall çalıştırıyor: ADIM1 obligation-context → ADIM2 emergency_fund_contribution (override burada devreye giriyor) → ADIM3 debt_reduction (avalanche) → ADIM4 goal_contribution → ADIM5/6 long_term_or_flexible (kalan).
- **Benzerlik:** "Ayın parasını nereye koyayım" sorusu ortak.
- **Fark:** FullBudget kullanıcıya elle atama yaptırmıyor, **otomatik öncelik sırasıyla** öneriyor — bu, ürünün özgün "karar destek" kimliği, YNAB'a benzetilmemeli.
- **Risk / bulgu:**
  - **Emergency Allocation Override doğru çalışıyor** — override sadece ADIM2'nin `amt` değerini değiştiriyor (`Math.max(0, Math.min(remaining, Number(override)))`, index.html:12879-12883), `emergencyTarget3`/`protectedCash`/`emergencyGap` HİÇ etkilenmiyor (index.html:12544-12561). Doğrulandı, test kapsamı var (EMERGENCY-OVERRIDE-01..08, 345/345 yeşil).
  - **Home vs Plan tutarlılığı:** `renderMonthlyPlanSummary()` (index.html:13114-13116, tek çağrı noktası, index.html:9640) hem Home özetini hem `#planDetailWrap` detayını AYNI `de2`/`result`'tan besliyor — burada duplikasyon yok.
  - **P1 bulgusu:** Motor bir render geçişinde 4 farklı yerden bağımsız çağrılıyor (ring hesabı index.html:9371, Plan kartı index.html:13116, Sıradaki Adımım'ın iki yardımcı fonksiyonu index.html:13676/13794) — her biri kendi `buildMonthlySnapshot()`'ını üretiyor. Fonksiyonlar saf olduğu için BUGÜN sorun yok, ama "bir kez hesapla, her yerde oku" paylaşımlı bir önbellek yok — ileride araya durum-değiştiren bir adım girerse ekranlar arası sapma riski oluşur. **İzlenecek liste maddesi, bugün bir hata değil.**
- **Öneri: KEEP** (motor mantığı — dokunulmayacak). **DEFER** (paylaşımlı önbellekleme — bugün gerek yok, riski not edildi).

### 3.5 Hedefler

- **YNAB:** Hedef ilerlemesi otomatik olarak kategori bakiyesinden hesaplanır.
- **FullBudget:** `persistent.goals[]` — `{id, typeKey, targetAmount, currentSaved, targetDate, ...}` (index.html:16162-16180). `computeGoalInfo()` (index.html:10942-11035) `gap = max(0, neededTotal - alreadySaved)` hesaplıyor. Özel tipler (`acilfon`, `borcsuz`, `networth`, `fire`) `alreadySaved`'i canlı toplamlardan (`totalLiquidAssets()`, `netWorth`, `totalDebtTL()`) okuyor — **doğru desen**. Ama sıradan hedefler (ev/araba/tatil/vb.) `currentSaved`'i kullanıcının **oluşturma anında bir kez elle girdiği, sonradan HİÇBİR şekilde düzenlenemeyen** bir alandan okuyor — kod genelinde bir "hedef düzenle" fonksiyonu (editingGoalId benzeri bir mekanizma) bulunamadı.
- **Benzerlik:** Hedef/gap/ilerleme kavramı ortak.
- **Fark:** YNAB'da kategori bakiyesi her zaman güncel; FullBudget'ta sıradan hedeflerin ilerlemesi donuk.
- **Risk — P0:** (a) Aynı fiziksel para birden fazla hedefe "biriktirdim" olarak girilebilir (double-count riski — hiçbir mekanizma `currentSaved` toplamını gerçek hesap bakiyesiyle çapraz kontrol etmiyor). (b) Kullanıcı parayı başka yere harcasa bile hedefin "biriktirilen" tutarı hiç güncellenmiyor — zamanla gerçek dışı bir ilerleme çubuğu gösterebilir. Bu hem bir doğruluk riski hem bir işlevsellik eksikliği (özellik pratikte "sil ve yeniden oluştur" dışında güncellenemiyor).
- **Öneri: FIX (P0)** — `currentSaved` için bir düzenleme akışı ekle (bkz. IP-2). **Yeni bir hedef motoru veya YNAB tarzı otomatik senkron ÖNERİLMİYOR** — sadece var olan tek alana bir edit UI'ı.

### 3.6 Scheduled / Upcoming Payments (Hatırlatıcılar)

- **YNAB:** Zamanlanmış işlemler otomatik olarak gerçek işleme dönüşür ve kategori bakiyesini günceller.
- **FullBudget:** `persistent.reminders[]` — `{id, title, type, recurring, dayOfMonth, specificDate, amount, note, doneMonths[]}` (index.html:19841). "Yapıldı" işaretlemek sadece `doneMonths`'a `monthKey` ekliyor — **hiçbir zaman** `month.expenses`'e bir kayıt oluşturmuyor. Doğrulandı: double-counting riski **yok**.
- **Benzerlik:** "Yaklaşan ödeme" listesi kavramı ortak.
- **Fark / Risk — P1:** Hatırlatıcı tutarları hiçbir nakit akışı tahminine dahil edilmiyor. `remainingFixedEstimate` (ay-sonu tahmini) sadece **geçmiş ayın ortalamasına** dayanıyor, kullanıcının elle girdiği "bu ay ödeyeceğim ₺X'lik yıllık sigorta" gibi bilinen, tarihli bir hatırlatıcıyı hiç görmüyor. Bu, "Alabilir miyim?" ve Decision Engine'in ay-sonu tahmininin bilinen büyük ödemeleri kaçırabileceği anlamına geliyor.
- **Öneri: DEFER.** Bunu düzeltmek Decision Engine/Allocation Engine'e **yeni bir girdi** eklemek anlamına gelir — bu audit'in "motoru değiştirme" yasağı kapsamında, bu aşamada bir implementation-plan maddesi ÖNERİLMİYOR. Sadece riskin farkında olunması öneriliyor; ileride ayrıca, kapsamı net şekilde onaylanarak ele alınmalı.

### 3.7 Borçlar / Kredi Kartları (Türkiye'ye özgü)

- **YNAB:** ABD kredi kartı modeli — "billing cycle end = due date" varsayımına yakın, statement/current balance ayrımı daha basit.
- **FullBudget:** `persistent.creditCards[]` — `{name, bankName, limit, currentBalance, statementDay, dueDay, minPayment, statementBalance, rate, currency, statementSettledCycle}` (index.html:16325-16337). Kod **açıkça ve kasıtlı olarak** `currentBalance` (kesim sonrası harcamalar dahil güncel toplam) ile `statementBalance` (son kesilen ekstre tutarı) ayrımı yapıyor (index.html:6866-6893, TR yorumlarla). `cardStatementSettled()` bir "ekstre dönemi kapandı" (grace period) modeli uyguluyor — ekstre sıfırlanınca faiz yanlışlıkla yeniden hesaplanmıyor. `monthlyDebtPayments()` gerçek loglanmış kart ödemesini varsa kullanıyor, yoksa `minPayment` tahminine düşüyor, ve `paymentIsEstimated` bayrağıyla bunu UI'da şeffaf gösteriyor (index.html:6724-6740, 6758).
- **Benzerlik:** Borç/kart takibi kavramı ortak.
- **Fark:** FullBudget'ın modeli **zaten Türkiye'ye uygun** — ABD tarzı bir varsayım kopyalanmamış, aksine bilinçli olarak TR ekstre/kesim/son-ödeme mantığı kurulmuş (yorumlarda geçmiş bir bug'ın düzeltildiği bile belirtiliyor: "1.000 USD borç toplam borca hiç girmiyordu").
- **Risk:** Düşük. Asgari ödeme (asgari ödeme tutarı) otomatik hesaplanmıyor, kullanıcı elle giriyor — bu bir hata değil, bilinçli bir sınır.
- **Öneri: KEEP.** Bu alan zaten iyi durumda; **ABD kredi kartı mantığı kopyalanmasın** talimatı zaten karşılanmış durumda, ek bir değişiklik gerekmiyor.

### 3.8 Reports / History (Geçmiş)

- **YNAB:** Onlarca grafik/rapor türü (age of money, spending by category over time, net worth trend, vb.).
- **FullBudget:** `history[]` — ay başına tek bir düz özet kaydı `{monthKey, income, expense, fixedExpense, debtPayment, totalDebt, assets, netWorth, savingsRate, investAssets, categoryBreakdown}` (index.html:9654-9659), 18 ay ile sınırlı, upsert-by-monthKey. Tek bir el-yapımı SVG net-worth grafiği (index.html:15342-15425) — harici kütüphane yok.
- **Benzerlik:** "Geçmişe bak" kavramı ortak.
- **Risk — P1 (küçük, kendi kendini onaran):** `history`'nin 400ms'lik debounce yazımı (index.html:6578), `month`/`persistent`'in 250ms'lik yazımını kapatma-öncesi güvence altına alan `flushPendingPersistence()`'a (index.html:6440-6456) DAHİL DEĞİL. Sekme, bir düzenlemeden sonraki 400ms içinde kapatılırsa "Geçmiş" ekranındaki o ayın özeti bir sonraki düzenlemeye kadar bayat kalabilir. **Gerçek finansal veri (month/persistent) etkilenmiyor** — sadece geçmiş görünümü.
- **Öneri: KEEP** (mevcut sade model — yeni grafik/rapor **DO NOT ADD**). **FIX (P1)** — history flush'ını güvenlik ağına dahil et (bkz. IP-5).

### 3.9 Ay Geçişi

- **YNAB:** Ay değişimi uygulama tarafından (genelde sunucu/cihaz saatiyle) sürekli takip edilir.
- **FullBudget:** **Kritik bulgu —** `now`/`monthKey` **sadece script yüklenirken bir kez** hesaplanıyor (`const now = new Date()`, `const monthKey = ...`, index.html:5349-5350). Dosyada hiçbir `setInterval`/gece-yarısı kontrolü yok. Ay geçişi yalnızca **bir sonraki tam sayfa yüklemesinde** gerçekleşiyor — `loadState()` yeni `monthKey` için depodan okuyor, `runMonthlyAutomation()` (recurring gelir/gider ekleme) ve `emergencyAllocationOverride`'ın sıfırlanması da ancak o yüklemede oluyor.
- **Benzerlik:** Ay bazlı state kavramı ortak; geçiş MEKANİZMASI eksik.
- **Risk — P0:** Kullanıcı uygulamayı (özellikle PWA olarak) sekme/pencere kapatmadan gece yarısını geçecek şekilde açık bırakırsa, yeni girdiği işlemler **yanlış (eski) aya** yazılmaya devam eder — bu doğrudan "ay geçişinde finansal tutarsızlık" ve "yanlış bakiye" riski, kullanıcının istemi P0 kriterlerine tam uyuyor.
- **Doğrulanan iyi haber:** Hedeflerin/borçların taşınması (`persistent` içinde, hiç sıfırlanmıyor) ve `emergencyAllocationOverride`'ın YENİ aya taşınmaması (index.html:5455, 16792, ve `normalizeMonthFinancialFields`'in null'a zorlaması) doğru çalışıyor — mevcut `EMERGENCY-OVERRIDE-04` testi bunu zaten doğruluyor.
- **Öneri: FIX (P0)** — sayfa açıkken gerçek ay değişimini yakalayan hafif bir kontrol ekle (bkz. IP-1). **Yeni bir "month engine" veya persistence modeli ÖNERİLMİYOR** — sadece var olan `loadState()`/`runMonthlyAutomation()` mekanizmasının ne zaman tetikleneceğini düzeltiyor.

---

## 4. Kod / Data-Flow Bulguları (Özet)

- **Tek kaynak prensibi BÜYÜK ÖLÇÜDE uygulanıyor:** `totalIncome()`, `totalSpent()`, `totalFixedExpense()`, `totalVariableExpense()`, `getAffordCapacityInfo()`, `buildMonthlySnapshot()` her biri kendi alanında tek kaynak; kod yorumları bunun bilinçli bir "denetim kuralı" olduğunu gösteriyor.
- **İki bağımsız acil-fon formülü tespit edildi (P1):** `getAffordCapacityInfo()`'nun `emergencyGap/emergencyReserve` hesabı (canonical, GCAE'nin kullandığı) ile "Sıradaki Adımım"ın hangi adımı göstereceğini seçen `computePriorityPlan`/`_planKur`'un KENDİ acil-fon formülü (`estimateMonthlyEssential()*3 - totalLiquidAssets()`) farklı. Sonradan tutar/gerekçe canonical sonuçla üzerine yazılıyor (patch) — kod yorumları (FAZ 3.3/3.9/3.10/3.11) bu ikiliğin geçmişte en az bir gerçek tutarsızlık bug'ına yol açtığını belgeliyor. Bugün testler yeşil ama **yapısal kırılganlık** olarak işaretleniyor.
- **"Alabilir miyim?" bağımsız formülü (P1):** `getAffordCapacityInfo()`/`assessCardAffordability()` Decision Engine'i hiç çağırmıyor; kendi `safeMonthlyCapacity`'sini hesaplıyor. Yön: AffordCapacityInfo → buildMonthlySnapshot → Decision Engine (ters değil) — yani "Alabilir miyim?" canonical akışın YUKARISINDA, ama kendi son-adım formülü GCAE'nin `distributableCash`'ini tekrar kullanmıyor.
- **Ölü kod (P2):** `safeDaily` parametresi `guncelleKararOzeti()` (index.html:13305) ve `renderTop5()`'e (index.html:15481) geçiriliyor ama gövdelerinde hiç okunmuyor.
- **Persistence:** `FullBudgetDataService` tek depolama cephesi; `month`/`persistent` 250ms debounce + kapatma-öncesi flush; `history` 400ms debounce, flush'a dahil değil (yukarıda 3.8).
- **Ay geçişi:** Yukarıda 3.9 — en önemli bulgu.

---

## 5. P0 / P1 / P2 Listesi

**P0 — Gerçek finansal veri/hesaplama riski**
1. Ay geçişi canlı tetiklenmiyor (`const monthKey`, index.html:5349-5350) → yanlış aya işlem yazılma riski.
2. Hedeflerde `currentSaved` düzenlenemiyor + gerçek bakiyeden kopuk → double-count / donuk ilerleme riski (index.html:16162-16180).

**P1 — Önemli tutarlılık/UX sorunları**
3. "Alabilir miyim?" kendi bağımsız `safeMonthlyCapacity` formülünü kullanıyor, GCAE'nin `distributableCash`'iyle doğrudan hizalı değil.
4. "Sıradaki Adımım"ın adım-seçim mantığı (`_planKur`) canonical'dan bağımsız kendi acil-fon formülünü çalıştırıyor (patch-sonrası düzeltiliyor ama yapısal kırılgan).
5. Hatırlatıcı/planlı ödemeler hiçbir nakit-akışı tahminine dahil değil.
6. `history`'nin 400ms debounce yazımı kapatma-öncesi flush güvencesine dahil değil.
7. Motor bir render geçişinde 4 yerden bağımsız yeniden çağrılıyor — bugün güvenli (saf fonksiyonlar), ama paylaşımlı önbellek yok.

**P2 — Küçük UX/copy/temizlik**
8. `remainingFixedEstimate` mantığı iki yerde kopyalanmış.
9. `safeDaily` ölü parametreler (`guncelleKararOzeti`, `renderTop5`).
10. `persistent.categoryBudgets` kullanılmayan/atıl alan.
11. Kategori bazlı basit "bu ay vs geçen ay" karşılaştırması eklenebilir (zaten toplanan veriyle).

---

## 6. Implementation Plan (ONAY BEKLİYOR — HENÜZ UYGULANMADI)

Aşağıdaki maddelerin hiçbiri bu audit sırasında uygulanmadı. Onayınızdan sonra **her biri ayrı, küçük, izole, testli, commit'li ve geri alınabilir bir bundle** olarak tek tek teslim edilecek.

| # | Öncelik | Dosya | Fonksiyon | Değişiklik | Risk | Test | Rollback |
|---|---|---|---|---|---|---|---|
| IP-1 | P0 | app/index.html | yeni `checkMonthRollover()` + mevcut visibilitychange handler | Sayfa açıkken gerçek ay değişimini tespit et, değiştiyse mevcut `loadState()`/`runMonthlyAutomation()`'ı (YENİDEN YAZMADAN) tetikle | Düşük-orta (yanlış tetiklenirse gereksiz reload; idempotent guard zaten var) | Sahte sistem saati ileri alıp visibilitychange tetikleyerek yeni monthKey'e geçişi doğrulayan yeni regression testi | Tek fonksiyon + event-listener'ı kaldırmak yeterli, hiçbir formülü değiştirmiyor |
| IP-2 | P0 | app/index.html | yeni `editGoalCurrentSaved(goalId, newValue)` + hedef kartına küçük "düzenle" | Var olan TEK alana (currentSaved) bir edit UI'ı — yeni hedef motoru yok | Düşük (computeGoalInfo zaten bu alanı okuyor) | currentSaved güncellendiğinde gap'in doğru yeniden hesaplandığını doğrulayan yeni regression testi | Fonksiyon + UI elemanını kaldırmak yeterli |
| IP-3 | P1 | app/index.html | `assessCardAffordability`/afford-teaser render bloğu | "Alabilir miyim?" ve Plan kartı farklı sorulara cevap verdiğini açıklayan bir UX notu (SADECE metin, hesap değişmiyor) | Çok düşük | Mevcut afford-teaser testine bir metin kontrolü eklenir | Metin bloğunu kaldırmak yeterli |
| IP-4 | P1 | — | — | **DEFER** — hatırlatıcıları nakit-akışı tahminine dahil etmek Decision Engine'e yeni girdi eklemek demek, bu audit kapsamında önerilmiyor | — | — | — |
| IP-5 | P1 | app/index.html | `scheduleHistorySave()`, `flushPendingPersistence()` | `history` için de bir `_historyDirty` bayrağı + flush — mevcut 250ms deseninin birebir aynısı | Düşük | Edit + hemen sayfa gizle/kapat simülasyonu + history'nin doğru yazıldığını doğrulayan yeni regression testi | Eklenen bayrak/çağrıyı kaldırmak yeterli |
| IP-6 | P2 | app/index.html | yeni `computeRemainingFixedEstimate()` | İki kopyalanmış hesap bloğunu tek fonksiyona çıkar (saf refactor, davranış aynı kalmalı) | Çok düşük | Mevcut testler zaten bu değeri dolaylı kontrol ediyor; davranış-eşitliği doğrulanır | Fonksiyonu eski iki satırla değiştirmek |
| IP-7 | P2 | app/index.html | `guncelleKararOzeti`, `renderTop5` | Kullanılmayan `safeDaily` parametrelerini kaldır | Çok düşük | Mevcut suite'in yeşil kalması yeterli kanıt | Parametreyi geri eklemek |
| IP-8 | P2 | app/index.html | `renderHistory()` civarı | Var olan `history[].categoryBreakdown` ile "bu ay vs geçen ay kategori kırılımı" satırı ekle (yeni hesap yok) | Düşük | Yeni bir UI regression testi | Eklenen bloğu kaldırmak yeterli |

---

## 7. "DO NOT TOUCH" Alanları

- `runDecisionEngineV2()` (Strategist) — mantık/durum makinesi
- `runGoalCashAllocationEngine()` (Executor) — waterfall sırası ve her adımın hesabı
- Protected Liquidity hesaplama mantığı
- Distributable Cash hesaplama mantığı
- Emergency Allocation Override mekanizması (kaldırılmayacak; yalnızca onaylanan izole iyileştirmeler mümkün)
- "Alabilir miyim?" özelliğinin varlığı
- "Sıradaki Adımım" özelliğinin varlığı
- "Bunu atlarsam ne olur?" özelliğinin varlığı
- AI'ın deterministic sonuçları hesaplamadan sadece açıklaması ilkesi
- `package-lock.json`
- Mevcut testler (silinmeyecek/anlamı değiştirilmeyecek; yalnızca onaylı bir spec değişikliği gerektiriyorsa güncellenir — FAZ 3.20/Emergency Override'da olduğu gibi)
- "Günün Güvenli Harcama Alanı"nın yeniden geliştirilmesi, hesaplamasının iyileştirilmesi veya yerine yeni bir günlük harcama sistemi kurulması

## 8. "DO NOT ADD" Alanları

- Kategori bazlı "Assigned / Activity / Available" envelope bütçeleme (zero-based budgeting)
- "Her kuruşa görev ver" (Give Every Dollar a Job) zorunluluğu / akışı
- YNAB tarzı otomatik banka senkronizasyonu/işlem içe aktarma genişletmesi (mevcut manuel/quick-add mimarisiyle uyumsuz, ayrı bir proje)
- Genişletilmiş çoklu-grafik raporlama paneli (age of money, ekstra trend grafikleri vb.)
- Kredi kartı harcamasını otomatik olarak bir kategoriden düşürme zorunluluğu (YNAB'ın "kart borcu = kategori borcu" mantığı) — FullBudget'ın kart/borç modeliyle uyumsuz
- "Günün Güvenli Harcama Alanı" yerine yeni bir daily-spending/age-of-money metriği

## 9. "Günün Güvenli Harcama Alanı" — Bağımlılık / Yan Etki Kontrolü

**Mevcut durum:** Özellik şu an KALDIRILMAMIŞ — Home'un 6 sabit bölümünden biri (`data-section="ring"`, index.html:2762), FAZ 3.20'de canonical `long_term_or_flexible` havuzuna bağlandı (`getCanonicalFreeSpendingPoolTL`/`computeSafeDailySpendTempo`, index.html:13034-13051, hesap bloğu index.html:9365-9378). Bu rapor onu kaldırmıyor; talep edilen "hipotetik kaldırma etki analizi"ni aşağıda veriyor.

**Diğer hesaplamalara etkisi — DÜŞÜK RİSK:**
- `safeDaily`/`safeRemaining` (ring'in kendi çıktıları) hiçbir Decision Engine, Allocation Engine, Alabilir-miyim, Sıradaki-Adımım veya yıl-sonu tahmini hesabına **girdi olarak** kullanılmıyor — saf bir "yaprak" (leaf) görüntüleme özelliği. `guncelleKararOzeti()`/`renderTop5()`'e parametre olarak geçiyor ama ikisi de bu parametreyi hiç okumuyor (ölü parametre, P2 bkz. Bölüm 4).
- Yıl-sonu net-worth tahmini AYRI ve BAĞIMSIZ bir formül kullanıyor (`restOfMonthCashFlowEstimate`, eski `computeCashFlowSummary()` yolu, index.html:9355-9363) — ring kaldırılsa bu tahmin ETKİLENMEZ.
- AI Coach (`answerHowMuchCanISpend()`, index.html:14663-14679) zaten kendi eski formülünü kullanıyor, ring'den bağımsız (belgeli, kasıtlı, test edilmiş bir ayrışma) — ring kaldırılsa Coach ETKİLENMEZ.
- Ring markup/id'leri (`dailyAmountNum`, `ringProgress`) sadece Home'da, başka hiçbir ekranda tekrar kullanılmıyor.

**Test / bakım yükü — YÜKSEK:**
- 7 test dosyasında ring'e doğrudan/dolaylı referans veren **~55+ test** tespit edildi: `faz3-20-safe-spending-semantics.regression.test.mjs` (12 test, en yoğun bağımlılık), `faz3-5-home-simplify.regression.test.mjs`, `faz3-6-plan-detail-simplify.regression.test.mjs`, `financial-truth.regression.test.mjs`, `emergency-allocation-override.regression.test.mjs` (EMERGENCY-OVERRIDE-07), `faz3-15-home-desktop-width.regression.test.mjs`, `faz3-10-next-step-semantics.regression.test.mjs`.
- Bunlardan **en az 3 tanesi** ("FAZ3.20-11", "FAZ3.5-8", "FAZ3.15-1") Home'un **tam olarak 6 bölüm ve sırası** olduğunu doğrudan doğruluyor — ring bölümü DOM'dan kaldırılırsa bu testler **kesin olarak kırılır** ve yeniden yazılmaları (silinmeleri değil) gerekir.

**Sonuç:** Ring'i hipotetik olarak kaldırmak **hesaplama açısından güvenli** (hiçbir şey ona bağımlı değil), ama **Home'un sabit 6-bölüm sözleşmesini** değiştirmeyi ve ~55 testin gözden geçirilmesini gerektiren, kapsamlı bir ayrı karar olurdu. Bu audit kapsamında böyle bir değişiklik **önerilmiyor ve yapılmıyor** — özellik olduğu gibi, DEFER/CURRENTLY REMOVED (analiz amaçlı) kabul edilerek bırakılıyor.

---

*Bu rapor tamamen salt-okunur bir denetimdir. Hiçbir dosya değiştirilmedi, hiçbir commit oluşturulmadı. Onayınız sonrası Bölüm 6'daki maddeler tek tek, küçük ve geri alınabilir bundle'lar halinde uygulanacaktır.*
