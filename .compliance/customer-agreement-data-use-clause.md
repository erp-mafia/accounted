# Data use clause for the customer agreement (draft for counsel)

Status: DRAFT. Not legal advice, not in force, and not yet in any signed
agreement. Accounted has no terms-of-service document in this repo; the only
customer-facing legal surfaces are `/privacy` and `/dpa`. The clause below has
to land in a signed customer agreement, and `/dpa` has to be amended to match,
before anything in it takes effect.

## Why this exists

`company_settings.data_analysis_opt_in` was a per-company consent toggle that
gated all cross-company analysis. It was retired (migration 20260922173222)
because the thing it gated, the auto-booking calibration corpus, no longer
contains tenant data: the rows lost `company_id` and `amount`, and the fit job
only ever read `confidence` and `was_correct`.

That removal stands on its own and needs no contract change. The clause is for
what comes next: pooled patterns such as "this supplier is normally booked to
5410", derived across tenants. Deriving those is processing of tenant
bookkeeping data for Accounted's own purpose, so the right to do it has to be
granted somewhere.

## The clause

Broad grant over Kunddata, with anonymisation as an obligation of effort
rather than a precondition. Draft Swedish text:

> **Användning av Kunddata.** Accounted har rätt att använda och lagra
> Kunddata för att fullgöra sina åtaganden mot Kunden, för statistiska
> ändamål, samt för att tillhandahålla, utvärdera, förbättra och utveckla
> Tjänsten, inklusive den automatiska konteringen. Accounted anonymiserar
> eller aggregerar Kunddata som används för dessa ändamål i största möjliga
> utsträckning, och sammanslagna mönster tas fram först när samma mönster
> förekommer hos ett tillräckligt antal kunder för att ingen enskild kunds
> bokföring ska kunna utläsas ur resultatet. Kunddata säljs inte och lämnas
> inte ut till tredje part för dess egna ändamål.

## What this costs, and what has to change with it

The grant reaches identifiable Kunddata, not only anonymised output. Anonymous
data sits outside GDPR; identifiable data does not. Three consequences follow,
and none of them is optional:

1. **`/dpa` § 2 contradicts this clause as written.** It states that Accounted
   processes personal data "endast enligt den Ansvariges dokumenterade
   instruktioner". Processing tenant data for Accounted's own purpose is not
   that. The DPA has to be amended and existing customers re-papered, or the
   clause has no effect for anyone already signed up.
2. **`/privacy` needs revisiting.** Section 3 currently gives Art. 6.1a
   consent as the basis for AI features that send data onward, and section 5
   describes the narrower anonymised-statistics position. Both have to be
   reconciled with the broader grant, and a legitimate-interest assessment
   (LIA) documented for the identifiable-data processing.
3. **`.compliance/ropa.yaml`** carries `calibration.anonymous_statistics` with
   `lawful_basis: art_6_1_f` scoped to the anonymisation step. A broader
   processing activity needs its own entry with its own basis and retention.

Deliberately **not** included in the draft above, though comparable clauses in
this market do include them, because nothing in the product needs them:

- a right to use Kunddata for marketing to the customer;
- a right to transfer Kunddata to group companies, suppliers or partners for
  their own purposes.

Add either only on a deliberate decision. Both widen the disclosure burden
sharply and both are visible to anyone reading this repo.

## What the code does today

The code is narrower than the clause, and stays that way until someone changes
it on purpose:

- The calibration corpus is anonymous by construction: no `company_id`, no
  amount, no free text. Pinned by
  `app/(public)/privacy/__tests__/ai-and-replay-disclosures.test.ts`.
- Evaluation backtests do not read live customer books. They run on sandbox
  companies unless `BACKTEST_COMPANY_IDS` names a company explicitly.
- Pooled patterns are not built yet.

## Open items

1. Counsel review of the clause and the DPA amendment together.
2. A terms-of-service document to carry it. None exists today.
3. Decide the k-threshold for pooled patterns and write it into the clause or
   the privacy policy. Measured on prod 2026-09-22: k>=2 gives 974
   (counterparty, account) pairs, k>=5 gives 115, k>=10 gives 32.
4. Retention for anything derived from identifiable Kunddata. Note that if a
   derived table ever carries transaction-identifying data, BFL 7 kap
   retention and the append-only guard rail apply to it.
