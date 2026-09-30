---
areas: [moms]
---

# Blandad verksamhet in a clinic or salon: practical reference

Scope: the bookkeeping and advisory consequences, for a Swedish clinic, dental practice, physiotherapist, psychologist or beauty salon, of having both VAT-exempt and VAT-taxable revenue. Whether a given supply is exempt is decided in **`momsfri-vard.md`**. The general rules on proportional deduction, justering/jämkning and frivillig beskattning live in **`swedish-vat`**: this file gives the sector-specific application, not the theory. Asset classification rules live in **`swedish-asset-accounting`**, payroll mechanics in **`swedish-payroll`**, cash-register mechanics in **`swedish-cash-register`**.

**Legal position stated: 2026.** ML (2023:200) consolidated t.o.m. SFS 2026:1025; SFL (2011:1244) and HSL (2017:30) in their current consolidated form; prisbasbelopp 2026 = 59,200 SEK (Skatteverket). One proposal affecting apportionment is pending for 2027 and is marked as a proposal in section 3. Sources and check dates at the end.



## Table of contents

1. [Why a clinic becomes blandad verksamhet](#1-why-a-clinic-becomes-blandad-verksamhet)
2. [Direct attribution first](#2-direct-attribution-first)
3. [Then apportionment: methods and what Skatteverket accepts](#3-then-apportionment-methods-and-what-skatteverket-accepts)
4. [Documentation to keep](#4-documentation-to-keep)
5. [Justering (jämkning) when the mix changes](#5-justering-jämkning-when-the-mix-changes)
6. [Premises and frivillig beskattning](#6-premises-and-frivillig-beskattning)
7. [Equipment](#7-equipment)
8. [Payroll specifics](#8-payroll-specifics)
9. [Kassaregister and personalliggare](#9-kassaregister-and-personalliggare)
10. [Patient payments and public payers](#10-patient-payments-and-public-payers)
11. [Monthly reconciliation checklist](#11-monthly-reconciliation-checklist-for-a-mixed-clinic)
12. [Sources](#12-sources)

---

## 1. Why a clinic becomes blandad verksamhet

Input VAT is deductible only *"i den utsträckning en beskattningsbar person använder varorna och tjänsterna för sina beskattade transaktioner inom landet"* (ML 13 kap. 6 §). Exempt care produces no deduction right. The moment a clinic adds any taxable stream, every shared cost has to be split.

Typical triggers, all common in this sector:

| Taxable stream | Why it appears |
|------|------|
| Estetiska behandlingar without a medical purpose | Aesthetics added to a dental or dermatology practice |
| Uthyrning av vårdpersonal | Own staff hired out on shifts to other clinics (taxable since HFD 2018 ref. 41) |
| Retail sale of skincare, supplements, tandborstar, glasögon | Shop counter in the reception |
| Intyg, körkorts- och försäkringsutlåtanden | Certificate revenue in a GP practice |
| Företagshälsovårdens förebyggande arbetsmiljöarbete | Ergonomi, föreläsningar, arbetsmiljökartläggning |
| Friskvård, PT, massage för välbefinnande | Wellness added to a physiotherapy practice |
| Vidareuthyrning of a treatment room or chair to a taxable practitioner | Empty room monetised |
| Servicetjänster sold separately by an omsorgsföretag | Städning, tvätt, matlagning, inköp |

Two knock-on duties the agent must raise the first time a taxable stream appears:

1. **VAT registration.** The 2026 exemption for small businesses ends at **120,000 SEK årsomsättning inom landet** for the calendar year, and it also must not have been exceeded in either of the two preceding calendar years (ML 18 kap. 4 §, Lag 2024:942, in force 1 January 2025, unchanged for 2026). Årsomsättningen is computed under ML 18 kap. 18-23 §§: 19 § counts supplies only to the extent they would have been taxed, and the closed list of exempt transactions that still count (20 §) does **not** include sjukvård, tandvård or social omsorg. **Exempt care therefore does not count toward the 120 000 kr threshold**: only the taxable stream does.
2. **Retroactive input VAT.** Starting to charge VAT can open a justering claim in the clinic's favour on equipment and premises: section 5.

---

## 2. Direct attribution first

ML 13 kap. 29 § first paragraph requires apportionment only for input VAT on an acquisition that *"bara delvis är avdragsgill"*, is made for several economic activities *"av vilka det saknas avdragsrätt i någon"*, or is made *"för en verksamhet där det delvis saknas rätt till avdrag"*. The second paragraph allows *uppdelning efter skälig grund* **only if the directly attributable part cannot be established**.

So the order is fixed, and an agent that jumps straight to a percentage is doing it wrong:

1. **Fully taxable use → 100 % deduction, account 2641.** Botulinumtoxin bought for cosmetic treatments only. Retail stock for the shop counter. Marketing spend for the aesthetics line. Kassaregister used only in the shop.
2. **Fully exempt use → 0 % deduction, VAT expensed into the cost account.** Dental materials for exempt treatments. Journal system licence for the care side. Patientförsäkring.
3. **Genuinely shared → apportion, account 2649 for the deductible part and 6999 for the rest.** Rent, el, städning, reception staff costs, accounting fees, general IT, the practice-management system, the building's alarm.

Practical rules that keep the shared bucket small, which is always the cheaper answer:

- Split purchase orders at source. Two supplier accounts, two cost centres, two VAT codes.
- Stock aesthetics consumables separately from care consumables even when the product is the same item; the VAT treatment follows the use, not the SKU.
- Book uthyrning av vårdpersonal to **3620 Tillfällig uthyrning av personal** and carry a time sheet per hired-out employee: that time sheet is also the apportionment key for that employee's cost.
- Do **not** apply the apportionment percentage to a cost you have already attributed directly. Double-splitting is a frequent reconciliation error.

### The 95 % shortcuts (ML 13 kap. 30 §)

Full deduction of the whole input VAT on a shared purchase is allowed if either:

1. the acquisition is made **to more than 95 %** for transactions carrying deduction right; or
2. the input VAT on that acquisition **does not exceed 1,000 SEK** *and* the consideration for the transactions carrying deduction right exceeds **95 %** of the consideration in the business.

For a typical clinic the second limb almost never applies (exempt care usually dominates turnover), and the first applies only to a narrow set of purchases. Do not let a system default the 95 % rule on.

---

## 3. Then apportionment: methods and what Skatteverket accepts

### Method 1: skälig grund (ML 13 kap. 29 § 2 st)

A reasonable basis that reflects actual resource use. Keys that work in this sector:

| Key | Use it for | Evidence needed |
|------|------|------|
| **Yta** (m² per use) | Rent, el, värme, städning, larm, fastighetsrelaterade kostnader | A dated floor plan with each room classified, plus a rule for shared areas (reception, korridor, personalrum) allocated pro rata to the classified areas |
| **Arbetstid** | Reception, administration, personnel costs of staff who work both sides | Time records per employee per month |
| **Antal behandlingar / besök** | Consumables and equipment shared across treatment types | Booking-system extract per treatment code |
| **Omsättning** | Truly general overhead where nothing better exists | Revenue per VAT code, excl. VAT on both sides |

### Method 2: the turnover method from the VAT Directive

**HFD 2023 ref. 45** (2023-10-16, mål 7254-22 and 7255-22, Volkswagen Finans Sverige AB) held that a taxable person **cannot be refused** the turnover-based calculation in Article 174 of the VAT Directive for shared costs in blandad verksamhet. Skatteverket had imposed a sector-based key that gave a materially worse result; HFD's answer to the prejudikatfråga removed that possibility.

What this means for a clinic in 2026: if Skatteverket challenges a yta- or tidbaserad key, the clinic can fall back on the turnover ratio (taxable turnover ÷ total turnover, both excl. VAT) and Skatteverket cannot simply substitute its own preferred key. It does **not** mean the turnover method always gives the best result: in a clinic where the aesthetics line is space-hungry but low-revenue, a yta-based key is usually more favourable. Compute both and keep the working papers.

For the rounding convention, the use of the prior year's ratio provisionally with a year-end adjustment, and Skatteverket's acceptance of combining methods per cost category, see **`swedish-vat`** section 4: do not restate those rules from memory here.

### Proposed change for 2027: not law

A **lagrådsremiss** *Ändrade regler om fördelning av avdrag för mervärdesskatt* (11 June 2026) proposes making omsättningsmetoden the explicit statutory main rule, with an area-based method for building costs and a per-verksamhetsgren calculation. **Status as of 2026-09-17: proposal only.** No proposition had been submitted; nothing is in force; the earliest proposed application is 1 January 2027. Do not build client advice on it, and flag to the user that a clinic setting up a long-lived apportionment key now may have to redo it. (Status carried from **`swedish-vat`** section 4, which tracks this file.)

### BAS 2026 accounts and a worked entry

| Account | Name (BAS 2026) |
|------|------|
| **2641** | Debiterad ingående moms: directly attributable to the taxable side |
| **2649** | Ingående moms, blandad verksamhet: deductible share of shared input VAT |
| **6999** | Ingående moms, blandad verksamhet: non-deductible share, taken to cost |
| **2611** | Utgående moms på försäljning inom Sverige, 25 % |
| **2650** | Redovisningskonto för moms |
| **1650** | Momsfordran |

**Worked entry: monthly rent invoice, 40,000 SEK excl. VAT plus 10,000 SEK VAT, on a yta key giving 22 % taxable use**

| Account | Debit | Credit |
|------|------|------|
| 5010 Lokalhyra | 40,000.00 | |
| 2649 Ingående moms, blandad verksamhet | 2,200.00 | |
| 6999 Ingående moms, blandad verksamhet | 7,800.00 | |
| 2440 Leverantörsskulder | | 50,000.00 |

Only the 2,200 SEK reaches the momsdeklaration. The 7,800 SEK is a real cost of the exemption and should be visible to the client as such: put 6999 on the P&L review, not buried in "övrigt".

---

## 4. Documentation to keep

Skatteverket's first question in a revision is not the percentage, it is how it was derived. Keep, per year, in the bokslutspärm:

1. **The key itself**, with its numerator and denominator and the source system for each.
2. A **dated floor plan** classifying every room as exempt use, taxable use or shared, with m² and the shared-area allocation rule.
3. **Time records** for any employee whose cost is apportioned.
4. A **revenue report per VAT code**, excl. VAT, tying to the general ledger and to the momsdeklaration.
5. The **year-end recalculation**: provisional ratio used during the year, actual ratio, the correcting entry, and the verifikationsnummer.
6. A **written note of the method choice** and why it reflects resource use: especially if the method changed from the prior year. A method change without a documented reason invites a skattetillägg discussion.
7. For treatment-level VAT coding, the evidence listed in `momsfri-vard.md` section 4.

Under BFL the underlying records are part of the räkenskapsinformation and follow the normal arkiveringstid; check `swedish-accounting-compliance` for the retention period rather than assuming one.

---

## 5. Justering (jämkning) when the mix changes

ML 15 kap. renamed jämkning to **justering**. It bites hard in this sector because the exempt/taxable mix moves whenever a clinic adds or drops an aesthetics line, starts or stops hiring out staff, or converts a room.

### What is an investeringsvara (ML 15 kap. 4 §)

| Type | Threshold | Justeringsperiod |
|------|------|------|
| Maskiner, inventarier och liknande anläggningstillgångar vars värde minskar | Input VAT on the acquisition ≥ **50,000 SEK** (≈ 250,000 SEK excl. VAT at 25 %) | **5 years** from acquisition/import (15 kap. 10 § 3) |
| Fastighet subject to ny-, till- eller ombyggnad | Input VAT on the work ≥ **100,000 SEK** | **10 years** (15 kap. 10 § 1) |
| Hyresrätt/bostadsrätt with ny-, till- eller ombyggnad by the tenant | Input VAT ≥ **100,000 SEK** | **10 years** (15 kap. 10 § 1) |

The year of acquisition or of the building work counts as year one (15 kap. 11 §). Work on the same fastighet within one beskattningsår is aggregated against the threshold (15 kap. 6 §). Machinery, equipment and särskild inredning fitted to a non-residential building and acquired for direct use in a specific activity carried on there count as movable investeringsvaror, not as part of the building (15 kap. 5 §): that is the rule that catches a fixed dental chair or an imaging suite.

### Triggers and the de minimis

Justering is required when use shifts so the deductible share falls or rises (15 kap. 7 § 1-2), on sale of a non-property investeringsvara whose input VAT was only partly deductible (7 § 3), on transfer of property (7 § 4-5) and on bankruptcy (7 § 6). **No justering if the change in the deductible share is less than five percentage points** compared with the share at acquisition (15 kap. 9 § 2).

Annual justering runs for each remaining year of the period (15 kap. 12 §); on sale or transfer it is done once, for the whole remainder (15 kap. 13 §). For the formulas and the BAS booking of a justering, use **`swedish-vat`** section 5.

### Worked case: a laser bought for a mixed clinic

A clinic buys an aesthetic laser in 2026 for 400,000 SEK excl. VAT, input VAT 100,000 SEK. It is an investeringsvara (100,000 ≥ 50,000) with a five-year period, 2026-2030.

- 2026: used 90 % for taxable aesthetic treatments. Deducted 90,000 SEK.
- 2028: the clinic wins a regional contract and uses the laser 40 % for exempt medical indications, so the taxable share falls to 60 %. Change = 30 percentage points, well over five.
- Annual justering for 2028 = 100,000 × (−30 %) × 1/5 = **−6,000 SEK** repaid, and the same again for 2029 and 2030 if the use stays at 60 %.
- If instead the clinic sells the laser in 2029, a one-off justering covers 2029 and 2030 (15 kap. 13-14 §§).

**Ask the user** each year-end: did any room change use; did any treatment line start or stop; was any equipment over 250,000 SEK excl. VAT reassigned; was any premises rebuilt. Keep an **investeringsvaruregister** with acquisition year, input VAT, original deductible share and the share each subsequent year: without it the justering is not computable and a revision will assume the worst.

---

## 6. Premises and frivillig beskattning

### The rule

Letting a property is exempt (ML 10 kap. 35 §). ML 12 kap. 5 § lets a fastighetsägare, konkursbo or mervärdesskattegrupp opt into taxation only where the premises are let *"för stadigvarande användning i en verksamhet där transaktionerna medför avdragsrätt eller rätt till återbetalning"*. **A tenant whose activity is exempt sjukvård or tandvård does not meet that condition.** There is no frivillig beskattning for letting to a purely exempt clinic.

Exception: letting to **staten, en kommun, ett kommunalförbund or ett samordningsförbund** may be covered even where the tenant's transactions do not carry deduction right (ML 12 kap. 6 §), with a carve-out where the municipality sublets to a non-public exempt user (12 kap. 6 § 2 st). A region-run vårdcentral in rented premises therefore behaves differently from a private one.

### What it means for the tenant clinic

- The rent carries **no VAT**, so there is nothing to deduct: but the landlord's own non-deductible input VAT on the building is priced into the rent as **dold moms**. Expect a rent premium against comparable taxable-let space, typically the landlord's irrecoverable VAT spread over the lease.
- Negotiate on the **rent inclusive of that effect**, not on the headline. A landlord who cannot recover VAT on a refurbishment will try to pass 100 % of it through.
- **Tenant improvements** paid by the clinic on exempt premises generate non-deductible input VAT; that VAT becomes part of the asset's cost. It also counts toward the 100,000 SEK investeringsvara threshold for a hyresrätt (15 kap. 4 § 4).

### What it means for the landlord

- No deduction on construction, refurbishment or running costs for that lokal.
- A landlord who previously let the same lokal to a taxable tenant and now lets it to an exempt clinic **loses frivillig beskattning for that lokal and must justera** previously deducted investeringsmoms for the remainder of the ten-year period (ML 12 kap. 27-31 §§ and 15 kap.). This is the single most expensive surprise in the sector.
- Put a **momsklausul** in the lease: the tenant warrants its activity carries deduction right, notifies any change, and indemnifies the landlord for justering caused by a change on the tenant's side.
- **Chain rule.** Frivillig beskattning must hold at every link. A landlord → first-hand tenant → clinic chain collapses the moment the clinic is exempt. See `swedish-vat` section 6 before advising on a sublet structure.

### The clinic as sub-landlord

A clinic that sublets a treatment room or a chair to a **taxable** practitioner (an aesthetic nurse, a hired-out consultant) can opt into frivillig beskattning for that clearly delimited part, provided the use is stadigvarande (ML 12 kap. 5 § and 7 § 2). That turns a slice of the building cost deductible and changes the yta key. Revenue then goes to **3913 Frivilligt momspliktiga hyresintäkter** with output VAT on **2613 Utgående moms för uthyrning, 25 %**; input VAT on the let part on **2646 Ingående moms på uthyrning**. Note that renting out *a person* is not renting out *space*: if what is supplied is staff, it is 25 % personaluthyrning regardless (see `momsfri-vard.md` section 5).

---

## 7. Equipment

### Förbrukningsinventarie or anläggningstillgång

Two BAS routes:

| Route | Account | When |
|------|------|------|
| Expense immediately | **5410 Förbrukningsinventarier** (or 5411 / 5412 for the >1 year / ≤1 year split), **5460 Förbrukningsmaterial** | Inventarier av mindre värde or a useful life of at most three years |
| Capitalise | **1220 Inventarier, verktyg och installationer** (1221 i övrigt, 1222 byggnads- och markinventarier, 1224 datorer), **1210/1211 Maskiner och andra tekniska anläggningar** | Everything else |

For 2026 the "mindre värde" limit is **half a prisbasbelopp = 29,600 SEK** (prisbasbelopp 2026 = 59,200 SEK). The classification test, the useful-life alternative, the "naturligt sammanhörande enhet" rule and the avskrivning mechanics belong in **`swedish-asset-accounting`**: use it rather than reasoning from the limit alone.

**The trap specific to an exempt clinic:** non-deductible input VAT is part of the asset's anskaffningsvärde. A dental chair at 25,000 SEK excl. VAT costs an exempt practice 31,250 SEK including irrecoverable VAT, which is **above** the 29,600 SEK limit: so it must be capitalised, while an identical chair in a fully taxable salon is expensed. In blandad verksamhet, add the non-deductible share only. Agents get this wrong in both directions; always compute the limit test on the amount actually charged to the asset account.

Typical sector items:

| Item | Usual route |
|------|------|
| Behandlingsstol, tandläkarunit, gynstol | 1220/1221: capitalise |
| Laser, IPL, ultraljud, röntgen/OPG, CBCT | 1210/1211 or 1220: capitalise; usually also an investeringsvara for justering (section 5) |
| Autoklav, sterilisator | Depends on cost against the 29,600 SEK test |
| Instrument, handstycken, småapparatur | 5410 |
| Engångsmaterial, handskar, förband, nålar | 5460 |
| Journalsystem / praktikprogram (licence) | 5420 Programvaror or 6540 IT-tjänster depending on the contract |
| Arbetskläder, skyddsutrustning | 5480 Arbetskläder och skyddsmaterial |

### Leasing

BAS 2026 has no leasing account for medical equipment; **5615-5695 are leasing of vehicles and specific machine classes only**. Operational rental of clinic equipment goes to **5210 Hyra av maskiner och andra tekniska anläggningar** or **5220 Hyra av inventarier och verktyg**, computers to **5250 Hyra av datorer**, prepayments to **1720 Förutbetalda leasingavgifter**. Finance-leased assets recognised on balance sheet use **1217 Finansiellt leasade maskiner** / **1227 Finansiellt leasade inventarier**.

VAT on a lease follows the use of the leased item: the monthly VAT is input VAT to be attributed or apportioned like any other cost. There is no jämkning on an operational lease because the clinic never acquired an investeringsvara: that is often the decisive argument for leasing rather than buying a laser whose use mix is expected to move. Raise it with the client. K2/K3 classification is in `swedish-asset-accounting`.

---

## 8. Payroll specifics

General payroll mechanics, AGI, arbetsgivaravgifter and förmånsvärdering are in **`swedish-payroll`**. What is specific here:

**Staff working partly as consultants.** When an employed practitioner is hired out to another clinic, the employer makes a taxable supply of personaluthyrning (`momsfri-vard.md` section 5). The employee's salary stays a payroll cost on 7010/7210 as usual, but:

- keep a time sheet splitting hours between own patients and hired-out shifts;
- use that sheet as the apportionment key for that employee's share of shared overhead;
- invoice on **3620 Tillfällig uthyrning av personal** with 25 % on **2611**;
- watch the VAT registration threshold (ML 18 kap. 4 §) for a practitioner doing this through their own company.

**Jour and beredskap.** BAS 2026 has **no dedicated account** for jour- or beredskapsersättning. Book it on the relevant salary account (7010/7011 kollektivanställda, 7210/7211 tjänstemän) or on a company-defined sub-account under those, and keep the split visible for the collective agreement. Accrued but unpaid jour at period end goes to **2910/2919 Upplupna löner** with employer contributions on **2940/2941**. Jour is pay, so it is pensionsgrundande and semesterlönegrundande according to the collective agreement: check the agreement, do not assume, and see `swedish-payroll` for the semesterlöneskuld treatment (**2920 Upplupna semesterlöner**, **7290-7292 Förändring av semesterlöneskuld**).

**Friskvård for own staff.** Friskvårdsbidrag is booked on **7699 Övriga personalkostnader**; sjuk- och hälsovård on **7620/7621/7622** with the avdragsgill/ej avdragsgill split, and sjukvårdsförsäkring on **7623 Sjukvårdsförsäkring, ej avdragsgill**. The tax-free amount and the eligibility conditions for friskvårdsbidrag sit in `swedish-payroll`: do not quote a figure from memory. Two sector-specific points:

- Input VAT on friskvård for own staff is **not deductible** in an exempt clinic in any event, and in blandad verksamhet it follows the general apportionment as an overhead cost.
- A clinic that also *sells* friskvård or PT commercially must not net its own staff's use against sales: that is an uttag question, not a discount.

---

## 9. Kassaregister and personalliggare

Mechanics, certification, kontrollremsa and the kvitto rules are in **`swedish-cash-register`**. The sector specifics:

### Kassaregister

Anyone selling goods or services against cash or card payment in näringsverksamhet must use a certified kassaregister (SFL 39 kap. 4 §, 8 §). The exemptions in 39 kap. 5 § that matter here:

- **Obetydlig omfattning** (5 § 1 st 1). The statute directs that it be *particularly considered* whether such sales normally amount to at most **four prisbasbelopp** in a beskattningsår: for 2026 that is **236,800 SEK** (4 × 59,200). It is a guide, not a hard ceiling.
- **Distansavtal** (5 § 1 st 4): a clinic whose patients pay only by invoice or by online payment before the visit falls outside; card payment at the counter does not.
- **Självständiga verksamheter** within one näringsverksamhet are assessed **separately** (39 kap. 6 §). A dental practice that invoices all treatment but runs a small card-paying retail counter must assess the counter on its own.

An exempt clinic is **not** exempt from the kassaregister duty: the duty attaches to cash/card sales, not to VAT status.

### Personalliggare

SFL 39 kap. 11 §: the duty applies to, among others, **kropps- och skönhetsvårdsverksamhet**. The definition in 39 kap. 2 § (Lag 2023:208) is *näringsverksamhet som avser behandling av en persons kropp eller omsorg om en persons yttre*, **but not**:

1. åtgärder som normalt utförs av sådan hälso- och sjukvårdspersonal som avses i **1 kap. 4 § patientsäkerhetslagen (2010:659)**,
2. **kirurgiska ingrepp**,
3. **injektionsbehandlingar**, and
4. sådan **medicinskt betingad fotvård** som avses i 10 kap. 7 § tredje stycket ML.

Read the consequences carefully, because they cut across the VAT answer:

| Business | Personalliggare? |
|------|------|
| Hair salon, nail bar, beauty salon, massage, kosmetisk fotvård, solarium, tatuering | **Yes** |
| Clinic whose treatments are carried out by hälso- och sjukvårdspersonal per PSL 1 kap. 4 § | **No**: carve-out 1 |
| Aesthetic clinic doing botox and fillers | **No** for those treatments: carve-out 3 covers injektionsbehandlingar, even though the same treatments are **taxable** for VAT |
| Plastic surgery | **No**: carve-out 2 |
| Medicinsk fotvård | **No**: carve-out 4 |
| Salon that also sells taxable aesthetics and some exempt treatments | Assess the business as a whole: 39 kap. 2 § last paragraph excludes näringsverksamhet that **huvudsakligen** concerns something other than the listed activities |

So a salon can be VAT-exempt on part of its revenue and still have to keep a personalliggare, and an injection clinic can be fully VAT-taxable and have none. Never derive one from the other.

Content and availability: identification details for the näringsidkare and, continuously, for everyone active in the verksamhetslokal: including people working in *another* business the näringsidkare runs in the same lokal (39 kap. 11 § 3 st). It must be available to Skatteverket **in the verksamhetslokal** (39 kap. 12 §). Exempt from the duty: enskild näringsverksamhet or fåmansföretag/fåmanshandelsbolag where only the näringsidkare/företagsledare, their spouse or children under 16 are active (39 kap. 11 § 2 st).

### Kontrollavgift (SFL 50 kap.)

| Breach | Amount |
|------|------|
| Kassaregister missing or not reported (50 kap. 1-2 §§) | **12,500 SEK** per kontrolltillfälle; **25,000 SEK** on a repeat within one year of the earlier decision |
| Personalliggare not kept or not available (50 kap. 3 § 1-2, 4 §) | **12,500 SEK** per kontrolltillfälle **plus 2,500 SEK per person** present and not documented; **25,000 SEK** for the first component on a repeat within one year |

Amounts per Lag 2015:768 and Lag 2015:769; unchanged for 2026. No kontrollavgift where the breach is covered by a vitesföreläggande (50 kap. 5 §), and a reasonable period to fix the fault is protected (50 kap. 6 §). Befrielse is possible under 51 kap. 1 §.

---

## 10. Patient payments and public payers

### Patientavgifter and högkostnadsskydd

Regions and municipalities set vårdavgifter themselves (HSL 17 kap. 1 §). The statutory ceiling on the annual **högkostnadsskydd för öppen vård** is **0.025 prisbasbelopp, rounded down to the nearest 50 SEK**, or a lower amount set by the region (HSL 17 kap. 6 §). For 2026: 0.025 × 59,200 = 1,480 → **1,450 SEK**. The ceiling covers open-care vårdavgifter, certain förbrukningsartiklar and tandvård under 8 a § tandvårdslagen. For sluten vård the per-day ceiling is 0.0023 prisbasbelopp rounded down to the nearest ten SEK (HSL 17 kap. 2 §): for 2026, 136.16 → **130 SEK**. Patients aged 85 or older pay no vårdavgift for the care covered by 17 kap. 6 § (HSL 17 kap. 3 §). **Confirm the region's own level** before advising a client, the statute sets a ceiling, not the price.

**Frikort.** Once the ceiling is reached the patient pays nothing further in that period. In the clinic's books a frikort visit is simply a visit with no patient revenue; if the region reimburses the clinic for it, that reimbursement is the revenue. Do not book an imputed patient fee.

### How a private clinic books a public payer's remittance

A private clinic on a regional avtal or vårdval typically receives a monthly **utbetalningsspecifikation** netting capitation, per-visit ersättning, target payments and deductions.

1. Recognise revenue when the care is performed, not when the region pays. The receivable is an ordinary **1510/1511 Kundfordringar** on the region.
2. The care itself is exempt → **3004 Försäljning inom Sverige, momsfri** (or a dedicated sub-account under 30xx mapped to 3004).
3. Reconcile the remittance line by line against the receivable. Post differences immediately; do not let a residual sit in 1510 across periods.
4. **Retroaktiva justeringar** and clawbacks from the region are revenue corrections in the period they are decided, unless they relate to a closed year and are material: then check the error-correction rules in `swedish-accounting-compliance`.
5. If any element of the remittance pays for something **taxable** (certificates, staff seconded to the region, a taxable service under the avtal), split it. Ask the region for the specification if the remittance does not show it.
6. **Osäkert:** whether a particular regional ersättning is consideration for an exempt supply or a genuine **bidrag** outside the scope of VAT turns on the avtal. Where it is a general subsidy with no identified counter-performance, **3985 Erhållna statliga bidrag** or **3987 Erhållna kommunala bidrag** may be the right home rather than a revenue account. Read the avtal; ask the user; do not classify from the payment description alone.

**Dental.** A dental practice is paid partly by the patient and partly by Försäkringskassan under lagen (2008:145) om statligt tandvårdsstöd: allmänt tandvårdsbidrag, särskilt tandvårdsbidrag, allmän tandvårdsersättning and: new for 2026, **särskild tandvårdsersättning** (SFS 2025:1437, prop. 2025/26:27 *Ett förstärkt högkostnadsskydd för tandvård*, in force **1 January 2026**). The amounts, the karensbelopp and the ersättningsandelar are set by förordning, not by the law (2 kap. 3 § and 2 kap. 5 §), so **look them up on Försäkringskassan for the relevant ersättningsperiod rather than quoting a figure**. Book the Försäkringskassan share as a receivable on the agency, not on the patient, and reconcile it against the FK specification the same way as a regional remittance. All of it is exempt tandvård for VAT; the subsidy does not change that.

### No-show fees

HSL 17 kap. 1 § expressly allows *"avgifter med anledning av att patienter uteblir från avtalade besök"*. Commercially the fee compensates for a slot that was not used: no care was supplied.

- For VAT, the analysis to apply is whether there is a supply for consideration at all. A pure penalty for a broken booking, where nothing is delivered, is compensation rather than remuneration for a tillhandahållande.
- **Osäkert:** Skatteverket's published position on uteblivet besök could not be retrieved on 2026-09-17 (Rättslig vägledning blocked, Internet Archive offline). Do not state a VAT treatment for no-show fees as settled. Get the current Skatteverket position, or a förhandsbesked, before coding a material volume of them.
- Whatever the outcome, keep them **off the care revenue account**. Where the terms frame the charge as compensation, BAS 2026 offers **3992 Erhållna skadestånd**; otherwise **3999 Övriga rörelseintäkter** under the 3990 group. Flag the VAT question to the user rather than defaulting a VAT code.
- In a salon the same fee is far more likely to be consideration for a taxable service arrangement; treat the two settings separately and ask the user how the terms are drafted.

---

## 11. Monthly reconciliation checklist for a mixed clinic

Run this before filing the momsdeklaration.

1. **Revenue by VAT code.** Pull revenue per treatment code from the booking system and reconcile to 3001 / 3004 / 3620 / 3913. Investigate every treatment code that appears under both codes in the month.
2. **New treatment codes.** Any code used for the first time this month: has someone decided its VAT treatment, and is the decision documented per `momsfri-vard.md`?
3. **Kassaregister Z-reports** reconciled to the ledger and to 1910/1930; rounding to **3740 Öres- och kronutjämning**. Card settlements against **1686 Fordringar för kontokort och kuponger**.
4. **Output VAT.** 2611 divided by taxable revenue = 25 %? Any exempt revenue with output VAT on it, or taxable revenue without?
5. **Input VAT triage.** Every 2649 posting has a key behind it; every 2641 posting is genuinely fully attributable; 6999 has moved in proportion to 2649.
6. **The apportionment ratio.** Compare the provisional ratio in use against the year-to-date actual. If it has drifted more than a couple of points, adjust now rather than at year-end.
7. **Personaluthyrning.** Time sheets for hired-out staff agree with what was invoiced on 3620, and the same hours are reflected in the overhead key.
8. **Public payers.** Regional and Försäkringskassan remittances reconciled line by line; no aged residuals in 1510 against a public payer.
9. **Asset additions.** Any acquisition where the amount charged to the asset account (including non-deductible VAT) exceeds 29,600 SEK: capitalised, not expensed. Any acquisition with input VAT ≥ 50,000 SEK, entered in the investeringsvaruregister with its original deductible share.
10. **Room and use changes.** Any room that changed use this month: update the floor plan, the yta key, and check the five-percentage-point justering test.
11. **Personalliggare.** Kept and available in the lokal for any part of the business inside the kropps- och skönhetsvård definition; new staff entered.
12. **VAT clearing.** 261x-264x and 2649 cleared to **2650 Redovisningskonto för moms**; balance agrees to the deklaration and then to 1650 or the skattekonto. Residual balances are the classic sign that a split was booked one-sided.
13. **Year-end only:** recompute the actual ratio, post the correcting entry, run the justering review on every item in the investeringsvaruregister, and file the working papers listed in section 4.

---

## 12. Sources

All checked **2026-09-17** unless stated.

| Source | What was taken from it |
|------|------|
| **Mervärdesskattelag (2023:200)**, consolidated t.o.m. **SFS 2026:1025**, via lagen.nu (source: beta.rkrattsbaser.gov.se) | 13 kap. 6 § (deduction main rule); 13 kap. 29 §, 30 §, 31 § (uppdelning, 95 %-reglerna, styrkande); 15 kap. 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15 §§ (justering: definitions, thresholds, periods, five-percentage-point rule); 12 kap. 1, 5, 6, 7, 8, 11 §§ (frivillig beskattning, incl. the requirement that the tenant's transactions carry deduction right, the stat/kommun exception, sublets, six-month invoice rule); 10 kap. 35 § (uthyrning av fastighet undantaget); 18 kap. 2 and 4 §§ (årsomsättning inom landet; 120,000 SEK, **Lag 2024:942**) |
| **HFD 2023 ref. 45**, 2023-10-16, mål 7254-22 and 7255-22 (Volkswagen Finans Sverige AB), via lagen.nu (source: rattspraxis.etjanst.domstol.se) | A taxable person cannot be refused the omsättningsbaserad method of Article 174 for gemensamma kostnader in blandad verksamhet; the facts of Skatteverket's sector-based alternative |
| **HFD 2018 ref. 41**, 2018-06-07, mål 7270-17 (Medcura AB), via lagen.nu | Uthyrning av vårdpersonal is taxable: used here only as the reason a clinic becomes blandad |
| **Skatteförfarandelag (2011:1244)**, consolidated, via lagen.nu | 39 kap. 2 § definitions of kropps- och skönhetsvårdsverksamhet with the four carve-outs (**Lag 2023:208**); 39 kap. 4, 5, 6, 7, 8 §§ (kassaregister, obetydlig omfattning = four prisbasbelopp, separate assessment of självständiga verksamheter); 39 kap. 11 § (personalliggare, **Lag 2018:243**) and 12 § (tillgänglighet); 50 kap. 1-6 §§ (kontrollavgift, **Lag 2015:768** and **Lag 2015:769**); 51 kap. 1 § (befrielse) |
| **Hälso- och sjukvårdslag (2017:30)**, consolidated t.o.m. **SFS 2026:1312**, via lagen.nu | 17 kap. 1 § (regions set vårdavgifter and no-show avgifter), 2 § (sluten vård, 0.0023 prisbasbelopp), 3 § (85 år och äldre), 6 § (högkostnadsskydd, 0.025 prisbasbelopp rounded down to nearest 50 SEK), 7 § (barn), 8 § (kommunal högkostnadsskydd) |
| **Lag (2008:145) om statligt tandvårdsstöd**, consolidated t.o.m. **SFS 2026:1111**, via lagen.nu | 1 kap. 1-3 §§; 2 kap. 1, 1 a, 2, 3, 4, 5, 6 §§. The 2026 change: **SFS 2025:1437**, prop. 2025/26:27, bet. 2025/26:SoU10, rskr. 2025/26:94, **ikraftträdande 2026-01-01**, introducing särskild tandvårdsersättning; amounts left to förordning per 2 kap. 3 § and 5 § |
| **skatteverket.se**, *Belopp och procent: inkomstår 2026* | Prisbasbelopp 2026 = **59,200 SEK**; förhöjt prisbasbelopp 2026 = 60,500 SEK. Used to compute the 29,600 SEK mindre-värde limit, the 236,800 SEK four-PBB kassaregister guide, the 1,450 SEK högkostnadsskydd and the 130 SEK per-day sluten vård ceiling |
| **BAS 2026 kontoplan v 1.1**, bas.se | Every account number and name in this file. Checked in particular: 1210/1211/1217, 1220/1221/1222/1224/1227, 1510/1511, 1650, 1686, 1720, 2440, 2611, 2613, 2641, 2646, 2649, 2650, 2910/2919, 2920, 2940/2941, 3001, 3004, 3620, 3740, 3913, 3985, 3987, 3992, 3999, 5010, 5210, 5220, 5250, 5410/5411/5412, 5420, 5460, 5480, 6540, 6999, 7010/7011, 7210/7211, 7290-7292, 7620/7621/7622, 7623, 7699. None carries the "#" K2 marker |
| **`swedish-vat`** reference in this repo | Status of the 2027 lagrådsremiss on fördelning av avdrag (11 June 2026, no proposition as of September 2026); rounding and provisional-ratio conventions; justering formulas and BAS booking |

**Osäkert: source access.** Skatteverket's *Rättslig vägledning* (www4.skatteverket.se/rattsligvagledning) rejected all automated requests on 2026-09-17, and the Internet Archive was offline, so no ställningstagande could be read in the original. Two points in this file are therefore left open rather than filled from a secondary source: Skatteverket's position on the VAT treatment of **uteblivet besök** (section 10), and the boundary between **ersättning för tillhandahållande** and **bidrag** for regional payments (section 10). Resolve both against skatteverket.se before advising.
