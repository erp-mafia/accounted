# Tax Implications and Grant Accounting for Projects


<!-- toc -->
**Contents**

- [1. Materiellt samband principle](#1-materiellt-samband-principle)
- [2. Tax treatment of pågående arbeten](#2-tax-treatment-of-pågående-arbeten)
- [3. Löpande räkning tax divergence](#3-löpande-räkning-tax-divergence)
- [4. Forskningsavdrag (R&D payroll deduction)](#4-forskningsavdrag-rd-payroll-deduction)
- [5. Aktivering av utvecklingsutgifter](#5-aktivering-av-utvecklingsutgifter)
- [6. EU grants and offentliga bidrag](#6-eu-grants-and-offentliga-bidrag)
- [7. Omvänd skattskyldighet in construction](#7-omvänd-skattskyldighet-in-construction)

<!-- /toc -->

---

## 1. Materiellt samband principle

Under 14 kap. IL (Inkomstskattelagen), the reported accounting result is the starting point for taxable income. Revenue recognition choices in the financial accounts flow directly to taxation. This means:

- A K3 company using successiv vinstavräkning recognizes taxable income earlier (as completion progresses)
- A K2 company using alternativregeln defers taxable income until project completion
- Switching between methods has immediate tax consequences
- Consistency is required: the same method must be used for both accounting and tax on identical contract types

The tax authority (Skatteverket) follows the accounting treatment unless specific tax provisions override it.

---

## 2. Tax treatment of pågående arbeten

### Fixed-price contracts (uppdrag till fast pris)

17 kap. 24-32 §§ IL govern WIP valuation for tax purposes.

Under the alternativregeln, pågående arbeten (1470) may be valued at:
- Direct costs (direkt hänförliga utgifter)
- With the option to apply the 97% rule (17 kap. 27 § andra stycket IL): value WIP at no less than 97% of the total anskaffningsvärde, providing a small tax buffer. Only for fixed-price work in byggnads-, anläggnings- och hantverksrörelse (not konsultrörelse); the 17 kap. 4 § 97% rule concerns lager

Anti-avoidance provision (17 kap. 31 § IL): revenue must be recognized when invoicing has been significantly delayed beyond god affärssed. A company cannot indefinitely defer revenue by simply not invoicing a completed project.

Under successiv vinstavräkning, the accounting-based revenue recognition flows directly to tax via the materiellt samband. No separate tax adjustment is needed for fixed-price contracts.

### INK2 adjustments

When accounting and tax treatment diverge (see section 3), adjustments are made in the inkomstdeklaration:
- INK2 ruta 4.3 c: Bokfört resultat justeras med redovisade ej skattepliktiga intäkter
- INK2 ruta 4.5: Skattemässiga justeringar av intäkter och kostnader

The engine should track which revenue items require INK2 adjustment per project.

---

## 3. Löpande räkning tax divergence

This is the most critical tax-accounting divergence in project accounting.

### The rule

For time-and-materials contracts (löpande räkning), taxation may be based on **invoiced amounts**, even when accounting recognizes upparbetad ej fakturerad intäkt.

Legal basis: 17 kap. 26 § IL, which applies to pågående arbeten in byggnads-, anläggnings-, hantverks- eller konsultrörelse (17 kap. 23 §):
- The value of pågående arbeten på löpande räkning need not be taken up as an asset, so upparbetad ej fakturerad intäkt (1620) need not be taxed
- Instead, amounts invoiced during the beskattningsår are taken up as income
- Limit: if the company to a significant extent has not invoiced amounts that could have been invoiced under god redovisningssed, the amounts that could reasonably have been invoiced are taxed (17 kap. 31 §)

### Practical consequence

The bookkeeping engine must maintain DUAL revenue figures for every T&M project:
1. **Accounting revenue**: upparbetad intäkt (hours × rate, reflecting work performed)
2. **Tax revenue**: fakturerad intäkt (amounts on issued invoices)

The difference creates a temporary tax difference:
- If accounting revenue > invoiced: positive temporary difference → uppskjuten skatteskuld (K3 only; K2 prohibits uppskjuten skatt)
- If invoiced > accounting revenue: negative temporary difference → uppskjuten skattefordran

### INK2 handling

At year-end, the difference between accounting and tax revenue for T&M projects must be reported as an adjustment in INK2. The engine should automatically calculate this as: `Σ(accounting_revenue - invoiced_revenue)` across all löpande räkning projects.

---

## 4. Forskningsavdrag (R&D payroll deduction)

### Current rules (Lag 2023:747)

Companies employing personnel working on R&D (forskning eller utveckling) receive a 20% reduction in arbetsgivaravgifter.

Requirements per employee:
- ≥50% of working time spent on qualifying R&D activities
- ≥15 hours per month on R&D

Cap: SEK 3,000,000 per month per group (koncern). At 31.42% arbetsgivaravgifter, this allows deduction on salary costs up to approximately 9.5 MSEK/month.

### Project accounting connection

Project-level time tracking is ESSENTIAL for forskningsavdrag compliance:
- Time reports must distinguish R&D hours from non-R&D hours per employee
- Projects must be classified as R&D or non-R&D
- Monthly time summaries per employee must demonstrate the 50%/15h thresholds
- Documentation must be retained for Skatteverket review

The engine should:
1. Allow project-level R&D classification
2. Aggregate employee time across R&D-classified projects
3. Calculate monthly R&D percentage per employee
4. Flag employees meeting/not meeting the threshold
5. Calculate the deduction amount for arbetsgivardeklaration

### Proposed reform (SOU 2025:3)

A reform proposal would replace the payroll deduction with either:
- A 300% cost deduction for qualifying R&D expenses, OR
- A 20% refundable tax credit (skattereduktion)

If adopted, project-level R&D cost tracking (not just time) would become the basis. The engine should be prepared to track total project costs for R&D-classified projects.

---

## 5. Aktivering av utvecklingsutgifter

### K3 Chapter 18 (immateriella tillgångar)

Companies may choose between:
- **Aktiveringsmodellen**: capitalize qualifying development costs as intangible assets
- **Kostnadsföringsmodellen**: expense all development costs immediately

Once chosen, the model applies to all development activities (no cherry-picking).

### Activation criteria (punkt 18.12)

ALL SIX conditions must be demonstrated:
1. Technical feasibility of completing the asset
2. Intention to complete and use/sell
3. Ability to use or sell the asset
4. How the asset will generate probable future economic benefits
5. Availability of adequate resources (technical, financial) to complete
6. Ability to reliably measure expenditure attributable to the asset during development

Research-phase costs (punkt 18.11) must ALWAYS be expensed, regardless of model choice.

### Project accounting for activation

The project serves as the cost collector during the development phase:
1. Classify project as "development" or "research" (or mixed, requiring phase separation)
2. Accumulate qualifying costs on the project: direct salary, materials, directly attributable overhead
3. At period end, capitalize accumulated costs: Debet 10xx (immateriell tillgång) / Kredit 38xx (aktiverat arbete)
4. Transfer equivalent amount to fond för utvecklingsutgifter (restricted equity per ÅRL 4 kap. 2 §)
5. Begin amortization when the asset is ready for use, over its nyttjandeperiod (K3 18.19); if the nyttjandeperiod cannot be determined with reasonable certainty it is deemed to be 5 years (ÅRL 4 kap. 4 §)

### Tax treatment

Since 2019: interest costs may NOT be included in the tax-basis anskaffningsvärde, even when K3 allows their inclusion in accounting. The engine must track a separate tax-basis value excluding capitalized interest.

Skatteverket position: aktivering following K3 creates a materiellt samband. The capitalized amount is tax-deductible through annual avskrivning, not at the time of expenditure. The fund för utvecklingsutgifter has no tax effect.

### K2 prohibition

Punkt 10.4: egenupparbetade immateriella tillgångar får inte aktiveras. Everything must be expensed. A partially purchased asset becomes tainted as internally generated if incorporated into unique development. This is a hard constraint with no exceptions.

---

## 6. EU grants and offentliga bidrag

### K3 Chapter 24

Offentliga bidrag are recognized based on performance conditions:

- **Grants with future performance requirements**: recognized as revenue when performance conditions are satisfied
- **Grants without conditions**: recognized as revenue when received
- **Grants related to assets**: reduce the carrying amount of the asset OR recognized as intäkt over the asset's useful life

### BAS accounts

| Account | Purpose |
|---------|---------|
| 3980 | Erhållna statliga bidrag |
| 3981 | Erhållna EU-bidrag |
| 3989 | Övriga erhållna bidrag |
| 2880 | Skuld offentliga bidrag (liability for unearned grants) |
| 1790 | Övriga fordringar (approved but unreceived grants) |

### Project accounting for grants

Grant-funded projects require tracking:
1. Total granted amount and disbursement schedule
2. Eligible costs (per grant agreement, often narrower than accounting costs)
3. Co-financing requirements (own contribution percentage)
4. Reporting periods and deadlines
5. Repayment risk if conditions are not met

The engine should support:
- Grant budget vs actual tracking per project
- Eligible cost filtering (which cost categories qualify)
- Period reporting aligned to grant reporting periods (often different from fiscal year)
- Automatic matching of received payments to 2880 liability releases

### VAT on grants

Grants are generally not subject to VAT (not consideration for a supply). However, if a grant is conditional on delivering specific goods/services to the grantor, it may be reclassified as consideration and become subject to moms. The classification affects both the VAT treatment and the BAS account used (3xxx vs 39xx).

---

## 7. Omvänd skattskyldighet in construction

### When it applies

Reverse charge VAT applies in the construction sector when:
1. The seller provides byggtjänster (construction services)
2. The buyer is a company that itself "more than temporarily" provides construction services

### Covered services

- Bygg- och anläggningsarbeten
- Bygginstallationer (VVS, el, ventilation)
- Slutbehandling av byggnader (målning, golvläggning)
- Rivningsarbeten
- Uthyrning av personal för byggtjänster
- Uthyrning av maskiner med förare för bygg

### NOT covered

- Arkitektverksamhet
- Byggkonsultverksamhet (engineering, project management)
- Projektledning (unless physically performing construction)
- Leverans av byggmaterial utan installation
- Städning (unless part of a construction contract)

### Project accounting impact

Each project must track whether reverse charge applies, and this can vary within a single project if there are mixed services. The engine must:

1. Per-project (or per-transaction) reverse charge flag
2. Seller perspective: invoice utan moms, buyer self-assesses
3. Buyer perspective: report both utgående and ingående moms (BAS 2614/2645 for 25%)
4. Momsdeklaration: reverse charge amounts in ruta 24 (byggtjänster) and ruta 30 (ingående moms)

A construction project may have some subcontractors subject to reverse charge and others not (e.g., an architect is not subject to reverse charge). Per-line handling is required.