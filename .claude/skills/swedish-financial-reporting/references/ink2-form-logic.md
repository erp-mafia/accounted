# INK2 Form Logic

## Table of Contents
1. INK2 form structure
2. Data flow
3. INK2R field mappings (BAS → SRU → INK2)
4. INK2S skattemässiga justeringar
5. Periodiseringsfond in INK2
6. Överavskrivningar in INK2
7. Koncernbidrag in INK2
8. Ränteavdragsbegränsningar (N9)
9. Common errors and traps
10. Filing deadlines

---

## 1. INK2 form structure

INK2 (Inkomstdeklaration 2, SKV 2002) has three core parts plus optional bilagor:

### INK2 -- Huvudblanketten (main form)
Summary of taxable income. Fields 1.1-1.16.
- **1.1** Överskott of näringsverksamhet (from INK2S 4.15)
- **1.2** Underskott of näringsverksamhet (from INK2S 4.16)
- **1.4** Särskild löneskatt på pensionskostnader (rate **24.26%**)
- **1.6a/b** Avkastningsskatt (rate **15%**; fältkod 7153/7154)
- **1.7a/b** Avkastningsskatt (rate **30%**; fältkod 7155/7156, e.g. utländsk kapitalförsäkring at 1.7b)
- **1.8-1.15** Fastighetsskatt/avgift

### INK2R -- Räkenskapsschema
Balansräkning (fields 2.1-2.50) and resultaträkning (fields 3.1-3.27). Mirrors ÅRL structure. Auto-populated from BAS accounts via SRU coupling tables when importing SIE files.

### INK2S -- Skattemässiga justeringar
Fields 4.1-4.22. Transforms bokfört resultat into skattemässigt resultat. These fields are **NOT auto-coupled** to BAS accounts; they require manual entry or program-specific logic.

### Bilagor
- **N3B** -- andel i handelsbolag
- **N4** -- andelsbyte/uppskov
- **N7** -- nedsättning avkastningsskatt
- **N8** (SKV 2155) -- skogsavdrag/substansminskningsavdrag
- **N9** (SKV 2158) -- begränsning av ränteavdrag (required if deducting under EBITDA rule or transferring/receiving net interest within a group)

---

## 2. Data flow

```
Bokföring (BAS accounts)
    ↓ SRU coupling
INK2R (fields 2.x, 3.x) -- accounting figures
    ↓ 3.26/3.27 (Årets resultat)
INK2S (fields 4.x) -- tax adjustments
    ↓ 4.15/4.16 (Överskott/Underskott)
INK2 (fields 1.x) -- final taxable result
```

Specifically: INK2R 3.26/3.27 → INK2S 4.1/4.2 → adjustments → INK2S 4.15/4.16 → INK2 1.1/1.2.

---

## 3. INK2R field mappings

### Resultaträkning (key fields)

| INK2R | Description | BAS accounts | Fältkod |
|---|---|---|---|
| 3.1 | Nettoomsättning | 30xx-37xx | 7410 |
| 3.5 | Råvaror och förnödenheter | 40xx-47xx, 4910-4929 | 7511 |
| 3.7 | Övriga externa kostnader | 50xx-69xx | 7513 |
| 3.8 | Personalkostnader | 70xx-76xx | 7514 |
| 3.9 | Av-/nedskrivningar materiella & immateriella | 77xx-78xx (exkl. 774x, 779x) | 7515 |
| 3.16 | Övriga ränteintäkter | 83xx (exkl. 837x, 838x) | 7417 |
| 3.18 | Räntekostnader | 84xx | 7522 |
| 3.19 | Lämnade koncernbidrag | 883x | 7524 |
| 3.20 | Mottagna koncernbidrag | 882x | 7419 |
| 3.21 | Återföring periodiseringsfond | 8810, 8819 | 7420 |
| 3.22 | Avsättning periodiseringsfond | 8810, 8811 | 7525 |
| 3.23 | Förändring av överavskrivningar | 885x | 7421(+)/7526(-) |
| 3.25 | Skatt på årets resultat | 89xx (exkl. 899x) | 7528 |
| 3.26 | Årets resultat, vinst → p. 4.1 | +899x | 7450 |
| 3.27 | Årets resultat, förlust → p. 4.2 | −899x | 7550 |

### Balansräkning (key fields)

| INK2R | Description | BAS accounts | Fältkod |
|---|---|---|---|
| 2.1 | Immateriella anläggningstillgångar | 10xx | 7201 |
| 2.3 | Byggnader och mark | 11xx | 7214 |
| 2.4 | Maskiner/inventarier | 12xx | 7215 |
| 2.7 | Andelar i koncernföretag | 131x | 7230 |
| 2.26 | Kassa/bank | 19xx | 7281 |
| 2.29 | Periodiseringsfonder | 211x-213x | 7321 |
| 2.30 | Ackumulerade överavskrivningar | 215x | 7322 |

---

## 4. INK2S skattemässiga justeringar

### The adjustment formula

```
Bokfört resultat (4.1 vinst / 4.2 förlust)
+ 4.3  Ej avdragsgilla kostnader
- 4.4  Avdragsgilla ej bokförda kostnader
- 4.5  Ej skattepliktiga intäkter
+ 4.6  Skattepliktiga ej bokförda intäkter
± 4.7  Avyttring av delägarrätter
± 4.8  Andel i handelsbolag
± 4.9  Skattemässig justering avskrivning byggnader/inventarier
± 4.10 Fastighetsförsäljning
± 4.11 Skogsavdrag
± 4.12 Återföring värdeminskningsavdrag
± 4.13 Övriga justeringar
- 4.14 Underskott från tidigare år
= 4.15 Överskott OR 4.16 Underskott
```

The four-digit numbers in parentheses below are **SRU fältkoder** (field codes in the INK2S file), not BAS accounts. INK2S fields are not coupled to BAS accounts.

### Punkt 4.3 -- Ej avdragsgilla kostnader (additions)
- **4.3a** = skatt på årets resultat (SRU 7651; same amount as p. 3.25, i.e. the booked tax on BAS 8910 Skatt som belastar årets resultat)
- **4.3b** = nedskrivning av finansiella tillgångar (from p. 3.17, SRU 7652). **HIGH ERROR RATE** -- almost never tax-deductible but frequently missed.
- **4.3c** = andra ej avdragsgilla (böter, skattetillägg, förseningsavgifter, gåvor, ej avdragsgill representation, SRU 7653)

### Punkt 4.4 -- Avdragsgilla ej bokförda kostnader (deductions)
- **4.4a** = lämnade koncernbidrag not booked through P&L (e.g. via equity under K3/RFR 2, SRU 7751)
- **4.4b** = andra ej bokförda avdragsgilla kostnader (SRU 7764)

### Punkt 4.5 -- Ej skattepliktiga intäkter (deductions)
- **4.5a** = skattefria ackordsvinster (SRU 7752)
- **4.5b** = skattefri utdelning on näringsbetingade andelar per IL 24 kap. (SRU 7753)
- **4.5c** = andra skattefria intäkter (SRU 7754)

### Punkt 4.6 -- Skattepliktiga ej bokförda intäkter (additions)
- **4.6a** = schablonintäkt på periodiseringsfonder (statslåneräntan x summa fonder, floor 0.5%, SRU 7654). **COMMONLY FORGOTTEN** -- pure tax item, not booked.
- **4.6b** = schablonintäkt på fondandelar (0.4% of ingående värde, SRU 7668)
- **4.6c** = mottagna koncernbidrag ej bokförda via resultat (SRU 7655)
- **4.6d** = uppräknat belopp vid återföring av periodiseringsfond (106% pre-2019, 104% 2019-2020, 100% from 2021, SRU 7673)
- **4.6e** = andra ej bokförda skattepliktiga intäkter (SRU 7665)

### Punkt 4.7 -- Avyttring delägarrätter
- **4.7a** = bokförd vinst (deducted, SRU 7755)
- **4.7b** = bokförd förlust (added, SRU 7656)
- **4.7c** = uppskov med kapitalvinst enligt N4 (deducted, SRU 7756)
- **4.7d** = återfört uppskov enligt N4 (added, SRU 7657)
- **4.7e** = skattemässig kapitalvinst (SRU 7658)
- **4.7f** = skattemässig kapitalförlust -- the **aktiefållan** (only offsetable against future aktievinster, SRU 7757)

### Punkt 4.14 -- Underskott från tidigare år
- **4.14a** = outnyttjat underskott from prior year (SRU 7763)
- **4.14b** = reduktion due to beloppsspärr, ackord, konkurs (SRU 7671)
- **4.14c** = koncernbidragsspärrat/fusionsspärrat underskott (SRU 7672; also reported at p. 1.2)

### Tilläggsupplysningar (4.17-4.22)
Värdeminskningsavdrag on byggnader (4.17, SRU 8020) and markanläggningar (4.18, SRU 8021) remaining at year-end, återförda belopp vid restvärdesavskrivning inventarier (4.19, SRU 8023), lån från aktieägare som är fysisk person (4.20, SRU 8026), pensionskostnader i p. 3.8 (4.21, SRU 8022), koncernbidrags-/fusionsspärrat underskott (4.22, SRU 8028).

Överskott 4.15 = SRU 7670 and underskott 4.16 = SRU 7770 (→ INK2 1.1/1.2 = SRU 7104/7114).

---

## 5. Periodiseringsfond in INK2

Legal reference: IL 30 kap.

- Max avsättning: **25%** of skattemässigt överskott (30:5 §)
- Must be reversed by **6th tax year** after avsättning (30:7 §)
- Requires corresponding booking in räkenskaperna (obeskattade reserver)
- Annual schablonintäkt: statslåneräntan (30 Nov) x total fonder at year start (30:6a §), floor **0.5%**
- SLR 30 Nov 2024 = 1.96%, SLR 30 Nov 2025 = 2.55%
- Up to 6 concurrent funds
- Not available for privatbostadsföretag or investmentföretag

### INK2 placement
- Avsättning: INK2R p. 3.22 (konto 8810/8811)
- Återföring: INK2R p. 3.21 (konto 8810/8819)
- Schablonintäkt: INK2S p. 4.6a (pure tax item, NOT booked in accounting)
- Balance: INK2R p. 2.29 (konto 211x-213x)

---

## 6. Överavskrivningar in INK2

Legal reference: IL 18 kap.

### Räkenskapsenlig avskrivning (requires skattemässig = bokförd, 18:14 §)
- **Huvudregeln / 30-regeln (18:13 §)**: max 30% of avskrivningsunderlag
- **Kompletteringsregeln / 20-regeln (18:17 §)**: 20% annual on anskaffningsvärde = full write-off in 5 years
- Methods combinable for different asset categories, not on same category in one year

### Restvärdesavskrivning (alternative)
- Max **25%** of avskrivningsunderlag
- Does NOT require matching between bokförda and skattemässiga values

### INK2 placement
- Förändring: INK2R p. 3.23 (konto 885x)
- Accumulated: INK2R p. 2.30 (konto 215x)

---

## 7. Koncernbidrag in INK2

Legal reference: IL 35 kap.

### Requirements (35:2-3 §§)
- >90% ownership
- Both parties skattskyldiga in Sweden
- For entire beskattningsår

### K2 treatment (booked through resultaträkning)
- Lämnade: INK2R p. 3.19 (konto 883x)
- Mottagna: INK2R p. 3.20 (konto 882x)

### K3/RFR 2 treatment (may be booked via equity)
- Lämnade: INK2S p. 4.4a
- Mottagna: INK2S p. 4.6c

**TRAP**: K2/K3 difference in booking method leads to double-reporting or missing amounts if INK2R/INK2S split is handled incorrectly.

---

## 8. Ränteavdragsbegränsningar (N9)

Legal reference: IL 24:24-29 §§.

- **EBITDA rule**: negative räntenetto limited to **30% of tax-EBITDA** (24:24 §)
- **Förenklingsregel**: **5 MSEK** negative net interest deductible without limitation
- Filing **N9** (SKV 2158) required if deducting under EBITDA rule or transferring/receiving räntenetto in a group
- Complex rules for koncernutjämning of negative räntenetto

---

## 9. Common errors and traps

### Critical errors (high risk for skattetillägg)

1. **Nedskrivning av finansiella anläggningstillgångar not reversed at p. 4.3b.** Nedskrivningar at p. 3.17 are almost never tax-deductible but frequently missed in skattemässig justering. Often large amounts. Skatteverket ställningstagande 2022-10-27 on befrielse from skattetillägg for this error.

2. **Aktiefållan at p. 4.7f.** Kapitalförluster on kapitalplaceringsaktier can only offset gains on similar instruments. Cannot be deducted against other income. Proper separation critical.

3. **Glömd schablonintäkt på periodiseringsfond at p. 4.6a.** Pure tax item, no bookkeeping entry. Frequently forgotten. Must be reported annually.

4. **Koncernbidrag K2/K3 inconsistency.** K2 flows through income statement; K3 may flow through equity. Leads to double-reporting or missing amounts if INK2R/INK2S split is wrong.

5. **Missing SLP underlag at INK2 p. 1.4.** Companies with pension costs frequently forget to calculate and report särskild löneskatt base (24.26% rate).

### Other common errors
- INK2R figures not matching årsredovisningen (rounding)
- Missing bilagor (INK2 without INK2R/INK2S makes declaration incomplete)
- Wrong signs in SRU files: rows printed with "−" (costs, 4.4, 4.5, 4.14a, 4.16 etc.) are reported as positive amounts; a negative amount means deviation from the printed sign
- Ej avdragsgill representation not identified and added back at 4.3c
- Incorrect rollforward of underskott from prior years at 4.14

---

## 10. Filing deadlines

### General rule
Approximately 7 months after FY end.

### Calendar year companies (Dec 31 FY end)
Deadline: **1 augusti** (moved to next weekday if weekend/holiday).
- FY 2025: 3 augusti 2026 (1 Aug is Saturday)
- FY 2026: 2 augusti 2027 (1 Aug is Sunday)

### Other FY endings

| FY ending | Deadline |
|---|---|
| Jan-Apr 2026 | 1 december 2026 |
| May-Jun 2026 | 15 januari 2027 |
| Jul-Aug 2026 | 1 april 2027 |
| Sep-Dec 2026 | 2 augusti 2027 |

### Consequences of late filing
- Förseningsavgift: **6,250 SEK** per instance (up to 3, max **18,750 SEK** within 1 year)
- No declaration: Skatteverket may impose **skönstaxering** + **skattetillägg**
- F-skatt godkännande may be revoked
- Kostnadsränta accrues on unpaid tax

### Anstånd
Companies can apply for anstånd or **byråanstånd** through authorized redovisningsbyråer before deadline.

---

## IL chapter reference for INK2

| Area | IL chapter | Key provisions |
|---|---|---|
| Periodiseringsfond | 30 kap. | 30:3 (who), 30:5 (25%), 30:6a (schablonintäkt), 30:7 (6-year reversal) |
| Räkenskapsenlig avskrivning | 18 kap. | 18:13 (30-regeln), 18:17 (20-regeln), 18:14 (bokföringsöverensstämmelse) |
| Koncernbidrag | 35 kap. | 35:2-3 (förutsättningar, >90% ägande) |
| Ränteavdragsbegränsningar | 24 kap. | 24:24 (30% EBITDA / 5 MSEK förenklingsregel) |
| Ej avdragsgilla kostnader | 9 + 16 kap. | 9:2 (gåvor), 16:1 (avdragsrätt) |
| Underskottsavdrag | 40 kap. | 40:2 (huvudregel), 40:16 (beloppsspärr) |
| Näringsbetingade andelar | 24 + 25a kap. | Skattefri utdelning och kapitalvinst |