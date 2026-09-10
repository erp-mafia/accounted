# Underlag → förslag: byggplan

Founder decision 2026-09-08 ("Implement it") on the decision page
"Från underlag till förslag" (claude.ai/code/artifact/f6f23dbf-44ca-4f0c-b14e-b03727289058).
This file is the plan of record for the build; the page is the reasoning.

Answers taken on the four open questions, per the page's recommendations:
pass 1 links from day one (reference or öre-exact amount, unique candidate,
counterparty has earned it); foreign VAT posture is prefilled from country
and kind; the profile text is visible on the Motparter card with edit; the
cross-tenant prior is used at lowest weight and stated in the privacy policy.

## Principle

Deterministic where the answer is known, model where it is unclear, cached
where it repeats, measured before it acts alone. Haiku on the volume, Sonnet
on the residue, a calibrated verifier in between, never the model's own
self-reported confidence.

## Sequence and status

| Step | What | Status |
|------|------|--------|
| 0 | Shadow log + rejections table + calibration table from the 553 answered proposals. Mode switch `ARRIVAL_MATCH_MODE=shadow\|propose\|act`. | PR 1 (this branch) |
| 1a | Matching at arrival for every channel: extraction hook, `transaction.synced` hook, daily cron. One-to-one assignment, uniqueness gate, vetoes (inflow, purchase with document, live proposal, rejected pair, amount cap 10 000 kr), autonomy earned per counterparty (3 confirmed, ≤1 declined), booked verifikat without document in the pool, 30-day window. | PR 1 (this branch) |
| 1b | Expected rows: `expected_transactions` from sent invoices, supplier invoices, salary runs, tax payments, and subscriptions detected in profiles; matched before the general matcher; expired = "väntad, kom aldrig". | next |
| 1c | Cheap model tier in lib/ai (Haiku), pg_trgm/embedding candidates, Haiku as name-equivalence judge in the 0.6–0.8 band replacing the Sonnet adjudicator. | next |
| 1d | Att göra row for proposals with method label (Förväntad / Referens / Belopp / Minne / Modell), evidence deltas, undo with trace. On the UI v2 chain. | after v2 cutover |
| 2a | Document into the proposal: mapping engine and suggest-categories take extracted supplier + line items; counterparty templates match on the invoice supplier; extraction gains `country`; sender domain stored; case-insensitive legal forms. | next |
| 2b | Supplier resolver with constrained actions (link / create / reassign), validator, duplicate tuple (supplier, invoice number, amount). | next |
| 3a | Counterparty profile at first sight → party_facts source=model with evidence spans; VAT posture derived from country + kind; prompt, candidates and Motparter card read it; AI card cached per counterparty; reverse-charge prompt fixed for non-EU services. | next |
| 3b | Cross-tenant prior (aggregated party graph), "varför ändrade du?" guidance with backlog re-evaluation, question queue by information gain (max 3 per session), privacy-policy line. | next |
| later | Own 4B model for coding on the self-hosted stack. | not started |

## Measures (all read from match_shadow_log)

- overrides per 100 automatic links, per counterparty segment
- coverage at 98 % precision
- share of documents matched at arrival; share of bookings that confirmed an expected row
- questions per booked row
- median time from document to booked

## Operating notes

- `scripts/calibrate-matcher.ts` prints precision per score interval from
  answered proposals and writes `lib/underlag/calibration.json` with `--write`.
- Set `ARRIVAL_MATCH_MODE=shadow` on a deploy to log without acting;
  `propose` to never link; unset or `act` for the full behaviour. Links are
  gated by earned autonomy regardless of mode.
- The receipt hunt keeps its allowlist for the mail-search leg; the arrival
  matcher runs for every company because it only links what a counterparty
  has earned.
