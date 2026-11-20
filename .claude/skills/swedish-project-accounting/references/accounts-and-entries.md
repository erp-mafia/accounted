# BAS Accounts and Journal Entries for Project Accounting


<!-- toc -->
**Contents**

- [1. Which account classes get project-tagged](#1-which-account-classes-get-project-tagged)
- [2. Core WIP accounts in detail](#2-core-wip-accounts-in-detail)
- [3. Journal entry patterns by scenario](#3-journal-entry-patterns-by-scenario)
- [4. Gemensamma kostnader and fördelningsnycklar](#4-gemensamma-kostnader-and-fördelningsnycklar)
- [5. Project closing entries](#5-project-closing-entries)

<!-- /toc -->

---

## 1. Which account classes get project-tagged

Project dimensions apply primarily to P&L accounts but extend to specific balance sheet accounts that are inherently project-related.

**Class 3xxx (intäkter)** -- ALWAYS project-tagged. Core for tracking project revenue.
- 3010 Försäljning varor
- 3040/3041 Försäljning av tjänster (6%/25%)
- 3310 Upparbetad intäkt adjustments (used by some systems)
- 3980/3981 Erhållna offentliga bidrag

**Class 4xxx (varor/material)** -- ALWAYS project-tagged as direct project costs.
- 4010 Varuinköp
- 4970 Förändring av pågående arbeten (P&L counterpart for 1470)

**Class 5xxx-6xxx (övriga kostnader)** -- COMMONLY tagged when directly attributable.
- 5010 Lokalhyra (if project-specific premises)
- 6110 Kontorsmaterial
- 6210 Telekommunikation
- 6530 Redovisningstjänster (if project-specific)
- Shared costs allocated via fördelningsnycklar (see section 4)

**Class 7xxx (personalkostnader)** -- COMMONLY tagged via employee time reports.
- 7010/7210 Löner till tjänstemän/kollektivanställda
- 7510 Arbetsgivaravgifter
- 7090/7290 Förändring semesterlöneskuld (should follow wage distribution)

**Class 1xxx/2xxx (balance sheet)** -- SELECTIVELY tagged. Only inherently project-related accounts:
- 1470 Pågående arbeten för annans räkning
- 1620 Upparbetad men ej fakturerad intäkt
- 2420 Förskott från kunder
- 2450 Fakturerad men ej upparbetad intäkt
- 1510 Kundfordringar (sometimes, for project-level receivables tracking)

**Class 8xxx (finansiella poster)** -- RARELY project-tagged.

**Class 9xxx (internredovisning)** -- Used for internal allocation between projects/cost centers. Debit and credit must balance within internal transfers. Never mixed with external accounts in the same report.

---

## 2. Core WIP accounts in detail

### Key project accounts (summary)

| Account | Name | Purpose |
|---------|------|---------|
| 1470 | Pågående arbeten | WIP asset under alternativregeln (completed contract) |
| 1620 | Upparbetad men ej fakturerad intäkt | WIP receivable under successiv vinstavräkning |
| 2420 | Förskott från kunder | Customer advance payments |
| 2450 | Fakturerad men ej upparbetad intäkt | Deferred revenue (invoiced > earned) |
| 4970 | Förändring pågående arbeten | P&L counterpart for 1470 adjustments |
| 3041 | Försäljning tjänster 25% | Typical project revenue account |
| 3980 | Erhållna offentliga bidrag | Grant revenue |

### 1470 Pågående arbeten för annans räkning

- Balance sheet: Omsättningstillgångar > Varulager
- Used under: alternativregeln (completed contract method)
- Purpose: capitalize project costs as inventory until assignment is substantially complete
- Normal balance: Debet
- Booking: Debet 1470 / Kredit 4970

Sub-accounts in practice:
- 1471 Pågående arbeten, nedlagda kostnader
- 1478 Pågående arbeten, fakturerat (contra, kredit)

Under K2 (alternativregeln), 1470 is valued at anskaffningsvärde (direct costs only). Under K3, the alternativregeln in juridisk person also uses 1470 but with a broader cost base.

### 1620 Upparbetad men ej fakturerad intäkt

- Balance sheet: Omsättningstillgångar > Kortfristiga fordringar
- Used under: successiv vinstavräkning (percentage of completion)
- Purpose: when recognized revenue exceeds invoiced amounts, carry difference as receivable
- Normal balance: Debet
- Booking: Debet 1620 / Kredit 3xxx (revenue account)
- CRITICAL: this entry carries NO MOMS. It is a pure periodisering.

Sub-accounts:
- 1620F Upparbetad ej fakturerad intäkt, fastpris
- 1620L Upparbetad ej fakturerad intäkt, löpande räkning

### 2450 Fakturerad men ej upparbetad intäkt

- Balance sheet: Kortfristiga skulder
- Used under: successiv vinstavräkning
- Purpose: when invoiced amounts exceed recognized revenue, carry difference as liability
- Normal balance: Kredit
- Booking: Debet 3xxx / Kredit 2450
- CRITICAL: moms on the underlying invoices must be reported at time of invoicing even though revenue is deferred

### 2420 Förskott från kunder

- Records customer advance payments before work begins
- Similar to 2450 but used for payments received before any invoicing/work

### 4970 Förändring av pågående arbeten

- P&L counterpart for 1470 adjustments
- Purpose: neutralize cost impact during project execution under alternativregeln
- Normal balance: Kredit (increases 1470 asset) or Debet (decreases 1470 at project completion)

### 38xx Aktiverat arbete för egen räkning

- 3800/3840 Aktiverat arbete för egen räkning
- Used when a company capitalizes internally generated assets (software, R&D)
- Project collects costs; at period end, capitalization entry: Debet 10xx (tillgång) / Kredit 38xx
- Only permitted under K3 aktiveringsmodellen. Prohibited under K2 (punkt 10.4).

### Moms timing mismatch

This is the highest-error-rate area in project accounting:

- **Upparbetad ej fakturerad intäkt (1620)**: pure periodisering, NO moms impact. VAT is only triggered when an actual invoice is issued.
- **Fakturerad ej upparbetad intäkt (2450)**: moms on those invoices must be reported AT TIME OF INVOICING even though accounting books revenue as liability.
- **Omvänd skattskyldighet** in construction: seller invoices without VAT when buyer "more than temporarily" sells byggtjänster. Per-project tracking of reverse charge status required.

The engine must track moms reporting independently from revenue recognition on every project.

---

## 3. Journal entry patterns by scenario

### Scenario A: Successiv vinstavräkning, upparbetad > fakturerad

Project X: total contract 1,000,000 SEK. Estimated total cost 800,000. At balance date: 400,000 costs incurred, 300,000 invoiced.

Färdigställandegrad = 400,000 / 800,000 = 50%
Upparbetad intäkt = 1,000,000 × 50% = 500,000
Difference = 500,000 - 300,000 = 200,000 (upparbetad > fakturerad)

```
Debet 1620 {6 "X"}  200,000
Kredit 3041 {6 "X"} 200,000
```

No moms on this entry. Moms was reported on the 300,000 invoice when issued.

### Scenario B: Successiv vinstavräkning, fakturerad > upparbetad

Project Y: total contract 500,000 SEK. Estimated total cost 350,000. At balance date: 70,000 costs incurred, 200,000 invoiced (advance billing).

Färdigställandegrad = 70,000 / 350,000 = 20%
Upparbetad intäkt = 500,000 × 20% = 100,000
Difference = 200,000 - 100,000 = 100,000 (fakturerad > upparbetad)

```
Debet 3041 {6 "Y"}  100,000
Kredit 2450 {6 "Y"} 100,000
```

The moms on the 200,000 invoice was already reported. This entry is a pure revenue deferral.

### Scenario C: Alternativregeln (completed contract), costs during project

Project Z ongoing. This month: 50,000 in direct costs (materials + labor).

Record costs normally:
```
Debet 4010 {6 "Z"}  30,000   -- materials
Debet 7010 {6 "Z"}  20,000   -- labor
Kredit 2440         30,000   -- supplier invoice
Kredit 1930         20,000   -- bank (salary)
```

At period end, capitalize to WIP:
```
Debet 1470 {6 "Z"}  50,000
Kredit 4970 {6 "Z"} 50,000
```

This neutralizes the P&L impact until the project is substantially complete.

### Scenario D: Project completion under alternativregeln

Project Z is väsentligen fullgjort. Total accumulated 1470 balance: 300,000. Final invoice: 450,000.

Reverse the WIP capitalization:
```
Debet 4970 {6 "Z"}  300,000
Kredit 1470 {6 "Z"} 300,000
```

Revenue is now recognized and costs hit the P&L. The invoice creates the normal revenue/receivable/moms entries.

### Scenario E: Befarad förlust

Project W: total contract 200,000. Estimated total cost now revised to 250,000. Incurred so far: 120,000.

Expected loss = 250,000 - 200,000 = 50,000. Must be recognized IMMEDIATELY.

Under successiv vinstavräkning:
```
Debet 4970 {6 "W"}  50,000
Kredit 2290 {6 "W"} 50,000  -- avsättning befarad förlust
```

The loss provision is booked even though only 120,000/250,000 of costs have been incurred.

### Scenario F: Overhead allocation

Shared office rent 100,000/month. Three active projects consuming 40%, 35%, 25% based on headcount allocation key.

```
Kredit 5010 {1 "ADMIN"} 100,000  -- reverse from admin cost center
Debet 5010 {6 "P1"}     40,000
Debet 5010 {6 "P2"}     35,000
Debet 5010 {6 "P3"}     25,000
```

Or using internal accounts (kontoklass 9):
```
Kredit 9510 {1 "ADMIN"} 100,000
Debet 9510 {6 "P1"}     40,000
Debet 9510 {6 "P2"}     35,000
Debet 9510 {6 "P3"}     25,000
```

---

## 4. Gemensamma kostnader and fördelningsnycklar

Shared costs that cannot be directly attributed to a single project must be allocated using fördelningsnycklar (allocation keys).

### Common allocation bases

| Allocation key | Best for | Calculation |
|---------------|----------|-------------|
| Direkta lönekostnader | Service/consulting firms | Project salary / Total salary |
| Antal timmar | Time-based work | Project hours / Total hours |
| Omsättning | Revenue-proportional costs | Project revenue / Total revenue |
| Kvadratmeter | Facility costs | Project space / Total space |
| Antal anställda/FTE | HR overheads | Project FTE / Total FTE |

### The SUHF model

Widely adopted beyond universities. Applies a full markup (OH-påslag) on the salary base covering both overhead and premises. The markup is calculated annually as: (total indirect costs) / (total direct salary costs) × 100%.

### Rules for internal allocation

- External cost accounts (class 5-8) must not be mixed with internal allocation accounts (class 9) in the same report
- Debit and credit must balance within internal transfers
- Allocation frequency: monthly for management reporting, at minimum at year-end for statutory
- Document the allocation key and its basis in the accounting policy

---

## 5. Project closing entries

When a project transitions to CLOSED status, these entries must be verified:

1. **All costs booked**: no outstanding supplier invoices, accruals complete
2. **Final WIP adjustment**:
   - Successiv vinstavräkning: clear 1620/2450 to zero for this project
   - Alternativregeln: reverse 1470 via 4970
3. **Garantiavsättning** (construction projects): Debet 6320 / Kredit 2290, typically 2-5% of contract value
4. **Final invoice issued**: all revenue recognized, moms reported
5. **Interimsposter cleared**: no residual periodiseringar on 17xx/29xx for this project
6. **Balance verification**: run project trial balance, confirm all project-tagged accounts net to zero (P&L is allowed to have residual; balance sheet accounts must be zero)