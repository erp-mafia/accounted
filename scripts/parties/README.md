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

## Pre-classifier shadow evaluation, 2026-09-02

`eval-preclassifier.ts` scores three routers on the same 180 held-out keys
(20 rows, chosen by md5 of the key, serve as few-shot examples and are never
scored). Rows the founder marked `unsure` always receive a label, so the
honest number is the one that excludes them.

| Router | Strict agreement | Excluding founder-unsure | Party TPR | Party TNR |
|---|---|---|---|---|
| Rules v0, lexicon from BAS account names | 0.917 | 0.965 | 0.992 | 0.930 |
| Rules v0, lexicon incl. BAS descriptions | 0.911 | 0.959 | 0.984 | 0.930 |
| Sonnet 5 on Bedrock EU, zero-shot | 0.861 | 0.906 | 0.906 | 0.977 |
| Sonnet 5 on Bedrock EU, 20 founder examples | 0.878 | 0.924 | 0.930 | 0.977 |

Read with two caveats. The rules were written after the labels were seen,
so their score is optimistic; the model scores are honest. And most of the
remaining disagreements are definitions, not errors: whether a Bolagsverket
fee is `authority` or `intermediary`, whether a marketplace or payment
processor (Amazon Marketplace, Stripe, Amex fees) is `party` or
`intermediary`, whether a card-platform line with a person's name (Pleo,
Google Ads) is `party` or `payroll`, and whether a pension insurance premium
is `party` or `payroll`. Settle those in the vocabulary above, relabel the
handful of rows, and re-run.

BAS description tokens in the lexicon make Google and Facebook look generic
because the descriptions name them as examples; the account-name lexicon is
the default for that reason. The model's remaining party misses are text
with a person's name or a card descriptor, exactly where a hard key from a
document would decide instead.

## Still to confirm in this phase

- SCB access: the free Företagsregistret API carries F-skattstatus,
  Momsstatus and Arbetsgivarstatus (verified on scb.se 2026-09-02); access
  requested by email, credentials pending.
- The pre-classifier and selection agreement bars (0.85 on the labelled set)
  are enforced by the shadow harness in phase 1, not here.
