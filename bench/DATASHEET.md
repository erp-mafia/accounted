# Datasheet: Accounted Ledger-Bench (public split)

Following the structure of Gebru et al., *Datasheets for Datasets*
(arXiv:1803.09010), condensed to what applies.

## Motivation

Created by Accounted (Arcim AB) to measure how well language models perform
real Swedish accounting work: BAS account selection, VAT-law knowledge,
document field extraction, and multi-turn bookkeeping against a live
double-entry ledger constrained by Bokföringslagen. No open, write-capable,
jurisdiction-real accounting benchmark existed. Funded and maintained by
Accounted; used both for public reporting and internal model routing.

## Composition

103 tasks in four suites (booking 52, reasoning 36, extraction 12,
ledger-agent 3), all `data_class: public`. Every instance is synthetic:
invented suppliers and amounts, Luhn-valid but fake org numbers and OCR
references, program-rendered documents whose gold labels are emitted from
the same constants that render the pixels. No personal data, no customer
data, no real transactions. Tasks carry difficulty tags, legal references,
per-task rationales, an evidence-segment marker (booking), a freshness
marker (reasoning tasks on rules changed 2025+), and a contamination canary
string (`bench/tasks/CANARY.txt`).

## Collection and labeling

Tasks were authored with Claude (Fable 5) against primary legal sources
(ML 2023:200, SFL 2011:1244, BFL 1999:1078, BFNAR, the BAS 2026 chart) and
anonymized error classes observed in production. Gold labels are
machine-validated (`bench/scripts/validate-tasks.ts`: chart membership,
arithmetic invariants, enum validity) and curated under a published
discipline: acceptable-alternative accounts are explicit per task; tasks
with negative discrimination (better models scoring worse) are retired in
review; every gold change is re-graded retroactively for all models
equally and recorded in the changelog.

Known bias: authorship by a model family that is also ranked. Two controls
test it rather than assert it away. Every gold answer is audited by models
from other vendors (`bench/scripts/audit-gold.ts`), which found and fixed a
substantive error (full input VAT deducted in a VAT-exempt dental practice)
and a gold that was less precise than an unlisted alternative; the record of
what the audit changed is kept in `bench/site/audit-resolutions.json`, since
the published agreement rate is measured after those fixes. Separately,
`bench/scripts/gold-bias-test.ts` compares the Claude advantage on tasks
curation touched against tasks it never revisited: author-family bias
predicts a larger advantage where curation reached, and the advantage is
smaller there. Neither control removes the bias, only two of its mechanisms.
The planned prod-derived private split (human bookings as labels) does not
share it.

## Recommended uses

Evaluating language models on Swedish accounting competence; regression
testing across model releases; calibration research (tasks elicit stated
confidence). NOT suitable for: training (see canary), legal advice, or
ranking claims finer than the published statistical tie groups support.

## Distribution and license

Distributed inside the Accounted repository (AGPL-3.0). An explicit
separate data license for the task files (e.g. CC BY 4.0) is an open
maintainer decision; until then the repository license governs. Provider
marks shown on the results page are their owners' trademarks, used for
identification only.

## Maintenance

Maintained in `bench/` with versioned changelog in `bench/README.md`.
Corrections via pull request are welcome; every published routing criterion
and every statistical method is in-repo and re-runnable
(`npm run bench:aggregate`). The scored task set and scoring parameters are
content-hashed in `bench/freeze.json` and checked in CI (`npm run bench:check`),
so a gold correction is a reviewable diff, not a silent change; scoring
parameters are pre-registered in `bench/src/scoring-config.ts`. Raw per-run records are committed under
`bench/results/runs/` (board data) and `bench/results/variance/`
(methods studies).
