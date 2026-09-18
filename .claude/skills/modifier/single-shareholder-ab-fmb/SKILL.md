---
id: modifier/single-shareholder-ab-fmb
tier: modifier
title: "Aktiebolag med en aktieägare (fåmansbolag)"
description: >
  Owner-managed Swedish AB: distinguish company money, salary, benefits, owner
  funding and dividends. Establish qualified-share status and the applicable
  income-year rules before using 3:12 or preparing the owner's K10.
trigger_signals:
  ownership: "single_shareholder"
  bas_account_patterns: ["2893", "2898", "2091", "2098", "2099"]
version: 2
---

# Owner-managed AB

## Establish the actual relationship

A single owner does not by itself establish employment, salary payments or qualified shares. Assess ownership/voting control, activity by the owner and related persons, and the applicable fåmansföretag rules. Qualified-share dividends and gains are governed principally by **IL 57 kap.**, not chapter 53.

Use [[horizontal/swedish-tax-planning]] for the detailed, income-year-specific 3:12 calculation; [[horizontal/swedish-payroll]] only when actual remuneration or employer obligations require it; and [[horizontal/swedish-financial-reporting]] for company reporting. Keep the owner's K10 separate from the AB's INK2.

## Salary, dividends and the 2026 reform

- Salary and dividends are different legal events. A dividend requires distributable funds, the ABL prudence assessment and a valid corporate resolution; a tax allowance is not permission to withdraw company cash.
- For income year 2026 (return filed in 2027), do not reuse the old simplified/main-rule choice or former minimum-salary and 4% ownership tests. The reformed wage-based allowance has its own calculation and a remaining cap linked to the owner's/related person's cash remuneration. Load the current tax-planning reference and verify against Skatteverket before calculating.
- Establish ownership at the beginning of the income year before assigning that year's gränsbelopp. Incorporating during the year does not create an automatic formation-year allowance.
- Dividends within the applicable allowance on qualified shares are generally taxed at 20%. A dividend taxed in the tjänst category is not thereby salary subject to employer contributions. Do not apply payroll charges merely because of that tax category.
- K10 reporting depends on the owner's actual qualified-share transactions. Skatteverket recommends filing K10 also in years without dividends or disposals to preserve the calculation of saved allowance; distinguish that recommendation from an unconditional annual filing duty.

## Funding, expenditure and distributions

- Match each owner's payment to the company purchase and actual personal outlay. BAS 2893 is the usual candidate for a short-term liability to a related person; verify the company's chart. Reimbursement clears that liability, not a second expense.
- Distinguish a shareholder loan from a shareholder contribution. A contribution is not automatically repayable debt; classification follows the agreement and corporate evidence.
- Use 2898 for a resolved but unpaid dividend where the company's chart agrees. Neither 2091 nor a positive bank balance proves that a proposed distribution is lawful.
- Preserve company-bank movements even where the purpose is private. Assess remuneration, reimbursement or another evidenced treatment and the loan restrictions in **ABL 21 kap.**; do not silently exclude the bank row or invent an owner receivable.
- Reconcile the company's equity and capital history separately from cash. Where ABL 25 kap. 13 § may apply, assess the need for a kontrollbalansräkning immediately; a later contribution does not by itself establish that earlier corporate duties were satisfied.

## Sources

- [Skatteverket: changed rules for income year 2026](https://www.skatteverket.se/foretag/drivaforetag/foretagsformer/famansforetag/andradereglerinforinkomstdeklarationen2027.4.4a54dc8b19aa6175a152359.html)
- [Skatteverket: K10 and the recommendation to file without a dividend](https://www.skatteverket.se/foretag/drivaforetag/foretagsformer/famansforetag/raknautskattenpadinutdelning.4.b1014b415f3321c0de27ce.html)
- [Aktiebolagslagen: chapters 17, 18, 21 and 25](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/aktiebolagslag-2005551_sfs-2005-551/)

Recheck rule applicability for the income year. Do not extrapolate transition rules for dormant companies or related-person transactions from a generic owner-managed-company label.
