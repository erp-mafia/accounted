# Accounted Ledger-Bench

**Evaluating language models on real Swedish accounting work.**

Ledger-Bench is Accounted's internal-first, publicly documented benchmark for
the tasks an accounting agent actually performs under Swedish law: choosing
the right BAS account, reading a Swedish invoice, knowing the VAT rules, and
keeping a real double-entry ledger legal while working. It ranks both closed
and open-weights models, per task family, on correctness, calibration and
cost.

Inspired by [Ramp SWE-Bench](https://labs.ramp.com/swebench) (private,
production-grounded, aggregate-public), [SWE-bench](https://arxiv.org/abs/2310.06770)
(execution-based scoring) and [tau2-bench](https://arxiv.org/abs/2506.07982)
(agent environments with real state). None of those measure jurisdiction-real
accounting: no open, write-capable accounting-agent benchmark existed, so we
built one on the two expensive assets we already had, a legally compliant
double-entry schema whose invariants are enforced by database triggers, and a
test rig that runs it for real.

## Why we built our own

- Public leaderboards saturate and leak into training data; none resemble
  löpande bokföring under Bokföringslagen.
- We route real models in production (categorization, extraction, assistants,
  MCP agents). "Which model do we trust where, and at what cost" is a routing
  decision we want to re-answer every time a model ships.
- The definition of a *correct booking* is our domain moat. A benchmark is
  that definition made executable.

## Task families (suites)

Each suite is scored independently: there is deliberately no single blended
"Ledger-Bench score", because a model that reads receipts well but books
reverse charge wrong is exactly the distinction we need to see.

| Suite | n | What it measures | Oracle |
|---|---|---|---|
| **Booking** | 53 | BAS account + VAT treatment for one bank transaction with company context | Exact match against gold account (plus explicitly listed acceptable alternatives) and a 10-value VAT-treatment enum |
| **Reasoning** | 36 | Swedish VAT / bookkeeping-law knowledge: rutor, deadlines, thresholds, rate changes, correction rules | Deterministic answers (number, date, account, ruta, or one of fixed options) |
| **Extraction (OCR)** | 12 | Structured fields from rendered Swedish documents: invoices, receipts, credit notes | Per-field exact match after normalization; amounts at 0.01 tolerance; arithmetic invariants hold by construction |
| **Ledger-agent** | 3 | Multi-turn tool use against a real Postgres ledger: book, correct, settle | End state of the books via SQL assertions; legal invariants enforced by the production database triggers |

Difficulty tags (`core` / `hard` / `expert`) mark, respectively, everyday
bookings, the classic error classes (reverse charge, representation, asset
thresholds, 6/12/25 rate splits), and adversarial cases (a foreign brand
behind a Swedish reseller, prepayment rate rules, non-registered buyers).

**Evidence segments (booking).** The suite is split by what the model gets
to see, and reported separately, because the two segments answer different
questions. *Invoice attached* (34 tasks) includes underlag text, and Swedish
invoices state the VAT, so the VAT metric there measures evidence READING.
*Bank feed only* (19 tasks) shows nothing but counterparty, description and
amount, the common state of löpande bokföring, so the same metric there
measures domain KNOWLEDGE (does the model know Google Ireland means reverse
charge, SJ means 6 %). v1.0 published only the blended number and its VAT
column saturated at 100 %; v1.1 corrected this. A benchmark that cannot say
what it fixed cannot be trusted about what it measures.

## Where tasks come from

**Public split (this repository).** Every committed task is synthetic:
authored from Swedish law (ML 2023:200, SFL 2011:1244, BFL 1999:1078, BFNAR),
from the BAS 2026 chart, and from anonymized *error classes* we have observed
in production (for example the reverse-charge booking where a VAT account was
chosen as the cost account). Suppliers, org numbers and amounts are invented;
org numbers and OCR references are Luhn-valid but fake. Extraction documents
are rendered by `bench/scripts/generate-extraction-docs.ts`, and their gold
labels are emitted from the same constants that rendered the pixels, so
document and label cannot drift.

Because the repository is public, the public split can eventually leak into
training data, the same trade-off SWE-bench accepts. Scores on it are
comparable over time but not contamination-proof.

**Private split (planned, prod-derived).** Replayed real bookings and real
verified documents, following `scripts/backtest-categorize.ts` (which already
measures leakage-controlled categorization accuracy against real ledgers).
Never committed, never published beyond aggregates, and under a hard runner
rule: `data_class: "prod-derived"` tasks are refused for any provider except
the EU Bedrock deployment this product already trusts with customer data
(`bench/src/util.ts`, `assertDataClassAllowed`). This split is the
contamination-free instrument; the public split is the reproducible one.

## Harness: neutral scaffold

All models run the identical minimal scaffold, in the spirit of Ramp's use of
mini-swe-agent. We measure models, not our product pipeline (production adds
deterministic candidate retrieval, self-consistency sampling and calibration
on top; its accuracy is tracked separately by the backtest scripts).

- Byte-identical prompts per suite for every model. The booking suite's
  environment is the full BAS 2026 reference chart (1 290 accounts, committed
  at `tasks/booking/context-accounts.txt`).
- Vendor-default reasoning settings: no thinking parameters, no temperature
  overrides where the API rejects them (temperature 0 where the OpenAI-style
  surface accepts it; recorded per run).
- Single-call suites allow exactly one retry when the reply contains no
  parseable JSON object; the retry text is fixed and identical for all
  models. Parse failures after the retry score zero and are reported.
- The ledger-agent suite gives every model the same 8 tools (list, read,
  create-and-commit, a deliberately naive update tool, balances, done) with a
  turn cap per task. The update tool exists because the database refuses it
  on posted entries: whether the model respects BFL 5 kap. 5 § or tries to
  edit history, and whether it recovers from the refusal, is part of what we
  measure.
- No server-side fallbacks: a safety refusal scores as a failure for the
  model that refused.
- Extraction inputs are committed PNG renders (150 dpi), identical bytes for
  every model. Models without vision are excluded from that suite only.

## Scoring

- **Headline per suite: pass rate** (booking: account AND VAT treatment
  correct; reasoning: exact answer; extraction: all gold fields correct;
  ledger-agent: all end-state assertions hold). Reported with a Wilson score
  interval at z=1, matching how Ramp reports spread.
- **Automation coverage (booking).** The deployment question collapsed into
  one number: if bookings are auto-committed only when the model's stated
  confidence clears a threshold, what share of the work is automated while
  precision stays at or above the target (reported at 95% and 99%)? A model
  with uninformative confidence scores 0% regardless of accuracy.
- **Reliability (ledger-agent), pass^k.** Each agent task runs k=3 times;
  reliability is the share of tasks solved on EVERY attempt. An agent that is
  rerun monthly is only as good as its worst month.
- **Paired significance, not CI-overlap.** Following Anthropic's "Adding
  Error Bars to Evals" (arXiv:2411.00640), model comparisons use exact
  McNemar tests on paired task outcomes. The published ranking is grouped
  into statistical ties by leader-chaining (a model joins the group above it
  while McNemar vs the group leader gives p >= 0.05); a simplification of a
  compact letter display, stated as such. At v1.3's n=53 booking tasks, the
  top NINE models are one tie group: differences under ~8 points are noise
  at this size, which is said on the page rather than hidden, and is the
  standing argument for growing the task set.
- **Task discrimination audit.** Every task's point-biserial correlation
  with model total scores is published in the aggregate (the IRT-lite item
  audit; see arXiv:2505.15055). Negative discrimination (better models do
  worse) is the signature of defective gold: booking-040 was retired this
  way (r = -0.51), applied to all models equally by the curation-safe
  aggregator.
- **Strict and lenient dual scoring (booking), and the bias between them.**
  `Pass` accepts the gold account or any alternative listed on the task;
  `strictPass` requires the single gold account and the right VAT (the SQuAD
  EM-vs-F1 pattern). The acceptance lists were extended during curation when
  a model's answer proved defensible against the BAS chart, so the lenient
  rate is partly a function of what models answered: a known upward bias,
  worth ~25-32 points (Opus 96.2% lenient vs 71.7% strict; Sonnet 5 90.6% vs
  60.4%). Strict carries no such bias, sits in the range other accounting
  benchmarks report, and is the number to quote when comparing outward.
- **Regelverksfarskhet (reasoning).** The tasks about rules that changed in
  2025-2026 (marked `fresh: true`) are reported as their own subscore next
  to stable law: whether a model knows THIS YEAR's rates is a different
  question from whether it knows VAT.
- **Run-to-run variance is measured and disclosed.** A k=3 repeat study on
  a 12-task booking subsample (`results/variance/`) found aggregate pass
  rates moving up to 25 pp between identical runs for one model
  (Claude Sonnet 5: 100/92/75%) while others held within 0-8 pp. Single-run
  pass@1 therefore carries run noise on top of sampling noise; another
  reason the tie groups, not the raw ordering, are the citable result.
- **Verdicts.** Each model receives a revisor-style opinion on
  confidence-gated unattended booking, from published criteria:
  **tillstyrks** requires booking >= 85%, coverage@99% >= 50%, reasoning
  >= 80%, and a clean ledger-agent record; **tillstyrks med reservation**
  requires booking >= 75%, reasoning >= 60%, and a usable confidence gate
  (coverage@99% >= 20% or coverage@95% >= 50%); everything else is
  **avstyrks**. Criteria live in `src/aggregate.ts` and are deliberately
  retunable; the point is that the benchmark states an opinion and shows its
  arithmetic.
- **Secondary metrics:** booking account-accuracy and VAT-accuracy separately;
  extraction per-field accuracy; ledger-agent tool errors and invariant
  refusals; turns; wall-clock.
- **Calibration is first-class.** Booking and reasoning tasks ask the model
  for a confidence in [0,1]; we report expected calibration error (ECE, 10
  bins). An agent that books unattended is only as safe as its calibration:
  a model that is wrong at stated 0.95 is more dangerous than one that is
  wrong at stated 0.5. We know of no public leaderboard that ranks this.
- **A billing artefact worth knowing:** GPT-5.6 Terra Pro reports ~4x the
  input tokens of GPT-5.6 Luna on the identical prompt (76 630 vs 18 122
  median on booking; 2 663 vs 252 on reasoning), so the Pro tier evidently
  runs several internal passes and is billed per pass. Its cost figure is
  what you would pay; its token count is not a prompt-size comparison.
- **Cost per suite** computed from measured tokens at list prices, uncached,
  for every model. Provider-billed amounts stay in the raw records but are
  never compared: OpenAI's automatic prompt caching via OpenRouter made one
  model look ~6x cheaper than its list price in v1.2, which is a deployment
  property, not a model property. Prices are each vendor's first-party API
  list price at standard tier (no cache, batch or promo discounts); sources
  in `src/models.ts` notes. Surfaced by founder review; fixed in v1.3.
- **End state, not transcript.** The ledger-agent suite never grades prose.
  The seeded Postgres runs the production schema with every migration
  applied; balance, immutability, voucher sequencing and period locks are the
  same triggers production runs. TigerBeetle's protocol-aware
  deterministic-simulation stance, assert invariants from inside the system,
  transfers directly because the ledger *is* the system under law.

Runs are pass@1. Re-running a task supersedes the earlier record
(`aggregate.ts` keeps the latest per suite/task/model); repeated-run
reliability (pass^k) is future work.

## Validity controls

- `bench/scripts/validate-tasks.ts`: every gold account must exist in the
  committed chart, every VAT enum value must be legal, extraction gold must
  satisfy its own arithmetic (subtotal + VAT + rounding = total, breakdown
  sums match), all ids unique.
- `bench/scripts/selftest-ledger-env.ts`: before any model runs, the
  environment must *prove it can detect failure*: an unbalanced entry must be
  refused, a direct update of a posted line must be refused by the triggers,
  and every assertion program must fail on the untouched seed and pass after
  a simulated correct solution. A harness that cannot fail is not measuring.
- Acceptable-alternative accounts are explicit per task and were extended
  after adversarial review (for example, the 45xx underlag accounts that the
  SKV 4700 mapping derives rutor from are accepted alongside the natural
  cost accounts for reverse-charge purchases).
- Curation is versioned and applied to all models equally:
  `scripts/regrade-booking.ts` re-grades stored answers against current gold
  without re-spending model calls, and the aggregator only counts records
  whose task still exists, so a task removed for defective gold drops out of
  every model's aggregates at once.

## Changelog

**v1.1 (2026-08-31).** Added the bank-feed-only booking segment (18 new
tasks) after v1.0's VAT column saturated at 100 % via underlag leakage;
segments now reported separately. Removed one task in review (Apple B2B VAT
handling is genuinely inconsistent, no defensible single gold); reworded the
gym/friskvård task to pin who the gym's customer is; extended acceptable
accounts where model review surfaced equally chart-defensible answers
(5970 Internetreklam, 5061 Städning, 1211 Maskiner, 6980/6490, 2850, 5831,
5460). Aggregates now include per-segment metrics and a per-task outcome
matrix.

**v1.2 (2026-08-31).** Cross-vendor board complete: 14 models (4 Claude tiers
on Bedrock EU, 10 via OpenRouter) with full clean runs, automation coverage,
pass^3 agent reliability for every model, and verdicts. Harness-error
quarantine and the verdict evidence gate were added after OpenRouter's
credit balance poisoned a first campaign; provider marks (simple-icons,
MIT) shown for identification only.

**v1.0 (2026-08-31).** First full campaign: 4 suites, 4 models on Bedrock EU.

## What the cost axis is, and is not

Cost is measured tokens at vendor list price. In the neutral scaffold every
booking task ships the entire 1 290-account BAS chart as context (18 000 to
27 000 input tokens), so input dominates and the cost ranking is close to the
input-price ranking. That is the price of running *this benchmark*, not the
price of booking in production, where retrieval puts ~20 candidate accounts
in front of the model and caching applies. The comparison across models is
sound; the absolute number is not a production forecast. `Per correct`
divides cost by the strict pass rate, since a model that fails cheaply is
not cheap: GPT-5.6 Luna books a correct entry for $0.006, Opus 5 for $0.194,
a 33x spread that the raw cost-per-task column understates.

## External cross-check (published numbers, not measured by us)

DualEntry's 2026 Accounting AI Benchmark is the nearest comparable public
board and the page reports the agreement directly. **At the frontier the two boards converge to within about two points.**
Scored strictly, Claude Opus 5 differs from DualEntry's figure by -0.6 pp,
Gemini 3.1 Pro by -1.5 and GPT-5.6 Luna by -2.1: two benchmarks built
independently, in different jurisdictions, from different task types,
agreeing on the top of the field to inside a rounding error. That is the
strongest external validity evidence this benchmark has.

**Below the frontier Ledger-Bench is markedly harder**: Haiku 4.5 -36.3 pp,
GPT-OSS-120B -28.7, DeepSeek V4 Pro -25.4. The plausible reading is
jurisdiction transfer: naming one BAS account out of 1 290 and one VAT
treatment out of ten punishes a weak model far more than US-GAAP questions
do, while a frontier model carries its accounting competence across the
border. Rank agreement stays weak for that reason (Spearman rho = +0.22,
95% CI roughly [-0.46, +0.75] at n=10: not distinguishable from zero),
because the mid-field orders differently on each board.

Do not "correct" our numbers toward theirs. Their benchmark is **101
questions across 8 US-GAAP categories** (12-13 per category, deterministic
binary grading); Ledger-Bench is 104 Swedish-law tasks with 53 on booking
alone. At those sizes adjacent ranks on either board differ by single
questions, and the two measure different jurisdictions and task mixes.
Divergence is the expected result, not an error to tune away.

## External context (published numbers, not measured by us)

For placing these results among public instruments: DualEntry's vendor-run
US-GAAP benchmark (19 models, 101 ERP tasks) tops out at 79.2 % (Claude
Opus 4.7) with month-end close at 50 %; Vals AI's Finance Agent v1.1
(read-only analyst Q&A, 537 tasks) tops out at 64.4 %; tau2-bench (agentic
dual-control, no finance domain) has Qwen 3.5-397B at 87.9 %. None are
Swedish, none write against a legally constrained ledger, which is the gap
this benchmark exists to measure.

## Disclosure and limitations

- Task author: tasks and gold labels were authored with Claude (Fable 5)
  against the cited legal references, validated by the scripts above, and are
  open to review in this repository. When models from the same family are
  ranked, that is a bias surface the private prod-derived split does not
  share (its labels come from human bookings). Corrections via PR or issue
  are welcome and versioned.
- Model coverage: Anthropic tiers on the Bedrock EU deployment; GPT, Gemini,
  Grok and open-weights models (DeepSeek, Qwen, Llama, Kimi, GLM, GPT-OSS)
  via OpenRouter, slugs verified against the live catalog at enable time.
  OpenRouter throttles new accounts to 20 requests/minute per model; the
  adapter enforces a per-model gate plus 429 backoff.
- The booking suite's single gold account is a convention choice; Swedish
  practice sometimes admits several defensible accounts. We mitigate with
  explicit acceptable-lists, and report exact-gold agreement separately.
- 3 ledger-agent tasks are a probe, not a population. Growing this suite
  (dual-control interruptions, locked periods, SIE round-trips) is the
  highest-value expansion.

## Building the public page

The results page source is committed at `bench/site/page.template.html`
(two placeholders: `__LEADERBOARD_JSON__`, `__LOGOS_JSON__`).
`npx tsx bench/scripts/build-site.ts` injects the current
`results/leaderboard.json` and writes `bench/site/index.html`, so the
published page is always reproducible from the repo and can never drift
from the results it reports.

## Running it

```bash
# One-time: environment for the ledger-agent suite (real Postgres, all
# migrations, ports 54329/54330), then prove the oracle works:
npm run tools:pg:reset
npx tsx bench/scripts/selftest-ledger-env.ts

# Validate tasks after any edit:
npx tsx bench/scripts/validate-tasks.ts

# Run:
npx tsx bench/src/run.ts --suite all --model enabled
npx tsx bench/src/run.ts --suite booking --model claude-sonnet-5 --limit 5

# Aggregate results into results/leaderboard.json:
npx tsx bench/src/aggregate.ts
```

Credentials come from the repo's `.env.local` (AWS keys for Bedrock EU,
`ANTHROPIC_API_KEY` for first-party models, `OPENROUTER_API_KEY` for the
rest). Results land as append-only JSONL under `bench/results/runs/`.

## Roadmap: what this measures next

v1.5 measures models. Three further axes are planned and explicitly not yet
run, recorded here so the direction predates the numbers:

1. **Skills and instructions.** Hold the model fixed, vary the instruction
   set: bare prompt vs a domain skill carrying the BAS chart and VAT rules
   vs a full agent briefing. This turns "is the skill worth its tokens" into
   a measured quantity, and it is the axis closest to how Accounted actually
   ships behaviour.
2. **Harnesses.** The neutral scaffold makes models comparable and makes the
   scaffold an untested variable. Running the same tasks under
   retrieval-backed, self-consistency and staged-approval harnesses
   attributes the remaining error between model and plumbing.
3. **Systems.** The deliverable sentence is "this model books at X% inside
   Accounted and Y% inside another Swedish ledger". Tool surfaces, account
   defaults and posting rules are properties of the system, not the model,
   and measuring that difference is the reason to own the benchmark rather
   than cite someone else's.

## Future work

Grow the ledger-agent suite (dual-control: a simulated user books or locks
underneath the agent, per tau2-bench); pass^k reliability; the prod-derived
private split with human-booked gold labels; receipt-to-transaction matching
as a fifth suite (ground truth: human-attached document links); prompt-cached
cost reporting; a public results page.

## References

1. Jimenez et al. (2024), *SWE-bench: Can Language Models Resolve Real-world
   GitHub Issues?*, ICLR 2024.
2. Ramp, *Ramp SWE-Bench* (labs.ramp.com/swebench): private production tasks,
   public aggregates, behavioral metrics.
3. Barres et al. (2025), *tau2-bench: Evaluating Conversational Agents in a
   Dual-Control Environment*, arXiv:2506.07982.
4. TigerBeetle, protocol-aware deterministic simulation testing: the design
   stance that the system's own invariants are the oracle.
5. Tu et al. (2026), *BenchGuard: Automated Auditing of LLM Agent
   Benchmarks*, arXiv:2604.24955: benchmarks as coupled artifacts audited
   jointly, which `validate-tasks.ts` and the self-test implement in
   miniature.
