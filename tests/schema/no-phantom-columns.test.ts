import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MASTER_DATA_DUMP_TABLES,
  ARCHIVE_COVERED_ELSEWHERE_TABLES,
  ARCHIVE_EXCLUDED_TABLES,
} from '@/lib/reports/full-archive-export'
import {
  buildSchemaFromMigrations,
  closedValueSets,
  listSourceFiles,
  scanColumnRefs,
  scanSourceText,
  type ScanResult,
  type SchemaModel,
  type TableModel,
} from './schema-guard'

/**
 * The phantom-column net.
 *
 * `createQueuedMockSupabase()` is chainable and permissive: `.eq('nope', 1)` and
 * `.select('does_not_exist')` resolve happily, so a green unit test says nothing
 * about whether a column exists. That blind spot kept article delete broken for
 * ten days, hid sixteen more phantom-column sites, two phantom CHECK values
 * (`source_type = 'transaction'` against a real `bank_transaction`: 0 rows where
 * prod has 3 917) and one `onConflict` naming a dropped unique constraint, which
 * raised 42P10 on every call. Mocked tests provably cannot catch that class.
 *
 * This test compares two things that cannot lie to each other: the schema
 * replayed from `supabase/migrations/*.sql`, and every Supabase query builder
 * chain in the source, read through the TypeScript AST. It follows the shape of
 * `tests/pg/full-archive-coverage.pg.test.ts`, which likewise reads the schema
 * and asserts a contract against checked-in code.
 *
 * GROUND TRUTH: the migration files. Not a live database (a pg-real test would
 * be authoritative but only runs in the `test-pg-real` CI job, so a developer's
 * `npm test` would never see it), and not a checked-in snapshot (which rots).
 * Replaying the migrations costs ~250ms, runs everywhere, and has no artifact to
 * go stale: the migrations are already the repo's contract with prod. No test in
 * this file connects to any database.
 *
 * FAILURE MODE: named columns that resolve confidently are asserted hard, minus
 * an explicit baseline of pre-existing breakage below. Expressions the scanner
 * cannot resolve (a payload built at runtime, an interpolated select) are counted
 * against a documented ceiling instead of failing, because failing on every
 * unresolvable expression would make the guard noise and get it disabled.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Pre-existing phantom-column sites, found when this guard was introduced and
 * deliberately NOT fixed here (the fix belongs with the owner of each surface).
 * Keyed `table.column @ file` so a line shift does not churn but a NEW file
 * adopting the same phantom column still fails.
 *
 * Remove an entry when the site is fixed: a stale entry fails this test on
 * purpose, so the list can only shrink.
 */
const KNOWN_PHANTOM_COLUMNS: Record<string, string> = {}

/** Pre-existing `.from()` targets that no migration creates. */
const KNOWN_PHANTOM_TABLES: Record<string, string> = {}

/** Pre-existing literal values that no CHECK constraint allows. */
const KNOWN_PHANTOM_VALUES: Record<string, string> = {}

/** Pre-existing `onConflict` targets with no matching unique constraint. */
const KNOWN_STALE_ON_CONFLICT: Record<string, string> = {}

/**
 * Ceiling on expressions the scanner cannot resolve to a concrete column.
 * These are legitimate patterns (a payload assembled at runtime, an interpolated
 * select, a spread), not defects: the ceiling exists so a refactor that hides a
 * large slice of the query surface behind dynamic construction is visible rather
 * than silent. Headroom is deliberate; lower it when the number drops.
 *
 * Baseline 2026-07-26: 346 (145 dynamic-payload, 116 dynamic-select,
 * 48 dynamic-logical, 32 spread-payload, 4 dynamic-column, 1 computed key).
 *
 * 2026-08-01: 361 after the white-label build (WL-17: brands, teams.kind,
 * cockpit, brand mail). The growth is spread across ordinary feature queries;
 * ceiling raised 360 -> 370 to restore headroom.
 *
 * Raised 2026-08-06 for the sandbox seed's payroll + ledger-history builders.
 * app/api/sandbox/seed/ follows the pure-row-builder pattern the existing
 * customers.ts / pending-operations.ts modules established: the builder returns
 * complete row objects and route.ts spreads them, adding only the ids it had to
 * insert first (voucher_number, journal_entry_id, account_id). The scanner
 * cannot see through that spread. Writing the columns out again in route.ts to
 * satisfy the scanner would duplicate every builder's shape at the call site,
 * which is the thing the builders exist to prevent, and the row shapes are
 * covered by their own unit tests instead.
 *
 * Baseline 2026-08-06: 370 (158 dynamic-payload, 120 dynamic-select,
 * 47 dynamic-logical, 38 spread-payload, 5 dynamic-column, 2 computed key).
 *
 * 2026-08-12 +3: lib/webshop-orders/ingest.ts builds partial UPDATE payloads
 * at runtime (frozen rows get safe fields only; unfrozen rows get optional
 * parent/legacy links). Writing the shapes as inline literals would need one
 * variant per key combination; the row shapes are covered by ingest.test.ts.
 *
 * 2026-08-26 +2: the customer pickers in InvoiceEditor and
 * NewRecurringScheduleDialog hide archived customers but must keep the one the
 * draft already points at, which is a PostgREST logical filter
 * `.or('archived_at.is.null,id.eq.<uuid>')`. The id is a runtime value, so the
 * expression cannot be a literal; both columns are real and the filter is
 * covered by the archived-counterparty tests.
 *
 * 2026-08-17 +1: lib/import/skattekonto-file/import-service.ts inserts parsed
 * statement rows via a mapped batch (same shape as every other file importer);
 * the row shape is covered by the execute route tests and the pg-real suite.
 *
 * 2026-08-21 +1: lib/invoices/peppol-inbound.ts updates the processing state
 * of an inbound Peppol document through one helper (five literal shapes:
 * routed / unrouted / converted / failed, all partial); the column set is
 * pinned by peppol-inbound.test.ts and the pg-real immutability test.
 *
 * 2026-08-26 merge of add/white-label-infra with main: both sides' growth
 * lands at once (WL queries + everything above). Count on the merged tree:
 * 383 (162 dynamic-payload, 125 dynamic-select, 50 dynamic-logical,
 * 39 spread-payload, 5 dynamic-column, 2 computed key); ceiling re-baselined
 * with the usual headroom.
 */
const UNRESOLVED_CEILING = 385

/**
 * Floor on statically resolved column references. Guards the guard: if a change
 * to the scanner or to the client wrappers stops resolving chains, this fails
 * instead of the net silently going slack.
 *
 * Baseline 2026-07-26: 13 734.
 */
const RESOLVED_COLUMN_FLOOR = 13_500

let schema: SchemaModel
let scan: ScanResult
const valueSets = new Map<string, Map<string, Set<string>>>()

function closedFor(table: TableModel): Map<string, Set<string>> {
  let sets = valueSets.get(table.name)
  if (!sets) {
    sets = closedValueSets(table)
    valueSets.set(table.name, sets)
  }
  return sets
}

// Explicit hook timeout: this replays every migration AND parses the whole
// app/lib/components/extensions/hooks/scripts tree through the TypeScript
// AST. It runs in ~3s on its own, but vitest's 10s default hook timeout is
// not enough headroom when the file is scheduled alongside the rest of the
// suite and CPU is contended (observed failing exactly that way, then passing
// on re-run). A flaky guard gets disabled, so give it room rather than let it
// half-run.
beforeAll(() => {
  schema = buildSchemaFromMigrations(path.join(ROOT, 'supabase', 'migrations'))
  scan = scanColumnRefs(
    listSourceFiles([
      path.join(ROOT, 'app'),
      path.join(ROOT, 'lib'),
      path.join(ROOT, 'components'),
      path.join(ROOT, 'extensions'),
      path.join(ROOT, 'hooks'),
      path.join(ROOT, 'scripts'),
    ]),
    schema,
    ROOT
  )
}, 120_000)

/** Split findings into new ones (fail) and baselined ones (tracked). */
function against(
  findings: { key: string; where: string }[],
  baseline: Record<string, string>
): { unexpected: string[]; stale: string[] } {
  const seen = new Set(findings.map((f) => f.key))
  return {
    unexpected: [
      ...new Set(findings.filter((f) => !(f.key in baseline)).map((f) => `${f.key}  (${f.where})`)),
    ].sort(),
    stale: Object.keys(baseline).filter((k) => !seen.has(k)).sort(),
  }
}

describe('schema replay (parser fidelity)', () => {
  // If the replay is wrong the whole guard is wrong, in either direction: a
  // missed column invents accusations, an invented column hides real ones. These
  // anchors are facts established independently of the parser.
  it('models the tables that deliberately have no company_id', () => {
    const withoutCompanyId = [
      'invoice_items',
      'journal_entry_lines',
      'supplier_invoice_items',
      'recurring_invoice_schedule_items',
      'rot_rut_payout_request_items',
      'agent_messages',
    ]
    for (const name of withoutCompanyId) {
      const table = schema.tables.get(name)
      expect(table, `${name} missing from the replayed schema`).toBeDefined()
      expect(table!.columns.has('company_id'), `${name} should have no company_id`).toBe(false)
      expect(table!.columns.size, `${name} parsed with no columns`).toBeGreaterThan(3)
    }
  })

  it('models company_id on the company-scoped tables, including the ones added by dynamic DDL', () => {
    // chart_of_accounts / api_keys / audit_log got company_id from an
    // `EXECUTE format('ALTER TABLE %I ADD COLUMN ...')` loop in the multi-tenant
    // refactor: if the replay misses that, the guard accuses hundreds of correct
    // call sites.
    const withCompanyId = [
      'company_members',
      'salary_line_items',
      'transaction_voucher_links',
      'invoice_deliveries',
      'chart_of_accounts',
      'api_keys',
      'audit_log',
      'journal_entries',
    ]
    for (const name of withCompanyId) {
      const table = schema.tables.get(name)
      expect(table, `${name} missing from the replayed schema`).toBeDefined()
      expect(table!.columns.has('company_id'), `${name} should have company_id`).toBe(true)
    }
  })

  it('models a column renamed by DDL inside a DO block', () => {
    // 20260515170000_webhooks_v2 renames automation_webhooks -> webhooks inside
    // `DO $$ IF ... THEN ... END $$`.
    expect(schema.tables.has('webhooks')).toBe(true)
    expect(schema.tables.has('automation_webhooks')).toBe(false)
    expect(schema.tables.get('supplier_invoice_payments')!.columns.has('user_id')).toBe(true)
  })

  it('agrees with the full-archive contract, which is validated against real Postgres', () => {
    // Independent anchor. tests/pg/full-archive-coverage.pg.test.ts asserts this
    // same contract against information_schema on a live database, so agreement
    // here means the migration replay reproduces prod's company_id topology for
    // 58 dump tables plus every classified table. A drift means the replay is
    // wrong, not the contract.
    const direct = MASTER_DATA_DUMP_TABLES.filter((t) => !t.via)
    expect(
      direct.filter((t) => !schema.tables.get(t.name)?.columns.has('company_id')).map((t) => t.name),
      'direct-dump tables the replay thinks have no company_id'
    ).toEqual([])
    expect(
      MASTER_DATA_DUMP_TABLES.filter((t) => t.via && schema.tables.get(t.name)?.columns.has('company_id')).map(
        (t) => t.name
      ),
      'via-tables the replay thinks DO have company_id'
    ).toEqual([])
    expect(
      MASTER_DATA_DUMP_TABLES.filter((t) => !schema.tables.get(t.name)?.columns.has(t.pageKey ?? 'id')).map(
        (t) => `${t.name}.${t.pageKey ?? 'id'}`
      ),
      'page keys the replay cannot find'
    ).toEqual([])

    const classified = new Set([
      ...MASTER_DATA_DUMP_TABLES.map((t) => t.name),
      ...Object.keys(ARCHIVE_COVERED_ELSEWHERE_TABLES),
      ...Object.keys(ARCHIVE_EXCLUDED_TABLES),
    ])
    expect(
      [...classified].filter((name) => !schema.tables.has(name)).sort(),
      'tables the archive contract classifies but the replay never created'
    ).toEqual([])
    const unclassified = [...schema.tables.values()]
      .filter((t) => t.columns.has('company_id') && !classified.has(t.name))
      .map((t) => t.name)
      .sort()
    expect(
      unclassified,
      'company-scoped tables in the replay that the archive contract does not classify. ' +
        'Either the replay invented a company_id column, or a new table needs triaging in ' +
        'lib/reports/full-archive-export.ts.'
    ).toEqual([])
  })

  it('tracks the current source_type CHECK across every widening migration', () => {
    const sets = closedFor(schema.tables.get('journal_entries')!)
    const sourceType = sets.get('source_type')
    expect(sourceType, 'journal_entries.source_type should be a closed value set').toBeDefined()
    expect(sourceType!.has('bank_transaction')).toBe(true)
    expect(sourceType!.has('stripe_payout')).toBe(true)
    // The phantom value that read 0 rows where prod had 3 917.
    expect(sourceType!.has('transaction')).toBe(false)
  })
})

describe('no phantom columns in Supabase queries', () => {
  it('names only columns that exist on the table being queried', () => {
    const findings = scan.columnRefs
      .filter((ref) => {
        const table = schema.tables.get(ref.table)
        return table !== undefined && !table.columns.has(ref.column)
      })
      .map((ref) => ({
        key: `${ref.table}.${ref.column} @ ${ref.file}`,
        where: `${ref.kind}, line ${ref.line}`,
      }))

    const { unexpected, stale } = against(findings, KNOWN_PHANTOM_COLUMNS)
    expect(
      unexpected,
      'Query references a column that no migration creates. PostgREST answers 42703 and ' +
        'the whole select/filter fails at runtime, however green the mocked test is:\n  ' +
        unexpected.join('\n  ')
    ).toEqual([])
    expect(
      stale,
      'These phantom columns are fixed: delete them from KNOWN_PHANTOM_COLUMNS so the ' +
        'baseline keeps shrinking:\n  ' + stale.join('\n  ')
    ).toEqual([])
  })

  it('reads only tables that exist', () => {
    const findings = scan.tableRefs
      .filter((ref) => !schema.tables.has(ref.table) && !schema.views.has(ref.table))
      .map((ref) => ({ key: `${ref.table} @ ${ref.file}`, where: `line ${ref.line}` }))

    const { unexpected, stale } = against(findings, KNOWN_PHANTOM_TABLES)
    expect(
      unexpected,
      'Query targets a table that no migration creates (dropped, renamed, or never shipped):\n  ' +
        unexpected.join('\n  ')
    ).toEqual([])
    expect(
      stale,
      'These phantom tables are fixed: delete them from KNOWN_PHANTOM_TABLES:\n  ' +
        stale.join('\n  ')
    ).toEqual([])
  })

  it('filters and writes only values a CHECK constraint allows', () => {
    const findings = scan.valueRefs
      .filter((ref) => {
        const table = schema.tables.get(ref.table)
        if (!table) return false
        const allowed = closedFor(table).get(ref.column)
        return allowed !== undefined && !allowed.has(ref.value)
      })
      .map((ref) => ({
        key: `${ref.table}.${ref.column} = '${ref.value}' @ ${ref.file}`,
        where: `line ${ref.line}`,
      }))

    const { unexpected, stale } = against(findings, KNOWN_PHANTOM_VALUES)
    expect(
      unexpected,
      'Literal value is not a member of the column CHECK constraint. A filter on it ' +
        'silently matches nothing; a write on it raises 23514:\n  ' + unexpected.join('\n  ')
    ).toEqual([])
    expect(
      stale,
      'These phantom values are fixed: delete them from KNOWN_PHANTOM_VALUES:\n  ' +
        stale.join('\n  ')
    ).toEqual([])
  })

  it('upserts onto a real unique constraint', () => {
    const findings = scan.conflictRefs
      .filter((ref) => {
        const table = schema.tables.get(ref.table)
        // A table with no unique set at all means the replay did not find one:
        // stay silent rather than accuse.
        if (!table || table.uniqueSets.size === 0) return false
        return !table.uniqueSets.has([...ref.columns].sort().join(','))
      })
      .map((ref) => ({
        key: `${ref.table} [${ref.columns.join(',')}] @ ${ref.file}`,
        where: `line ${ref.line}`,
      }))

    const { unexpected, stale } = against(findings, KNOWN_STALE_ON_CONFLICT)
    expect(
      unexpected,
      'upsert onConflict names columns with no matching unique constraint or index. ' +
        'Postgres raises 42P10 on every call:\n  ' + unexpected.join('\n  ')
    ).toEqual([])
    expect(
      stale,
      'These onConflict targets are fixed: delete them from KNOWN_STALE_ON_CONFLICT:\n  ' +
        stale.join('\n  ')
    ).toEqual([])
  })
})

describe('scanner behaviour (the net catches, and does not over-catch)', () => {
  const phantoms = (code: string): string[] =>
    scanSourceText(code, 'probe.ts', schema)
      .columnRefs.filter((ref) => {
        const table = schema.tables.get(ref.table)
        return table !== undefined && !table.columns.has(ref.column)
      })
      .map((ref) => `${ref.table}.${ref.column}`)

  it('catches a phantom column in a plain filter', () => {
    expect(phantoms(`supabase.from('invoice_items').select('id').eq('company_id', c)`)).toEqual([
      'invoice_items.company_id',
    ])
  })

  it('catches a phantom column inside a backtick template select', () => {
    // Blind spot 1: the sweep's own scanner only read single-quoted selects.
    const code = [
      'const q = supabase',
      "  .from('invoices')",
      '  .select(`',
      '    id,',
      '    total_amount,',
      '    customer:customers(name)',
      '  `)',
    ].join('\n')
    expect(phantoms(code)).toEqual(['invoices.total_amount'])
  })

  it('catches a phantom column added to a builder after assignment', () => {
    // Blind spot 2: `let q = supabase.from(...)` then `q = q.eq(...)`.
    const code = [
      "let q = supabase.from('journal_entry_lines').select('id')",
      "if (x) q = q.eq('company_id', c)",
      "q = q.order('description', { ascending: true })",
    ].join('\n')
    expect(phantoms(code).sort()).toEqual([
      'journal_entry_lines.company_id',
      'journal_entry_lines.description',
    ])
  })

  it('catches a phantom column in a dotted embedded filter', () => {
    const code = [
      "supabase.from('journal_entry_lines')",
      "  .select('id, journal_entries!inner(id)')",
      "  .eq('journal_entries.source_type', 'x')",
      "  .eq('journal_entries.nope', 'y')",
    ].join('\n')
    expect(phantoms(code)).toEqual(['journal_entries.nope'])
  })

  it('does not accuse embedded resource names, aliases or casts', () => {
    const code = [
      "supabase.from('invoices')",
      "  .select('id, items:invoice_items(id, description), customer:customers!invoices_customer_id_fkey(name), total::text, default_dimensions->>project')",
      "  .order('name', { referencedTable: 'customers' })",
    ].join('\n')
    expect(phantoms(code)).toEqual([])
  })

  it('resolves an embed named by its foreign key column', () => {
    // `company:company_id(...)` embeds `companies` through the FK column.
    const code = [
      "supabase.from('company_members')",
      "  .select('role, company:company_id(id, name, nope)')",
    ].join('\n')
    expect(phantoms(code)).toEqual(['companies.nope'])
  })

  it('never treats rpc arguments as columns', () => {
    const code = "supabase.rpc('commit_journal_entry', { p_entry_id: id, not_a_column: 1 })"
    const result = scanSourceText(code, 'probe.ts', schema)
    expect(result.columnRefs).toEqual([])
    expect(result.tableRefs).toEqual([])
  })

  it('never treats a storage bucket or Buffer.from as a table', () => {
    const code = [
      "supabase.storage.from('documents').upload(p, f)",
      "const b = Buffer.from('abc')",
    ].join('\n')
    expect(scanSourceText(code, 'probe.ts', schema).tableRefs).toEqual([])
  })

  it('reports a runtime-built payload as unresolved rather than guessing', () => {
    const code = "supabase.from('invoices').insert(rows)"
    const result = scanSourceText(code, 'probe.ts', schema)
    expect(result.columnRefs).toEqual([])
    expect(result.unresolved.map((u) => u.reason)).toEqual(['dynamic-payload'])
  })

  it('does not attribute a builder variable reused for two tables in one scope', () => {
    const code = [
      'function f() {',
      "  let q = supabase.from('invoices').select('id')",
      "  q = supabase.from('customers').select('id')",
      "  q = q.eq('nope_at_all', 1)",
      '}',
    ].join('\n')
    expect(phantoms(code)).toEqual([])
    expect(
      scanSourceText(code, 'probe.ts', schema).unresolved.map((u) => u.reason)
    ).toContain('unknown-builder-table')
  })

  it('catches a phantom value on a CHECK-constrained column', () => {
    const code = "supabase.from('journal_entries').select('id').eq('source_type', 'transaction')"
    const bad = scanSourceText(code, 'probe.ts', schema).valueRefs.filter((ref) => {
      const allowed = closedFor(schema.tables.get(ref.table)!).get(ref.column)
      return allowed !== undefined && !allowed.has(ref.value)
    })
    expect(bad.map((b) => `${b.column}=${b.value}`)).toEqual(['source_type=transaction'])
  })
})

describe('scanner coverage', () => {
  it('keeps the resolvable query surface large enough for the net to matter', () => {
    expect(
      scan.columnRefs.length,
      `Only ${scan.columnRefs.length} column references resolved (floor ${RESOLVED_COLUMN_FLOOR}). ` +
        'Either the scanner stopped following builder chains or a large surface moved behind ' +
        'dynamic construction. Fix the scanner rather than lowering the floor.'
    ).toBeGreaterThanOrEqual(RESOLVED_COLUMN_FLOOR)
  })

  it('holds the unresolvable-expression ceiling', () => {
    const byReason = new Map<string, number>()
    for (const item of scan.unresolved) {
      byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
    }
    const breakdown = [...byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ')
    expect(
      scan.unresolved.length,
      `${scan.unresolved.length} unresolvable query expressions (ceiling ${UNRESOLVED_CEILING}): ` +
        `${breakdown}. Each one is a column this guard cannot check. Prefer an object literal ` +
        'or a literal select string over runtime construction, or raise the ceiling with a reason.'
    ).toBeLessThanOrEqual(UNRESOLVED_CEILING)
  })
})
