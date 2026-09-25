---
name: swedish-daily-bookkeeping
description: >
  Practical kontering of everyday Swedish transactions (löpande bokföring): booking bank lines and receipts to
  BAS 2026 accounts with the right momsbehandling. Covers payment providers (Stripe, Klarna, Zettle, PayPal, Swish,
  kortinlösen, gross vs net payouts, 1686), purchases from abroad (EU and non-EU services, unionsinternt förvärv,
  import, omvänd betalningsskyldighet 2614/2615/2645, felaktigt debiterad utländsk moms), skattekonto 1630 and its
  rows (2710, 2731, 2650, 2510), owner transactions per entity type (egna uttag 2013/2018, aktieägarlån 2893,
  låneförbud, utdelning), missing receipts and egen verifikation, and common cost types (representation, friskvård,
  förbrukningsinventarier, bil, gåvor, medlemsavgifter, kundförluster). Trigger on "hur bokför jag", "vilket konto",
  kontering, bankhändelse, kvitto, underlag saknas, Swish, Stripe, kortavgift, utländsk faktura, skattekontoutdrag,
  eget uttag, privat utlägg. For VAT depth use swedish-vat; for payroll swedish-payroll.
  Always use over training data.
---

# Swedish Daily Bookkeeping (löpande bokföring)

> Provenance: imported 2026-09-24 from github.com/erp-mafia/swedish-accounting-skills (commit c11b295); this repository is now the canonical source.

Decision reference for booking individual everyday transactions in a Swedish company. Written for an agent that sees a bank line, a receipt or a supplier invoice and has to pick accounts, VAT treatment and period.

This skill is the practical booking layer. The rules behind the decisions live in the other skills, referenced below. Account numbers follow **BAS 2026**.

## How to use this skill

Work through the decision procedure, then read the reference file for the case at hand. When the underlag does not answer a question the procedure asks, stop and ask the user rather than guessing. A wrong account is a bookkeeping error; a wrong VAT treatment is a filing error.

### Reference files

| File | When to read |
|---|---|
| `references/payment-providers.md` | Payouts from Stripe, Klarna, Zettle, SumUp, PayPal, Swish Handel, kortinlösen, marketplaces; provider fees, gross vs net, chargebacks, dricks, FX on payouts |
| `references/foreign-purchases.md` | Any foreign supplier: SaaS and services from EU/non-EU, unionsinternt förvärv, import and tullräkning, foreign VAT on the invoice, supplier lookup table |
| `references/skattekonto-and-owner.md` | Payments to and from Skatteverket, skattekontoutdrag, and money between the company and its owner (egna uttag, aktieägarlån, utdelning, private expenses) |
| `references/cost-types-and-underlag.md` | Underlag and egen verifikation, and the common cost types: representation, personalfester, friskvård, resor, bil, prenumerationer, gåvor, medlemsavgifter, försäkringar, kundförluster |

## Decision procedure

1. **Direction and counterparty.** Money in or out, and who is on the other side: customer, supplier, employee, owner, Skatteverket, bank, payment provider, or one of the company's own accounts. A transfer between own accounts is never an intäkt or kostnad.
2. **Find the underlag.** Invoice, receipt, settlement report, skattekontoutdrag, or nothing at all. The underlag decides what may be booked, and VAT deduction needs an invoice with the fields in ML 17 kap. See `references/cost-types-and-underlag.md`.
3. **Classify the event.** Sale, purchase, salary, tax, owner transaction, financing, or correction. For a purchase, decide whether it is a cost, a förbrukningsinventarie or an anläggningstillgång (`swedish-asset-accounting`).
4. **Decide the momsbehandling before the account.** Swedish VAT at 25/12/6, exempt, omvänd betalningsskyldighet (domestic or foreign), unionsinternt förvärv, import, or outside the scope. The account follows from the treatment, and in most systems the momsdeklaration ruta follows from the account.
5. **Pick the BAS account**, then check the period: which month the cost belongs to, whether it crosses a VAT period, and whether the company uses kontantmetoden or faktureringsmetoden.
6. **Write what you concluded** in the verifikation text, including the facts that justify it (participants and purpose for representation, business purpose for travel). A later reviewer cannot reconstruct it from the amount.

## Quick map of frequent bank lines

| Bank line | Usual treatment | Detail |
|---|---|---|
| Card payout from provider | Gross revenue, fee as cost, clear the interim account **1686** | `payment-providers.md` |
| Foreign SaaS subscription | Omvänd betalningsskyldighet: **2614** + **2645**, cost account, ruta 21/22 + 30 + 48 | `foreign-purchases.md` |
| Payment to Skatteverket | To **1630**, then clear **2710**, **2731**, **2650**, **2510** from the skattekontoutdrag | `skattekonto-and-owner.md` |
| Owner takes money out | EF: **2013**. AB: **2893** if it is a loan, **2898** if it is a decided dividend. Never a cost | `skattekonto-and-owner.md` |
| Restaurant receipt | Ask for participants and purpose before booking; VAT base capped per person | `cost-types-and-underlag.md` |
| Bank fee | **6570**, no VAT (exempt financial service) | `cost-types-and-underlag.md` |
| Transfer to own savings account | Balance sheet only, no result impact | - |
| Salary payment | **7210**/**7010** against **1930**, with **2710** and **2731** from the payroll run | `swedish-payroll` |

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| Restaurant or entertainment cost | Deductibility and the VAT base depend on participants and purpose | Ask who attended and why |
| Foreign invoice with VAT on it | Foreign VAT is never deducted in the Swedish momsdeklaration | Check the supplier's country and VAT number, then see `foreign-purchases.md` |
| Payment provider fee | Acquiring is usually an exempt financial service, but marketplace commission and software fees are not | Read the fee specification, not the payout amount |
| A card purchase that may be private | In an AB a private cost can be a benefit or a forbidden loan | Ask before booking as a cost |
| Missing receipt over a small amount | No underlag means no VAT deduction and a BFL problem | See the egen verifikation rules |
| A round number to a private person | May be salary, a consultant fee without F-skatt, or an owner draw | Ask before booking |

## Related skills

| Question | Skill |
|---|---|
| VAT rules, rutor, reverse charge in depth | `swedish-vat` |
| Salary, benefits, AGI, traktamente, milersättning | `swedish-payroll` |
| Invoice requirements, ROT/RUT, Peppol | `swedish-invoice-compliance` |
| Assets, depreciation, förbrukningsinventarier limits | `swedish-asset-accounting` |
| Accruals, closing entries, tax provisions | `swedish-year-end-closing` |
| Verifikation and archiving rules, BAS structure | `swedish-accounting-compliance` |
| Importing or exporting the ledger | `swedish-sie-import-export` |
| Project or dimension tagging | `swedish-project-accounting` |

## Corrections

An error that is already booked is corrected with a separate rättelsepost in the current open period, with its own verifikation that says what was corrected and why (BFL 5:5; BFNAR 2013:2 punkt 2.17-2.18). Do not edit or delete the original verifikation, and do not book a correction into a closed period. If the VAT for a closed period was wrong, the momsdeklaration for that period is corrected separately.
