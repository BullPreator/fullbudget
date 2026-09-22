# FullBudget — Product Voice + UX Consistency Audit (Home Screen)

**Scope:** `app/index.html`, Home tab (`data-tab="home"`) only, current working tree (baseline: commit `da57a8a`, plus the uncommitted, verified 361/361-passing "Bu ay ayıracağım" mini-card work).
**Method:** static reading of Home's HTML/CSS/JS render chain (`render()` → `renderMonthlyPlanSummary()` / `renderMoneyTaskCard()` / `renderAlertSummaryHtml()` / `renderAffordTeaser()`), grep-based evidence gathering, and Playwright screenshots (light + dark theme) for visual claims. **No code was changed. No commit or push was made.**

**Naming note:** the repository already has a completed phase named "FAZ 3.13 — Ürün Sesi + UX Tutarlılığı" (see `app/test/faz3-13-product-voice.regression.test.mjs`), which removed the "kişiselleştirilmiş öneriler" tagline, the "En iyi karar" label, and the BLUEPRINT/MOMENTUM/PRESTIGE jargon. This audit reuses the same theme name at the user's request but is a **new, current-state review** — it does not re-litigate anything that file already covers, and every finding below is evidence-based against the code as it stands today, including the not-yet-committed monthly-allocation-decision card.

---

## 1. Product Voice

### PV-1 — "Anladım" button quietly records a tracked "completion", not a mere acknowledgment
- **Current behavior:** the "Sıradaki Adımım" card's primary button is labeled `Anladım` ("Got it" / "I understand" — `t('gorev-btn-tamamla')`). Clicking it calls `completeMoneyTask()`, which sets `rec.task.status = 'completed'`, persists a `completedAt` timestamp, and increments `persistent.moneyTaskStats.completedCount` (a stat surfaced elsewhere as "Bu ayki finansal ilerlemen").
- **Evidence:** label — `app/index.html:4687` (`'gorev-btn-tamamla': {tr:'Anladım', en:'Got it'}`); handler wiring — `app/index.html:14120-14123`; effect — `app/index.html:14003-14018` (`completeMoneyTask`).
- **User impact:** "Anladım" reads as passive acknowledgment ("okudum/anladım"), but the action it triggers is an active, persisted self-report that the financial step was actually done, counted toward a progress statistic. A user who taps it just to dismiss the card (without having actually set money aside) has their progress count silently incremented.
- **Severity:** Medium.
- **Recommended direction:** rename the primary action to something that names the actual effect (e.g. "Yaptım" / "I did this"), or split "acknowledge/dismiss" from "mark as done" into two distinct affordances. The existing same-day "Geri al" (undo) already mitigates the worst case, so this is a clarity fix, not a safety-critical one.
- **Code change necessary:** Yes (copy + possibly one extra control) — not implemented per instructions.

### PV-2 — Home-screen copy is otherwise consistent with "decision support, not advice"
- **Current behavior:** every hedged/decision-support phrase checked on Home ("Bu ayki nakit durumuna göre tutarı değiştirebilirsin.", "açığını tamamen kapatabilirsin", "Bu tutar planlamana açık — nasıl değerlendireceğine sen karar verirsin") uses conditional, user-controlled language, never an imperative or a guarantee. No occurrence of "garanti", "kesinlikle", "mutlaka", or "en iyi karar" was found in any Home-rendering function.
- **Evidence:** `app/index.html:13176-13181` (priority labels), `renderMonthlyAllocationDecision` (`app/index.html:13293-13327`), `getFinancialAlerts` tooltips (`app/index.html:7748-7893`).
- **User impact:** positive — no correction needed.
- **Severity:** N/A (informational; no finding).
- **Recommended direction:** none.
- **Code change necessary:** No.

---

## 2. UX Hierarchy

### UX-1 — The same emergency-fund figure is shown three times in immediate succession
- **Current behavior:** inside the single "Bu Ayki Planım" card, in order: (1) `renderMonthlyPlanSummary()` prints `Acil durum fonuna ayır ₺60.000`, (2) immediately below it, the engine's own `reason` sentence repeats the figure ("Acil durum fonun ₺60.000 eksikti. Bu ay ₺60.000 ayırarak açığını tamamen kapatabilirsin."), (3) immediately below that, the new "Bu ay ayıracağım" mini-card shows the identical ₺60.000 again, this time as the editable input's starting value.
- **Evidence:** `app/index.html:13173-13183` (hero-row + `top.reason` paragraph) directly followed by `app/index.html:13309-13321` (`renderMonthlyAllocationDecision`'s markup); confirmed visually in the mobile/desktop screenshots produced during the prior task (`home-mobile-scrolled.png`, `home-mobile-overridden.png`).
- **User impact:** on first view (before any override), a user reads the same number three times in about four lines of text before reaching the one interactive element that matters. This dilutes the "this is now a clear decision surface" goal the mini-card was built for — the redundancy was exactly the kind of problem FAZ 3.1/3.6 previously fixed for *different* numbers on this same card, and it has reappeared here for the *same* number.
- **Severity:** Medium.
- **Recommended direction:** either drop the engine `reason` sentence when its content is now fully re-stated by the mini-card immediately below (only for the `emergency_fund_contribution` case), or shorten the top hero-row to omit the amount and let the mini-card be the single place the number lives. Financial content of `reason` must stay available via "Detayları gör" if removed from the collapsed view.
- **Code change necessary:** Yes — not implemented per instructions.

### UX-2 — Info-badge tap targets are below common mobile minimums
- **Current behavior:** `.info-badge` (used for the net-worth liquidity badge on Home, and for every alert severity badge) is fixed at `18px × 18px`.
- **Evidence:** `app/index.html:648-655`.
- **User impact:** 18px is well under the ~24–44px touch-target guidance most mobile design systems (including iOS HIG and WCAG 2.5.5) recommend; on a real device this is a small, fiddly tap target, especially for the liquidity badge sitting right next to large numerals.
- **Severity:** Medium (accessibility/mobile usability, not a functional break).
- **Recommended direction:** increase the visual hit area via padding or a transparent hit-slop (`::before` with a larger invisible box), without changing the visible 18px glyph if the smaller glyph is intentional.
- **Code change necessary:** Yes — not implemented per instructions.

### UX-3 — Detail breakdown (Hedef/Korunan nakit/Kalan ihtiyaç) still requires an extra tap for the same decision the new mini-card surfaces
- **Current behavior:** the mini-card lets the user change the emergency-fund amount, but the *why* (target, protected cash, remaining need) that would justify a given number is still one tap away behind "Detayları gör" (`renderPlanPriorityGap`, `app/index.html:13228+`).
- **Evidence:** HTML comment at `app/index.html:13270-13274` and the `#planPriorityGap` markup.
- **User impact:** this is a legitimate, deliberate scope boundary (the current task was explicitly UI-only for the input, not a re-architecture of the detail card) rather than a defect, but it does mean the newly prominent decision still lacks its immediate justification. Worth a conscious call, not a silent gap.
- **Severity:** Low.
- **Recommended direction:** consider surfacing the single most relevant breakdown line (e.g. "Kalan ihtiyaç: ₺X") inside or directly under the mini-card, without duplicating the full three-line breakdown.
- **Code change necessary:** Only if the recommendation above is adopted.

---

## 3. Consistency

### CO-1 — New mini-card's border radius doesn't follow the app's own "nested element" convention
- **Current behavior:** `.money-decision-card` uses `border-radius:var(--r-lg)` (16px) — the same token used by top-level `.card`/`.card-featured`. Every other "raised panel nested inside a card" component in the codebase (`.amount-lead`, `.stat`, `.money-task-impact`) uses `var(--r-md)` (12px) instead.
- **Evidence:** `app/index.html:1077-1078` vs. `app/index.html:1060-1061` (`.amount-lead`), `385` (`.stat`), `349` (`.money-task-impact`).
- **User impact:** subtle — the new mini-card's corners read very slightly "flatter/larger" than sibling nested elements at the same visual depth, a small but real deviation from the app's established radius hierarchy (top-level = `r-lg`, nested = `r-md`).
- **Severity:** Low.
- **Recommended direction:** change `.money-decision-card` to `border-radius:var(--r-md)` to match nested-element convention.
- **Code change necessary:** Yes (one CSS property) — not implemented per instructions.

### CO-2 — Identical icon used for two different featured sections
- **Current behavior:** the exact same lightning-bolt SVG path (`M13 2L3 14h7l-1 8 11-14h-7z`) is used as the section icon for both "Sıradaki Adımım" and "Bu Ayki Planım" — the two most important, visually "featured" cards on Home.
- **Evidence:** `app/index.html:2756` and `app/index.html:2784`.
- **User impact:** reduces the icon's usefulness as a quick visual differentiator between "what to do right now" and "this month's overall plan" — a user skimming icons alone cannot tell the two sections apart.
- **Severity:** Low.
- **Recommended direction:** give "Bu Ayki Planım" a distinct icon (e.g. a calendar/chart glyph already used elsewhere in the app, such as the one on "Finansal Durum").
- **Code change necessary:** Yes (icon swap only) — not implemented per instructions.

### CO-3 — Reorder-button accessibility labels are Turkish-only regardless of app language
- **Current behavior:** all 52 section reorder buttons (up/down, one pair per Home section) carry a hardcoded `aria-label="Yukarı taşı"` / `aria-label="Aşağı taşı"`, with no `data-i18n-aria` attribute and no JS-side translation, unlike other icon-only controls in the app (e.g. the mic button uses `data-i18n-aria="aria-sesle-ekle"`).
- **Evidence:** `grep -c 'aria-label="Yukarı taşı"' app/index.html` → 52 matches; example at `app/index.html:2705`.
- **User impact:** an English-mode screen-reader user hears Turkish labels for every reorder control on every Home section — a real, if narrow, EN-mode consistency and accessibility gap. Sighted users are unaffected (icons are directional arrows).
- **Severity:** Low.
- **Recommended direction:** add `data-i18n-aria` entries for "move up"/"move down" and apply the app's existing i18n-aria mechanism at render time.
- **Code change necessary:** Yes — not implemented per instructions.

### CO-4 — Mobile and desktop layout behave consistently for the audited components
- **Current behavior:** the "Bu Ayki Planım" card (including the new mini-card), "Sıradaki Adımım", "Bugün Bilmen Gerekenler" and "Alabilir miyim?" were checked at 360px, 390px and 1440px widths; no horizontal overflow, no clipped text, and no control that only works at one breakpoint was found.
- **Evidence:** screenshots from the prior verification round (`home-mobile-scrolled.png`, `home-desktop-scrolled.png`, `home-narrow-360.png`) plus `scrollWidth === clientWidth` checks at all three widths.
- **Severity:** N/A (informational; no finding).
- **Code change necessary:** No.

---

## 4. Trust & Safety

### TS-1 — No investment-advice or certainty language found in Home-screen copy
- **Current behavior:** a targeted search for `garanti`, `kesinlikle`, `mutlaka`, `tavsiye ederim/ederiz`, and `en iyi karar` across the file found no matches inside any Home-rendering function; the matches that do exist are all in the Investing tab / monthly report / AI Coach copy, already carrying the app's standard "bu bir senaryodur/varsayımdır, garanti değildir" disclaimers (consistent with the pre-existing FAZ3.13/FAZ3.17 disclaimer work, which this audit did not need to touch).
- **Evidence:** grep results across `app/index.html` for the terms above; all Home-specific copy reviewed in Sections 1–3 above.
- **User impact:** positive — Home communicates amounts and priorities as calculated, conditional figures ("ayırabilirsin", "değiştirebilirsin", "senin tercihin"), not directives or guarantees.
- **Severity:** N/A (informational; no finding).
- **Recommended direction:** none required. Cross-reference PV-1 above as the one borderline case where an action's *label* (not its financial content) could be read as understating what the click actually records.
- **Code change necessary:** No.

---

## 5. Regression Safety

### RS-1 — The new "Bu ay ayıracağım" mini-card loses most of its visual separation in dark theme
- **Current behavior:** the mini-card's "raised panel" effect (white `--surface` + `--brand-ring` border against the parent's green-tinted `--brand-soft` background) was designed and verified only in light theme. In dark theme, `--surface` (`#121A18`) and the parent's `--brand-soft` (`rgba(0,201,149,0.10)` over the page background) render as two very similar dark tones, and `--brand-ring` (`rgba(0,201,149,0.32)`) is a low-contrast border on a dark background — the card is visually much harder to distinguish from its parent than the light-theme screenshots show.
- **Evidence:** token values at `app/index.html:118-124`; screenshot taken with `data-theme="dark"` this session (`home-dark-scrolled.png`) shows the mini-card's border and background nearly merging with the surrounding "Bu Ayki Planım" card, compared to the clear light-mode separation in `home-mobile-scrolled.png`.
- **User impact:** dark-theme users (the app explicitly supports dark theme, even though it states light is the "ana dil"/primary language) get a visibly weaker version of the exact UX improvement ("bu alan görünür olacak, önemli hissedilecek") this feature was built to deliver. This is a visual-only issue — no data, calculation, or event-handling risk.
- **Severity:** Medium.
- **Recommended direction:** give `.money-decision-card` a dark-theme-specific treatment (e.g. a lighter `background:var(--surface-2)` and/or a brighter border color under `html[data-theme="dark"]`) so the "raised panel" reads clearly in both themes, consistent with the artifact-design principle of designing both themes explicitly rather than assuming one token set works everywhere.
- **Code change necessary:** Yes (dark-theme CSS override) — not implemented per instructions.

### RS-2 — No rendering/event-handling/financial-calculation risk identified from this audit's own findings
- **Current behavior:** every finding above (PV-1, UX-1, UX-2, UX-3, CO-1, CO-2, CO-3, RS-1) is copy, icon, spacing, radius, or theme-contrast only. None touches `runDecisionEngineV2`, `runGoalCashAllocationEngine`, `setEmergencyAllocationOverride`'s parsing, `attachThousandsInput`, or any event listener wiring verified in the prior task's evidence package (361/361 tests passing, 14 protected functions byte-identical to `HEAD`).
- **Evidence:** cross-reference to the prior verification round's `git diff` and protected-function comparison.
- **User impact:** none — implementing any of the recommendations above, if approved, would be a pure presentation-layer change with no expected interaction with the financial engines, but each should still be re-run through the full regression suite before being considered done, per the project's existing "verify, then report" convention.
- **Severity:** N/A (informational; scoping note for future implementation work).
- **Code change necessary:** No (this entry documents a safety check, not a defect).

---

## Summary table

| ID | Category | Severity | Code change needed |
|---|---|---|---|
| PV-1 | Product Voice | Medium | Yes |
| PV-2 | Product Voice | — (clean) | No |
| UX-1 | UX Hierarchy | Medium | Yes |
| UX-2 | UX Hierarchy | Medium | Yes |
| UX-3 | UX Hierarchy | Low | Only if adopted |
| CO-1 | Consistency | Low | Yes |
| CO-2 | Consistency | Low | Yes |
| CO-3 | Consistency | Low | Yes |
| CO-4 | Consistency | — (clean) | No |
| TS-1 | Trust & Safety | — (clean) | No |
| RS-1 | Regression Safety | Medium | Yes |
| RS-2 | Regression Safety | — (scoping note) | No |

No implementation has been made for any finding above. No commit or push was performed. The working tree remains exactly as it was at the end of the previous task (`app/index.html` and `app/test/emergency-allocation-override.regression.test.mjs` modified, 361/361 tests passing).
