# Data use clause for the customer agreement (draft for counsel)

Status: DRAFT v2 (2026-10-24). Not legal advice, not in force, and not yet
in any signed agreement. The terms now live in this repo (`src/app/(public)/terms`, the
2026-03-05 text moved from accounted.se). Since 2026-10-21 `/dpa` point 5
covers the counterparty directory and the anonymised statistics as
instructions; the broader grant below still has to land in a new terms
version, accepted in the app, before anything in it takes effect.

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
rather than a precondition, and an off switch in the product. Draft Swedish
text (v2, 2026-10-24):

> **Användning av Kunddata.** Accounted har rätt att använda och lagra
> Kunddata, inklusive uppgifter om hur Tjänsten används och om anrop och
> återkoppling från agenter som Kunden har kopplat, för att fullgöra sina
> åtaganden mot Kunden, för statistiska ändamål, samt för att
> tillhandahålla, utvärdera, förbättra och utveckla Tjänsten, inklusive den
> automatiska konteringen. Accounted anonymiserar eller aggregerar Kunddata
> som används för dessa ändamål i största möjliga utsträckning, och
> sammanslagna mönster tas fram först när samma mönster förekommer hos minst
> [fem] av varandra oberoende kunder, så att ingen enskild kunds bokföring kan
> utläsas ur resultatet. Accounted säljer aldrig Kunddata eller uppgifter som
> kan knytas till Kunden, och lämnar inte ut sådana uppgifter till tredje part
> för dess egna ändamål. Anonymiserad och aggregerad statistik som inte kan
> knytas till någon enskild kund får Accounted använda och tillhandahålla även
> utanför Tjänsten.

What changed from v1, and why:

- **Agent interaction data is named.** Tool calls, feedback and approvals
  from the customer's own agents are the record the product learns from
  (`mcp.telemetry`, `pending_operations`). v1 covered them only by reading
  "Kunddata" broadly.
- **"Never sold" is narrowed to what can be tied to the customer.** v1's
  "Kunddata säljs inte" would also rule out anonymous aggregates (an industry
  payment-time index, a public agent benchmark). Anonymous output is outside
  GDPR; the promise that matters to a customer is that nothing about them is
  sold, and v2 says exactly that.
- **The k-threshold is in the text** as a number, not "ett tillräckligt
  antal". [fem] is the recommendation (open item 3).
- Selling a customer's own data on their behalf (verified books to a lender
  the customer picks) needs no clause: the customer starts it, per request.

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
- Agent telemetry is kept as anonymous daily counts after the raw rows are
  purged at 180 days (`mcp.telemetry_rollup`, 2026-10-24): no identifiers or
  free text, so it needs nothing from this clause.

## Open items

1. Counsel review of the clause and the DPA amendment together.
2. A new terms version to carry it (the terms live in
   `src/app/(public)/terms`), and a way for existing customers to accept it:
   the in-app acceptance prompt is switched off (`PROMPT_ENABLED = false` in
   `LegalAcceptanceGate.tsx`, founder decision 2026-10-22). Either turn it on
   for this version or pick another route (a notice by e-mail with a date it
   takes effect, accepted by continued use, is the usual one; counsel to
   confirm it is enough for a DPA change).
3. Decide the k-threshold for pooled patterns. Measured on prod 2026-09-22:
   k>=2 gives 974 (counterparty, account) pairs, k>=5 gives 115, k>=10 gives
   32. Recommendation: k>=5 for anything drawn from a company's own
   bookkeeping, and k>=2 only for public counterparties (merchants,
   authorities, banks), which is what `/dpa` point 5 already allows for the
   counterparty catalog. k>=2 over bookkeeping lets two companies infer each
   other; k>=10 leaves too little to learn from at today's size.
4. Retention for anything derived from identifiable Kunddata. Note that if a
   derived table ever carries transaction-identifying data, BFL 7 kap
   retention and the append-only guard rail apply to it.
