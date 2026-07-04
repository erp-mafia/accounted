#!/usr/bin/env node
/**
 * CI gate: a PR that adds or changes a migration touching a trigger,
 * function/RPC, RLS policy, or DEFERRABLE constraint must also add or extend
 * a *.pg.test.ts.
 *
 * This enforces the rule documented in .claude/rules/database.md ("pg-real
 * tests: any PR touching a trigger/RPC/RLS/DEFERRABLE must include or extend
 * a *.pg.test.ts"): previously instruction-only, which means it got skipped.
 *
 * Escape hatch: a migration may declare, in a SQL comment, either
 *   -- pg-test: covered-by tests/pg/<file>.pg.test.ts
 *   -- pg-test: skip (<reason>)
 * Both are visible in review and greppable later. Use them sparingly:
 * "covered-by" when an existing test already exercises the changed object,
 * "skip" when the change is genuinely untestable (e.g. a NOTIFY-only fixup).
 *
 * Scope: the gate is PR-level, not per-migration: ANY *.pg.test.ts change
 * satisfies it. With multiple risky migrations in one PR, reviewers must
 * still confirm each one is actually covered (or carries an escape hatch);
 * mapping tests to migrations automatically would be guesswork.
 *
 * Usage: node scripts/check-pg-test-coverage.mjs
 *   PG_GATE_BASE: git ref to diff against (default: origin/main)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const base = process.env.PG_GATE_BASE || 'origin/main'

let changed
try {
  // Three-dot diff: changes on the PR side since the merge-base with `base`.
  // --diff-filter=ACMR skips deletions (a deleted migration has no content to
  // scan). execFileSync with an argv array: no shell, so a hostile base-ref
  // string can't inject (git just rejects an invalid rev via the catch below).
  changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
} catch (err) {
  console.error(`check-pg-test-coverage: failed to diff against "${base}".`)
  console.error('Set PG_GATE_BASE to a fetched ref (CI: origin/${{ github.base_ref }}).')
  console.error(String(err))
  process.exit(2)
}

const migrations = changed.filter(
  (f) => f.startsWith('supabase/migrations/') && f.endsWith('.sql'),
)
const pgTests = changed.filter((f) => f.endsWith('.pg.test.ts'))

// DDL that the database.md rule classifies as requiring real-Postgres coverage.
const RISKY_DDL = [
  { kind: 'trigger', re: /\bCREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i },
  { kind: 'function/RPC', re: /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i },
  { kind: 'RLS policy', re: /\b(CREATE|ALTER|DROP)\s+POLICY\b/i },
  { kind: 'RLS enable/disable', re: /\b(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY\b/i },
  { kind: 'DEFERRABLE constraint', re: /\bDEFERRABLE\b/i },
]

const ESCAPE_HATCH = /^\s*--\s*pg-test:\s*(covered-by\s+\S+|skip\b.*)$/im

const flagged = []
for (const file of migrations) {
  if (!existsSync(file)) continue
  const raw = readFileSync(file, 'utf8')
  if (ESCAPE_HATCH.test(raw)) continue
  // Strip SQL line comments so prose mentioning "CREATE POLICY" doesn't trip the gate.
  const sql = raw.replace(/--.*$/gm, '')
  const kinds = RISKY_DDL.filter(({ re }) => re.test(sql)).map(({ kind }) => kind)
  if (kinds.length > 0) flagged.push({ file, kinds })
}

if (flagged.length === 0) {
  console.log(
    migrations.length === 0
      ? 'check-pg-test-coverage: no migrations in this diff.'
      : `check-pg-test-coverage: ${migrations.length} migration(s) changed, none touch trigger/RPC/RLS/DEFERRABLE.`,
  )
  process.exit(0)
}

if (pgTests.length > 0) {
  console.log(
    `check-pg-test-coverage: ${flagged.length} risky migration(s) accompanied by pg-real test change(s):`,
  )
  for (const t of pgTests) console.log(`  test: ${t}`)
  process.exit(0)
}

console.error('check-pg-test-coverage: FAILED\n')
console.error(
  'These migrations touch trigger/RPC/RLS/DEFERRABLE but the PR adds or extends no *.pg.test.ts:\n',
)
for (const { file, kinds } of flagged) {
  console.error(`  ${file}  (${kinds.join(', ')})`)
}
console.error(`
The repo rule (.claude/rules/database.md) requires real-Postgres coverage for
these objects: mocked Supabase tests cannot exercise them.

Fix one of:
  1. Add or extend a *.pg.test.ts covering the changed trigger/RPC/policy
     (helpers: tests/pg/setup.ts, tests/pg/fixtures.ts; run: npm run test:pg)
  2. If an existing pg test already covers it, annotate the migration:
       -- pg-test: covered-by tests/pg/<file>.pg.test.ts
  3. If genuinely untestable, annotate with a reason:
       -- pg-test: skip (<reason>)
`)
process.exit(1)
