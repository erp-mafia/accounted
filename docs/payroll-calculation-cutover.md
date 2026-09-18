# Payroll calculation and categorized cutover balances

This draft adds general payroll corrections and migration primitives. It is not a
production-readiness or compliance certification. Examples in the tests are
synthetic. No customer imports, reports, credentials or reconciliation data are
included.

## Calculation corrections

- Consume signed absence deductions once, including legacy rows with deduction flags.
- Include signed taxable cash additions and preserve manual vacation compensation
  when replacing engine-generated rows. Do not accrue compensation on itself.
- Weight absence by scheduled hours; include first-day sick pay and cap the waiting
  deduction at available sick pay, carrying unused amounts across month boundaries.
- Share partial-month base calculations between the engine and displayed salary row.
- Use explicit company policies for calendar-day proration, long leave, hourly sick
  rates, leave context and rounding. Defaults preserve existing policy choices.
- Support an independently verified one-off tax percentage, separate from the
  monthly tax-table base. Group same-rate payments before rounding; employee tax
  decisions retain precedence. No automatic annual-income estimation is included.
- Carry effective tax overrides consistently into run totals and YTD snapshots.

Company policy is exposed through the existing salary settings API. It is replaced
as a whole, not deep-merged; calculations store the resolved policy. These controls
are API-backed, without a new dashboard policy editor.

## Cutover representation

The opening-balance API accepts a `vacation_balance` remaining-day snapshot with its
own cutoff, year start, annual entitlement, tracking status, paid and extra-paid
days, unpaid and advance days, saved days by origin year, and a source reference.
This is not another annual allocation. Legacy flat fields must agree with the
snapshot; older clients cannot silently overwrite it with conflicting values.

Line APIs accept `vacation_movements`: explicit dated withdrawals with a category
and, for saved days, an origin year. Only withdrawals after the opening cutoff and
through the applicable run cutoff consume balances. Previously consumed days are
not deducted again. Unclassified post-cutoff vacation lines and source-review
holds stop calculation rather than guessing. Correction runs preserve movements.

Historical net payments and monetary vacation liabilities may be unknown (`null`).
They are not inferred from gross less tax or converted to zero. PDFs mark unknown
net history explicitly; liability reporting refuses to report a complete total
when the opening liability is unknown. Day balances do not establish a liability
in kronor.

Mid-month starters can have an explicitly zero monetary opening at the start of
their employment month, while vacation grants still start on the employment date.
This prevents a later monetary cutover from hiding their first in-system salary.

## Schema and migration review

Seven additive, timestamped migrations cover calculation provenance, company
policies, one-off tax, explicit zero vacation tracking and categorized balances.
Existing migrations and protected accounting triggers are unchanged. Database
checks enforce category shapes and dates. Rollback-only PostgreSQL tests exercise
the checks and nullable persistence using synthetic records.

Older automatic vacation rows have no reliable provenance. Ambiguous rows block
recalculation pending explicit classification, rather than deleting a possible
manual payment. There is intentionally no guess-based legacy backfill.

## Required before production acceptance

- Categorized vacation-year rollover remains blocked until category-specific
  carryover and monetary bases are implemented. The legacy rollover must not
  flatten extra-paid, unpaid or advance categories into saved days.
- Approval/booking lifecycle and concurrent or post-calculation edits of opening
  balances need verification. A calculated vacation snapshot can become stale
  after an opening edit; the current YTD refresh does not refresh that snapshot.
- A complete categorized-balance dashboard editor is not included.
- Irregular schedules, per-child parental entitlement, persisted waiting-deduction
  consumption across changing rates and complete sickness history need more work.
- Absence data must explicitly identify sickness during vacation. No automatic
  inference from incomplete source records is provided.
- Approval, posting, bank export, statutory filing, delivery and debt collection
  are not end-to-end certified by these calculation tests.

Keep the change in draft review until these limitations and the rollout boundary
have been accepted. No production migration, payment, posting, filing or delivery
has been performed as part of this contribution.
