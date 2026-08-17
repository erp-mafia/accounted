---
name: loop-regeluppdat
description: Monthly loop that scans official Swedish sources for new or changed laws and rules affecting accounting/finance software (VAT, payroll, BFN standards, deadlines, BAS chart, e-invoicing), checks whether the codebase already handles each change, and files deduped GitHub issues for the gaps. Use monthly or on-demand via /loop-regeluppdat. Follows .claude/loops.md (propose-don't-merge, tickets only, no auto-fix).
---

# loop-regeluppdat

**Goal:** no Swedish regulatory change that affects Accounted lands as a surprise. Each month:
sweep the official sources, keep only what touches our product surface, verify against the code,
and file a well-formed ticket for every real gap. **This loop never writes code.** Regulatory
changes touch money math, tax logic, and compliance surfaces, which the autonomy policy forbids
auto-fixing: tickets only. Read `.claude/loops.md` first.

## Preflight

`gh auth status`, repo `erp-mafia/accounted`. If it fails, stop and report "environment not
provisioned". Web access (WebSearch/WebFetch) must be available; without it, stop and report.

## 1. Due check (monthly semantics)

The scan log lives on a single pinned issue titled `Regeluppdat scan log` labeled
`loop:regeluppdat` (create it on the first ever run). Each run ends by commenting
`<!-- loop-regeluppdat-run: YYYY-MM -->` plus the run summary on it.
If a marker for the **current calendar month** already exists, report "not due" and stop, unless
the user invoked `/loop-regeluppdat` explicitly.

## 2. Sweep the sources

Cover every row; a source with nothing new is still reported as swept (silent truncation reads
as "covered everything"). Window: since the previous run marker (default: the last 45 days),
plus anything already announced with a future effective date.

| Source | What to look for |
|---|---|
| skatteverket.se (nyheter + rättslig vägledning, ställningstaganden) | VAT rates/rules, arbetsgivaravgifter, traktamente/milersättning amounts, basbelopp, deadline changes, AGI changes |
| bfn.se (beslut, nya/ändrade BFNAR, remisser) | K2/K3 changes, bokföringsregler, verifikationskrav |
| bolagsverket.se (nyheter) | filing mandates (digital årsredovisning), fees, form changes |
| regeringen.se + riksdagen.se (propositioner, SFS) | changes to BFL, ÅRL, ML (moms), SFL, ABL, IL that touch bookkeeping, invoicing, payroll, or retention |
| bas.se (BAS-kontogruppen) | new BAS chart year, new/removed/renamed accounts, SRU mapping changes |
| digg.se + EU ViDA track | e-invoicing/Peppol mandates and timelines |
| Secondary sweep: srfkonsulterna.se, far.se news | catch anything the primary sources buried |

Also sweep for date-triggered knowns: every January 1 and July 1 batch (rate years, basbelopp,
skiktgränser, avgifter) and any transition our own docs promise (search the repo for hardcoded
years/rates near their expiry).

**Relevance filter.** Keep a finding only if it affects: bookkeeping/verifikation rules, VAT
(rates, rutor, reverse charge, OSS), employer contributions or payroll (AGI, förmåner,
traktamente, semester), tax rates or deadlines, chart of accounts/SRU, year-end or
årsredovisning, SIE/INK2/NE formats, e-invoicing, document retention, or company law that our
flows encode. General business news is out of scope.

## 3. Verify against the codebase (the actual value of this loop)

For each surviving finding, before filing anything:

1. **Load the matching `swedish-*` skill** for the domain (vat, payroll, year-end-closing,
   financial-reporting, e-invoicing, ...). Never assess Swedish domain questions from training
   data.
2. **Grep the anchors** to see whether the change is already handled:
   - VAT: `lib/vat/`, `lib/bookkeeping/vat-entries.ts`, `lib/reports/` (moms), momsdeklaration rutor
   - Payroll/rates: `lib/salary/calculation-engine.ts`, `lib/salary/lonevaxling.ts`, `lib/salary/semesterberedning.ts`
   - Deadlines: `lib/tax/deadline-config.ts`, `lib/deadlines/`, `lib/tax/swedish-holidays.ts`
   - Chart of accounts: `lib/bookkeeping/bas-data/` (currently BAS 2026), `bas-data/sru-mapping.ts`
   - Year-end/bokslut: `lib/bokslut/`, `lib/core/bookkeeping/year-end-service.ts` (bolagsskatt)
   - Formats: `lib/reports/` (SIE, INK2, NE-bilaga, SRU), `lib/skatteverket/`
   - E-invoicing/Peppol: the `swedish-e-invoicing` skill documents our current stance
3. Check `DECISIONS.md` and search issues **state:all** for the same change: it may already be
   tracked, done, or explicitly declined.
4. Classify: **handled** (code already correct, note it in the run summary), **gap** (file a
   ticket), or **unclear** (file a ticket flagged for founder judgment; do not guess).

The `.claude/skills/swedish-*` skills are themselves a compliance surface: if a law changed,
the skill text is now stale. A confirmed change therefore usually yields a ticket with two
checkboxes: update the code AND update the affected skill.

## 4. File tickets (cap: 6 new issues per run)

Fingerprint = the change's official identifier (SFS number, BFNAR number, Skatteverket dnr, or
`<source-domain>/<slug>` when nothing better exists) plus the effective year, never a timestamp.
Dedupe per `.claude/loops.md` (search state:all, comment instead of duplicate, reopen if
recurring). Then file:

- Title: `regeluppdat: <short description> (effective <date>)`
- Body: what changed (with source links), who it affects (EF/AB, which flows), what the code
  does today (file:line evidence from step 3), suggested change, effective date, and
  `<!-- loop-fingerprint: regeluppdat-<id> -->`.
- Labels: `loop:auto`, `loop:regeluppdat`, plus `bug` if we are already non-compliant today or
  `enhancement` if the change is upcoming.
- Anything already in force that we get wrong also gets `loop:needs-human` (compliance exposure
  is a founder call, not a backlog item).

If the sweep yields more than 6 gaps, file the 6 with the earliest effective dates and list the
rest in the run summary so the next run (or a human) picks them up.

## 5. Run marker + report

Comment on the `Regeluppdat scan log` issue: `<!-- loop-regeluppdat-run: YYYY-MM -->`, sources
swept, findings kept/discarded by the relevance filter, handled vs gap vs unclear counts, issues
filed (numbers), overflow list. That summary is the completion notification.

## Anti-thrash

Never re-file a fingerprint that a human closed without action: closed + `wontfix` (or a closing
comment declining it) means the decision is made; note it in the run summary instead. If the
same finding keeps resurfacing across sources, one ticket, many source links.
