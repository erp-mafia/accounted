---
name: loop-verify
description: The self-verification gate every automated code change must pass before a loop opens a PR. Encodes Accounted's real CI commands (check:lint, vitest, pg-real, check:guards, no-extension-imports) plus the accounting guard rails and i18n sync. Invoke from any loop-* skill after making a fix and before pushing.
---

# loop-verify: verification gate for automated changes

Never report a change as done, and never open a PR, based on "the edit applied" alone. Verify it
the way our CI would. If any step fails, fix and rerun from the top: do not push partially
verified work.

## 0. Guard rails first (hard stops, no fix is worth breaking these)
Read [Hard Rules](../../../CLAUDE.md#hard-rules). A change is **rejected outright** if it:
- edits or deletes a `posted` journal entry (use `reverseEntry`/`correctEntry`, storno, never edit),
- makes an entry that doesn't balance, or sets a voucher number manually,
- writes to a locked/closed period, or deletes a retained document,
- uses `toFixed()` for money (must be `Math.round(x * 100) / 100`), or treats account numbers as numbers (they are strings: `'1930'`).
- touches a trigger/RPC/RLS/DEFERRABLE object without a `*.pg.test.ts` (see step 3).

## 1. Scope the blast radius
List changed files (`git diff --name-only`). Decide which checks below are required:
- always: lint + guards on touched code.
- touched `lib/**` or `app/api/**` → run the matching `__tests__` with vitest.
- touched `supabase/migrations/**` (trigger/RPC/RLS/DEFERRABLE) → **pg-real is mandatory**.
- touched types / config / a shared primitive → run the build.
- touched a user-facing string → i18n sync (step 5).

## 2. Lint + guards (fast, always)
```bash
npm run check:lint       # fails on NEW eslint errors (legacy errors are grandfathered)
npm run check:guards     # scripts/checks/no-new-antipatterns.mjs
```
Core must not import extensions (CI enforces this):
```bash
grep -r "from '@/extensions/" lib/ app/api/ components/ --include="*.ts" --include="*.tsx" \
  | grep -v "app/api/extensions/" | grep -v "components/extensions/" \
  | grep -v "lib/extensions/_generated/" | grep -v "lib/extensions/loader.ts"
# any output = FAIL
```

## 3. Tests (targeted)
Run the tests covering the touched area, not the whole suite (cost):
```bash
npx vitest run --project unit <dir>     # e.g. lib/bookkeeping app/api/invoices
```
If a trigger / RPC / RLS / DEFERRABLE constraint or any `supabase/migrations/**` object changed,
a `*.pg.test.ts` **must** exist/extend and pass:
```bash
npm run test:pg     # vitest run --project pg-real (real Postgres)
```
No pg-real coverage for a DB-behavior change ⇒ do not open the PR; add the test first.

## 4. Build (only when needed)
If types/config/generated inputs changed, or lint/tests can't prove the change compiles:
```bash
npm run build
```
If you edited an atom `SKILL.md` run `npm run skills:check`; taxonomy inputs → `npm run taxonomy:check`.

## 5. i18n sync
For any new/changed user-facing string, update **both** `messages/en.json` and `messages/sv.json`
(mirror the same keys). See [i18n rule](../../rules/i18n.md) for "stays Swedish" surfaces
(email/invoices/reports/salary): those stay Swedish regardless of locale.

## 6. Verdict
- All required steps green → safe to push the `loop/*` branch and open the PR.
- Anything red you can't safely fix in-scope → **stop**, label the PR/issue `loop:needs-human`,
  and comment exactly which step failed and the output. Never merge (`gh pr merge` is forbidden).
