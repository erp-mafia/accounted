import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

/**
 * Ratchet for the sandbox teardown (#2837, 20260927220000).
 *
 * cleanup_sandbox_user used to lean on the auth.users cascade for most tenant
 * rows. A RESTRICT or NO ACTION foreign key is checked when its parent row
 * goes, and which sibling cascade runs first inside one statement is decided
 * by RI trigger names, an accident of creation order. So every new register
 * with a RESTRICT foreign key (supplier_payment_batch_items,
 * depreciation_schedules, account_reconciliations.signed_by,
 * transactions.document_id, ...) broke the nightly teardown again, and every
 * new WORM delete guard without the teardown window did the same. Nobody
 * noticed until the cron had stalled for days.
 *
 * These tests read the ordered statements out of the live function body and
 * the foreign keys and triggers out of the catalog, so a migration that adds
 * a new edge or guard fails CI until the teardown handles it or it is
 * classified below with a reason. They do not seed data;
 * sandbox-cleanup.pg.test.ts proves the order works on real rows.
 */

/**
 * RESTRICT / NO ACTION references the teardown deliberately does not clear.
 * A sandbox holding one of these rows is refused (the whole teardown rolls
 * back and the nightly cron reports it), never silently erased: each is a
 * record of an exchange with a party outside Accounted, or a link between two
 * companies that only an operator should unwind.
 */
const REFUSED_ON_PURPOSE: Record<string, string> = {
  'arsredovisning_submissions.annual_report_version_id':
    'a filing sent to Bolagsverket; its WORM trail outranks a demo teardown',
  'arsredovisning_submissions.dokument_id':
    'a filing sent to Bolagsverket; its WORM trail outranks a demo teardown',
  'company_migration_resets.replacement_company_id':
    'links a reset source to its replacement company; unwinding that is an operator decision',
  'company_migration_resets.source_company_id':
    'links a reset source to its replacement company; unwinding that is an operator decision',
  'peppol_deliveries.company_id':
    'Peppol send is refused for sandbox companies (isSandboxCompany in peppol-send-service); a row means the network saw it',
  'peppol_deliveries.invoice_id':
    'Peppol send is refused for sandbox companies (isSandboxCompany in peppol-send-service); a row means the network saw it',
  'peppol_deliveries.user_id':
    'Peppol send is refused for sandbox companies (isSandboxCompany in peppol-send-service); a row means the network saw it',
  'peppol_delivery_events.company_id': 'append-only Peppol delivery trail, see peppol_deliveries',
  'peppol_delivery_evidence.company_id': 'append-only Peppol delivery trail, see peppol_deliveries',
  'peppol_inbound_documents.company_id':
    'an e-invoice received from the Peppol network; the registration it needs is refused for sandbox companies',
  'skatteverket_api_audit_log.company_id':
    'WORM log of calls made to Skatteverket on the company\'s behalf',
}

/**
 * BEFORE DELETE guards on tables the teardown reaches that do not read the
 * teardown flags, with the reason each never refuses during a teardown.
 * Guards that do read gnubok.sandbox_cleanup or gnubok.allow_delete are
 * recognised automatically and need no entry.
 */
const CONDITIONAL_DELETE_GUARDS: Record<string, string> = {
  enforce_company_writer_role:
    'end-user JWT only; the cron runs as service_role and cascades run at trigger depth > 1',
  enforce_company_writer_role_via_parent:
    'end-user JWT only; the cron runs as service_role and cascades run at trigger depth > 1',
  block_migration_reset_source_mutation:
    'only rows of an archived migration-reset source company; company_migration_resets is refused on purpose above',
  block_migration_reset_source_journal_line_mutation: 'same as block_migration_reset_source_mutation',
  block_migration_reset_source_rot_rut_item_mutation: 'same as block_migration_reset_source_mutation',
  block_migration_reset_source_vat_state_mutation: 'same as block_migration_reset_source_mutation',
  guard_sie_held_attachment: 'only while an SIE import hold is active; the teardown clears import_hold first',
  guard_sie_held_lines: 'only while an SIE import hold is active; the teardown clears import_hold first',
  lock_cash_history_for_journal_line: 'takes a lock; raises only on lock contention',
  guard_bank_configuration_writer: 'takes the company cash-account lock; raises only on contention',
  guard_bank_provider_session_claim: 'takes the bank session lock; raises only on a started revocation for INSERT/UPDATE',
  block_document_deletion:
    'only for a document on a posted voucher; the teardown unlinks documents before deleting them',
  block_sent_invoice_document_deletion:
    'only while a sent invoice_deliveries row points at the PDF; the teardown deletes deliveries first',
  enforce_dimension_value_retention:
    'only while a posted line uses the value; journal entries are gone before dimensions',
  remove_team_member_from_companies: 'never raises',
}

type Statement = { kind: 'delete' | 'update'; table: string; cols: string[]; pos: number }
type ForeignKey = { conname: string; child: string; parent: string; act: string; cols: string[] }

async function teardownStatements(): Promise<Statement[]> {
  const { rows } = await getPool().query<{ src: string }>(
    `SELECT prosrc AS src FROM pg_proc WHERE oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure`,
  )
  // Comments name tables too; only executable statements count.
  const src = rows[0]!.src.replace(/--[^\n]*/g, '')
  const out: Statement[] = []
  for (const m of src.matchAll(/\bDELETE\s+FROM\s+(public|auth)\.(\w+)/gi)) {
    out.push({ kind: 'delete', table: `${m[1]}.${m[2]}`, cols: [], pos: m.index! })
  }
  for (const m of src.matchAll(/\bUPDATE\s+public\.(\w+)\s+SET\s+([\s\S]*?)\bWHERE\b/gi)) {
    const cols = [...m[2]!.matchAll(/(\w+)\s*=\s*NULL\b/gi)].map((c) => c[1]!)
    out.push({ kind: 'update', table: `public.${m[1]}`, cols, pos: m.index! })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

async function foreignKeys(): Promise<ForeignKey[]> {
  const { rows } = await getPool().query<ForeignKey>(`
    SELECT c.conname,
           cn.nspname || '.' || cr.relname AS child,
           pn.nspname || '.' || pr.relname AS parent,
           c.confdeltype::text AS act,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
      FROM pg_constraint c
      JOIN pg_class cr ON cr.oid = c.conrelid JOIN pg_namespace cn ON cn.oid = cr.relnamespace
      JOIN pg_class pr ON pr.oid = c.confrelid JOIN pg_namespace pn ON pn.oid = pr.relnamespace
     WHERE c.contype = 'f'`)
  return rows
}

/** Tables whose rows a DELETE on `table` removes, through ON DELETE CASCADE. */
function cascadeClosure(fks: ForeignKey[]): (table: string) => Set<string> {
  const children = new Map<string, string[]>()
  for (const fk of fks) {
    if (fk.act !== 'c') continue
    children.set(fk.parent, [...(children.get(fk.parent) ?? []), fk.child])
  }
  const memo = new Map<string, Set<string>>()
  return (table) => {
    const cached = memo.get(table)
    if (cached) return cached
    const seen = new Set([table])
    const queue = [table]
    while (queue.length) {
      for (const child of children.get(queue.pop()!) ?? []) {
        if (!seen.has(child)) {
          seen.add(child)
          queue.push(child)
        }
      }
    }
    memo.set(table, seen)
    return seen
  }
}

function firstIndex(statements: Statement[], pred: (s: Statement) => boolean): number {
  const i = statements.findIndex(pred)
  return i === -1 ? Infinity : i
}

const bare = (table: string) => table.replace(/^public\./, '')

describe('sandbox teardown coverage (pg)', () => {
  it('parses the teardown body into its ordered statements', async () => {
    const statements = await teardownStatements()
    // A rewrite that the parser no longer understands must fail here, not
    // pass the checks below vacuously.
    expect(statements.length).toBeGreaterThan(40)
    expect(statements.at(-1)).toMatchObject({ kind: 'delete', table: 'auth.users' })
    expect(statements.at(-2)).toMatchObject({ kind: 'delete', table: 'public.companies' })
  })

  it('clears every RESTRICT / NO ACTION reference before the statement that deletes its target', async () => {
    const [statements, fks] = await Promise.all([teardownStatements(), foreignKeys()])
    const closure = cascadeClosure(fks)
    const uncovered: string[] = []
    const refused = new Set<string>()

    for (const fk of fks) {
      if (fk.act !== 'a' && fk.act !== 'r') continue
      // storage.* and auth.* children belong to Supabase; hosted storage no
      // longer carries the owner foreign key the local image still has.
      if (!fk.child.startsWith('public.')) continue
      const parentGone = firstIndex(
        statements,
        (s) => s.kind === 'delete' && closure(s.table).has(fk.parent),
      )
      if (parentGone === Infinity) continue
      const detachable = fk.cols.filter((c) => c !== 'company_id')
      const childGone = firstIndex(
        statements,
        (s) =>
          (s.kind === 'delete' && closure(s.table).has(fk.child)) ||
          (s.kind === 'update' && s.table === fk.child && s.cols.some((c) => detachable.includes(c))),
      )
      // A self-reference with NO ACTION is checked at the end of the
      // statement, by which time the same DELETE has removed the referrers.
      const sameStatementSelfRef = fk.child === fk.parent && fk.act === 'a' && childGone === parentGone
      if (childGone < parentGone || sameStatementSelfRef) continue

      const key = `${bare(fk.child)}.${fk.cols.filter((c) => c !== 'company_id').join('+') || 'company_id'}`
      if (REFUSED_ON_PURPOSE[key]) {
        refused.add(key)
        continue
      }
      uncovered.push(
        `${key} -> ${fk.parent} (${fk.conname}, ${fk.act === 'r' ? 'RESTRICT' : 'NO ACTION'}): ` +
          `the target goes at statement ${parentGone} (${statements[parentGone]!.table}) but the row that ` +
          `references it ${childGone === Infinity ? 'is never deleted' : `goes only at statement ${childGone}`}. ` +
          'Delete it (or clear the column) earlier in cleanup_sandbox_user, or add it to REFUSED_ON_PURPOSE with the reason.',
      )
    }

    expect(uncovered).toEqual([])
    // A stale entry would hide the next real gap behind an old excuse.
    expect(Object.keys(REFUSED_ON_PURPOSE).filter((k) => !refused.has(k))).toEqual([])
  })

  it('every delete guard on a reached table honours the teardown window or is classified', async () => {
    const [statements, fks] = await Promise.all([teardownStatements(), foreignKeys()])
    const closure = cascadeClosure(fks)
    const reached = new Set(
      statements.filter((s) => s.kind === 'delete').flatMap((s) => [...closure(s.table)]),
    )
    const { rows } = await getPool().query<{ tbl: string; fn: string; src: string }>(`
      SELECT n.nspname || '.' || c.relname AS tbl, p.proname AS fn, p.prosrc AS src
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal
         AND (t.tgtype & 1) = 1   -- ROW
         AND (t.tgtype & 2) = 2   -- BEFORE
         AND (t.tgtype & 8) = 8   -- DELETE
         AND n.nspname = 'public'`)

    const companySettingsGone = firstIndex(
      statements,
      (s) => s.kind === 'delete' && closure(s.table).has('public.company_settings'),
    )
    const unclassified: string[] = []
    const purgedTooLate: string[] = []
    const used = new Set<string>()

    for (const row of rows) {
      if (!reached.has(row.tbl)) continue
      if (/gnubok\.(sandbox_cleanup|allow_delete)/.test(row.src)) {
        // A guard that re-verifies the company through company_settings only
        // works while that row exists; the companies delete takes it away.
        if (/company_settings/.test(row.src)) {
          const gone = firstIndex(statements, (s) => s.kind === 'delete' && closure(s.table).has(row.tbl))
          if (!(gone < companySettingsGone)) {
            purgedTooLate.push(`${row.tbl} (${row.fn}) is first deleted at statement ${gone}`)
          }
        }
        continue
      }
      if (CONDITIONAL_DELETE_GUARDS[row.fn]) {
        used.add(row.fn)
        continue
      }
      unclassified.push(
        `${row.tbl}: ${row.fn} can refuse a DELETE and does not read gnubok.sandbox_cleanup. Give it the ` +
          'teardown window (flag plus a per-row company_settings.is_sandbox check) and purge the table in ' +
          'cleanup_sandbox_user while company_settings exists, or add it to CONDITIONAL_DELETE_GUARDS with why ' +
          'it never fires during a teardown.',
      )
    }

    expect(unclassified).toEqual([])
    expect(purgedTooLate).toEqual([])
    expect(Object.keys(CONDITIONAL_DELETE_GUARDS).filter((k) => !used.has(k))).toEqual([])
  })

  it('scopes every data statement to the verified sandbox companies', async () => {
    const { rows } = await getPool().query<{ src: string }>(
      `SELECT prosrc AS src FROM pg_proc WHERE oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure`,
    )
    const src = rows[0]!.src.replace(/--[^\n]*/g, '')
    // Everything from the flags onwards: the eligibility checks above them
    // read other companies on purpose.
    const body = src.slice(src.indexOf("set_config('gnubok.allow_delete', 'true'"))
    const statements = body
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => /^(DELETE|UPDATE)\b/i.test(s))
    const unscoped = statements.filter(
      (s) =>
        !/v_companies/.test(s) &&
        // The account itself, and the user's own credentials.
        !/^DELETE FROM auth\.users WHERE id = p_user_id$/.test(s),
    )
    expect(statements.length).toBeGreaterThan(40)
    expect(unscoped).toEqual([])
  })
})
