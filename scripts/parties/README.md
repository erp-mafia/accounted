# Parties, phase 0: measure before building

Phase 0 of the Kontakter plan (design doc: the "Vem du gör affärer med"
artifact, 2026-09). Nothing in this phase changes product behaviour. It makes
the resolver measurable so the model steps in later phases can be judged
against labelled data instead of opinions.

## What ships in this phase

- Migration `20260902120000`: enables `pg_trgm` (trigram blocking of
  counterparty keys) and drops the two context-graph tables whose feature code
  was never merged and which prod no longer has. Test:
  `tests/pg/parties-phase0.pg.test.ts`.
- `draw-golden-set.sql`: the reproducible draw of the labelling sample and the
  payee-change base rate. Read-only.

## The golden set (never in git)

The draw returns customer voucher text, which can contain person names. The
repository is public, so the drawn rows and the labels live in
`dev_docs/parties/golden/` (gitignored). Only aggregates and this vocabulary
are versioned.

Label vocabulary for the pre-classifier, one per key:

| label | meaning | example |
|---|---|---|
| `party` | a real counterpart the company pays or invoices | `Levfakt Beijer Byggmaterial AB (2089)`, `Loopia` |
| `category` | an expense description with no counterpart in it | `Inköp av varor`, `Banktjänster`, `Fika` |
| `payroll` | salary, benefits, expense claims to a person | `Löneutbetalning: 2024.M.01 - anställd: 5` |
| `adjustment` | periodisering, kostnadsföring, omföring, lagerförändring | `Periodisering av leverantörsfaktura 1311` |
| `authority` | Skatteverket, Bolagsverket, Transportstyrelsen, kommun | `Bolagsverket ändra bolagsordning` |
| `bank` | bank fees and bank products | `Baspaket Bank`, `Avgift Amex` |
| `intermediary` | payment rail or marketplace, not the counterpart | `Klarna`, `Stripe`, `Zettle`, `AmazonMktplc` |
| `unsure` | cannot tell from the text alone | |

A key whose text names a vendor but is booked as a category still gets
`party`: the resolver decides identity, the account comes from the ledger.

## Measured on prod, 2026-09-02

- 113,032 imported expense vouchers across 385 real companies; 99.5% yield a
  key; 71% belong to a key that repeats within the company.
- Payee-identity base rate: 365 suppliers have an established bankgiro on two
  or more documents; 13 of them (3.6%) carry two established bankgiro numbers,
  with an average span of 29 days between them, which reads as parallel
  accounts or OCR variance rather than changes over time. Any distinct value
  at all: 8.4%. Consequence for the signal: a new bankgiro is rare enough to
  warrant a "verify" sentence, never a block, and a value must be seen on two
  documents before it counts as known.

## Still to confirm in this phase

- Which registration flags the free SCB Företagsregistret API exposes
  (moms, arbetsgivare, F-skatt). This decides how much of rung three can skip
  TIC.
- The pre-classifier and selection agreement bars (0.85 on the labelled set)
  are enforced by the shadow harness in phase 1, not here.
