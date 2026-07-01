---
name: loop-design-scan
description: Local loop that scans a given area of the Accounted UI against the locked design system (.claude/rules/design.md) for UX friction, visual inconsistency, missing states, motion gaps, and accessibility issues — rendering pages in Chrome — then files GitHub issues for approved findings. Run locally (needs npm run dev + Chrome). Usage: /loop-design-scan <area> (e.g. bookkeeping, invoices, settings).
---

# loop-design-scan

**Goal:** for one area of the app, surface concrete, design-system-grounded UI/UX improvements and file
them as GitHub issues (deduped). This is the GitHub-Issues sibling of the `scout-design` skill (which
targets Linear). Read `.claude/loops.md` first. **Runs locally** — it needs to render the UI.

## Why local
A headless cloud session can't see the UI. This loop starts `npm run dev` and drives Chrome to render
and screenshot real pages, then judges them against the design rules. Run on-demand or `/loop 6h /loop-design-scan <area>`.

## 1. Set up
- `npm run dev` (starts on :3000). Load the **design contract**: `.claude/rules/design.md`
  (editorial monochrome, locked tokens, primitives, spacing scale, a11y bar).
- Map the area to its route(s), e.g. `bookkeeping` → `app/(dashboard)/bookkeeping/*`.

## 2. Render & inspect each page (Chrome MCP)
For each page in the area: navigate, screenshot, and check the **console for zero new errors/warnings**.
Exercise key states where possible: loading, empty, populated, error.

## 3. Evaluate against the design system (what "good" means here)
Flag concrete deviations, each tied to `file:line` and a rule:
- **Tokens/spacing**: forbidden spacing (`p-5`, `2.5`, hardcoded px), non-token colors for status
  (`bg-blue-100`, `bg-emerald-500/10` instead of `<Badge variant>`).
- **Primitives not used**: hand-rolled empty state / skeleton / page header / table instead of the
  components in `.claude/rules/design.md` (`EmptyState`, `Skeleton`, `PageHeader`, `Table`).
- **Missing states**: no loading skeleton, no empty state, no error handling on a data view.
- **Typography**: `font-medium` on Hedvig display text; missing `tabular-nums` on financial numbers.
- **Motion**: press-scale / hover-lift / spring overshoot (all forbidden); missing `transition-colors`.
- **A11y**: contrast < AA, icon-only button without `aria-label`, no visible focus ring, touch target < 40px.
- **UX friction**: unclear labels, redundant `PageHeader.description`, slow paths for the 90-second session.

## 4. Adversarial verification (kill false positives)
Prefer the **`.claude/workflows/design-scan.js`** workflow: it fans out one agent per page, then runs a
skeptic agent per finding ("is this a real regression against the locked design system, or a nitpick?").
Only findings that survive get filed. Cap **6 findings/run**; log the rest.

## 5. File issues (deduped — see loops.md)
```
Title: [design] <area>: <short problem>
Labels: loop:auto, loop:design, enhancement
Body: what's wrong (with file:line) · which design rule it breaks · concrete before→after · screenshot ref
      <!-- loop-fingerprint: <area>:<file>:<rule> -->
```
Dedupe against existing `loop:design` issues before filing. Do not auto-fix UI here — design changes
want human taste; file the ticket. (If asked to fix, use `/frontend-design` on an approved ticket.)
