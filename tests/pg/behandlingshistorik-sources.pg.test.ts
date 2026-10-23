import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { AUDITED_TABLES, GLOBAL_ACTIONS } from '@/lib/reports/behandlingshistorik'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'

/**
 * behandlingshistorik_sources and behandlingshistorik_decisions (migration
 * 20261023094050): the report's source rows in one statement each, replacing
 * PostgREST paging and .in() lists of the period's voucher ids. Each result
 * is compared with the reader's rules applied directly (no pruning), so the
 * functions answer what the TypeScript reader used to fetch, minus only the
 * rows no event can come from.
 *
 * The fiscal year is 2020 so every row the fixtures' triggers write (created
 * now) is logged after the window, like a storno or bokslut after year end.
 */

const FROM = '2020-01-01T00:00:00.000Z'
const TO = '2020-12-31T23:59:59.999Z'
const MAY_FROM = '2020-05-01T00:00:00.000Z'
const MAY_TO = '2020-05-31T23:59:59.999Z'

/** auditRowToEvent renders nothing for these (pinned in behandlingshistorik.test.ts). */
const NO_EVENT = `coalesce(
  (a.table_name = 'journal_entries' AND a.action IN ('INSERT', 'COMMIT'))
  OR (a.table_name = 'journal_entries' AND a.action = 'UPDATE'
      AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
      AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed'))
  OR (a.table_name = 'document_attachments' AND a.action IN ('INSERT', 'UPDATE')),
  false)`

let userId: string
let outsiderId: string
let companyId: string
let otherCompanyId: string
let p20: string
let p21: string
const e: Record<string, string> = {}
const audit: Record<string, string> = {}
const rattelse: Record<string, string> = {}
const decision: Record<string, string> = {}
const op: Record<string, string> = {}

async function insertAudit(row: {
  company?: string | null
  action: string
  table: string | null
  recordId?: string | null
  at: string
  oldState?: unknown
  newState?: unknown
  description?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $1, $6::jsonb, $7::jsonb, $8, $9) RETURNING id`,
    [
      userId,
      row.company === undefined ? companyId : row.company,
      row.action,
      row.table,
      row.recordId ?? randomUUID(),
      row.oldState === undefined ? null : JSON.stringify(row.oldState),
      row.newState === undefined ? null : JSON.stringify(row.newState),
      row.description ?? null,
      row.at,
    ],
  )
  return rows[0].id
}

async function insertRattelse(company: string, entryId: string, at: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.journal_entry_rattelse_log (company_id, journal_entry_id, rattelse_type, old_description, new_description, actor, created_at)
     VALUES ($1, $2, 'metadata', 'före', 'efter', $3, $4) RETURNING id`,
    [company, entryId, userId, at],
  )
  return rows[0].id
}

async function insertOperation(company: string, status: string, resultData: unknown): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.pending_operations (user_id, company_id, operation_type, status, title, result_data, actor_type, actor_label, resolved_at)
     VALUES ($1, $2, 'categorize_transaction', $3, 'Kontera', $4::jsonb, 'api_key', 'Zapier', '2020-05-01T10:00:00Z') RETURNING id`,
    [userId, company, status, JSON.stringify(resultData)],
  )
  return rows[0].id
}

async function insertDecision(row: {
  company?: string
  at: string
  final: unknown
  pendingOperationId?: string
}): Promise<string> {
  const company = row.company ?? companyId
  const kind = row.pendingOperationId ? 'operation' : 'bank_line'
  const transactionId = row.pendingOperationId ? null : await insertTransaction({ companyId: company, userId })
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suggestion_log (company_id, kind, transaction_id, pending_operation_id, suggestions, final, outcome, actor_type, resolved_by, created_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb, 'manual', 'user', $6, $7) RETURNING id`,
    [company, kind, transactionId, row.pendingOperationId ?? null, JSON.stringify(row.final), userId, row.at],
  )
  return rows[0].id
}

interface SourcesRow {
  entries: Array<{ id: string; committed_at: string | null; [key: string]: unknown }>
  audit: Array<{ id: string; [key: string]: unknown }>
  audit_outside: Array<{ id: string; created_at: string; [key: string]: unknown }>
  rattelse: Array<{ id: string; [key: string]: unknown }>
}

async function sources(
  client: PoolClient, from: string, to: string, fiscalYear: boolean, period = p20, company = companyId,
): Promise<SourcesRow> {
  const { rows } = await client.query<SourcesRow>(
    'SELECT * FROM public.behandlingshistorik_sources($1, $2, $3, $4, $5)',
    [company, period, from, to, fiscalYear],
  )
  expect(rows).toHaveLength(1)
  return rows[0]
}

interface DecisionsRow {
  rows: Array<{ id: string; [key: string]: unknown }>
  entries: Array<{ id: string; [key: string]: unknown }>
  operations: Array<{ id: string; [key: string]: unknown }>
  legacy_by_entry: Array<{ id: string; [key: string]: unknown }>
  legacy_by_registration: Array<{ id: string; [key: string]: unknown }>
}

async function decisions(client: PoolClient, from: string, to: string, fiscalYear: boolean): Promise<DecisionsRow> {
  const { rows } = await client.query<DecisionsRow>(
    'SELECT * FROM public.behandlingshistorik_decisions($1, $2, $3, $4, $5)',
    [companyId, p20, from, to, fiscalYear],
  )
  expect(rows).toHaveLength(1)
  return rows[0]
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort()

/** The audit rows the reader asked PostgREST for (window + record-id unions), minus NO_EVENT. */
async function expectedAuditIds(
  from: string, to: string, fiscalYear: boolean, period = p20, company = companyId,
): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `WITH pe AS (SELECT id, import_batch_id FROM public.journal_entries WHERE company_id = $1 AND fiscal_period_id = $2)
     SELECT a.id FROM public.audit_log a
      WHERE a.company_id = $1
        AND NOT ${NO_EVENT}
        AND ((a.created_at >= $3 AND a.created_at <= $4
              AND (a.table_name = ANY ($6::text[]) OR a.action = ANY ($7::text[])))
             OR ($5 AND a.table_name = 'journal_entries' AND a.record_id IN (SELECT id FROM pe))
             OR ($5 AND a.action = 'GUARD_BYPASSED' AND a.new_state->>'journal_entry_id' IN (SELECT id::text FROM pe))
             OR ($5 AND a.table_name = 'sie_import_chunks'
                 AND a.new_state->>'import_id' IN (SELECT import_batch_id::text FROM pe WHERE import_batch_id IS NOT NULL)))`,
    [company, period, from, to, fiscalYear, [...AUDITED_TABLES], [...GLOBAL_ACTIONS]],
  )
  return rows.map((r) => r.id).sort()
}

beforeAll(async () => {
  userId = await insertAuthUser()
  outsiderId = await insertAuthUser()
  companyId = await insertCompany({ createdBy: userId })
  otherCompanyId = await insertCompany({ createdBy: outsiderId })
  await insertCompanyMember({ companyId, userId })
  await insertCompanyMember({ companyId: otherCompanyId, userId: outsiderId })
  p20 = await insertFiscalPeriod({ userId, companyId, periodStart: '2020-01-01', periodEnd: '2020-12-31', name: '2020' })
  p21 = await insertFiscalPeriod({ userId, companyId, periodStart: '2021-01-01', periodEnd: '2021-12-31', name: '2021' })
  const otherPeriod = await insertFiscalPeriod({ userId: outsiderId, companyId: otherCompanyId, periodStart: '2020-01-01', periodEnd: '2020-12-31' })

  // Verifikat (their trigger rows are logged now: after the window).
  const posted = (key: string, n: number, committedAt: string, extra: Record<string, unknown> = {}) =>
    insertPostedJournalEntry({ userId, companyId, fiscalPeriodId: p20, voucherNumber: n, entryDate: committedAt.slice(0, 10), committedAt, ...extra })
      .then((id) => { e[key] = id })
  await posted('e1', 1, '2020-03-01T10:00:00.000Z')
  await posted('e2', 2, '2020-06-01T10:00:00.000Z')
  await posted('imported', 3, '2020-02-01T10:00:00.000Z', { sourceType: 'import' })
  await posted('storno', 4, '2020-08-01T10:00:00.000Z')
  await posted('mayCommit', 5, '2020-05-20T10:00:00.000Z')
  await posted('beforeMay', 6, '2020-04-30T23:59:59.999Z')
  // Committed 0.5 ms before May ends: the reader truncates to milliseconds, so inside.
  await posted('mayLastInstant', 7, '2020-05-31T23:59:59.9995Z')
  await posted('unreferenced', 8, '2020-09-01T10:00:00.000Z')
  e.draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId: p20, entryDate: '2020-07-01' })
  e.e3 = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId: p21, voucherNumber: 1, entryDate: '2021-02-01', committedAt: '2021-02-01T10:00:00.000Z' })
  e.foreign = await insertPostedJournalEntry({ userId: outsiderId, companyId: otherCompanyId, fiscalPeriodId: otherPeriod, voucherNumber: 1, entryDate: '2020-03-01', committedAt: '2020-03-01T10:00:00.000Z' })
  const { rows: imp } = await getPool().query<{ import_batch_id: string }>('SELECT import_batch_id FROM public.journal_entries WHERE id = $1', [e.imported])
  const importId = imp[0].import_batch_id

  // Inside the window: one row per audited table and per global action.
  for (const table of AUDITED_TABLES) {
    audit[`table:${table}`] = await insertAudit({ action: 'DELETE', table, at: '2020-02-10T08:00:00Z', oldState: { name: table, status: 'posted' } })
  }
  for (const action of GLOBAL_ACTIONS) {
    audit[`action:${action}`] = await insertAudit({ action, table: 'parties', at: '2020-02-11T08:00:00Z', description: action })
  }
  audit.register = await insertAudit({ action: 'INSERT', table: 'parties', at: '2020-02-12T08:00:00Z' })
  audit.entryInsert = await insertAudit({ action: 'INSERT', table: 'journal_entries', recordId: e.e1, at: '2020-03-01T10:00:00Z' })
  audit.entryCommit = await insertAudit({ action: 'COMMIT', table: 'journal_entries', recordId: e.e1, at: '2020-03-01T10:00:00Z' })
  audit.draftEdit = await insertAudit({ action: 'UPDATE', table: 'journal_entries', recordId: e.draft, at: '2020-07-02T08:00:00Z', oldState: { status: 'draft', description: 'a' }, newState: { status: 'draft', description: 'b' } })
  audit.postedEdit = await insertAudit({ action: 'UPDATE', table: 'journal_entries', recordId: e.e1, at: '2020-03-02T08:00:00Z', oldState: { status: 'posted', notes: 'a' }, newState: { status: 'posted', notes: 'b' } })
  audit.documentInsert = await insertAudit({ action: 'INSERT', table: 'document_attachments', at: '2020-03-03T08:00:00Z' })
  audit.documentUpdate = await insertAudit({ action: 'UPDATE', table: 'document_attachments', at: '2020-03-03T08:00:01Z' })
  audit.foreignAccount = await insertAudit({ company: otherCompanyId, action: 'INSERT', table: 'chart_of_accounts', at: '2020-02-10T08:00:00Z' })
  audit.global = await insertAudit({ company: null, action: 'UPDATE', table: 'salary_payroll_config', at: '2020-02-10T08:00:00Z' })
  // In May: a storno, a bypassed guard, a settings change.
  audit.mayReverse = await insertAudit({ action: 'REVERSE', table: 'journal_entries', recordId: e.e1, at: '2020-05-10T08:00:00Z', oldState: { status: 'posted' }, newState: { status: 'reversed', reversed_by_id: e.storno } })
  audit.mayGuard = await insertAudit({
    action: 'GUARD_BYPASSED', table: 'supplier_invoices', at: '2020-05-11T08:00:00Z',
    newState: { guard: 'supplier_invoice_duplicate_payment', journal_entry_id: e.mayCommit, candidates: [{ journal_entry_id: e.e2 }, 'not an object', { journal_entry_id: e.e3 }] },
  })

  // Outside the window, about the year's verifikat.
  audit.lateReverse = await insertAudit({ action: 'REVERSE', table: 'journal_entries', recordId: e.e2, at: '2021-02-01T08:00:00Z', oldState: { status: 'posted' }, newState: { status: 'reversed' } })
  audit.lateCommit = await insertAudit({ action: 'COMMIT', table: 'journal_entries', recordId: e.e2, at: '2021-02-01T08:00:00Z' })
  audit.otherPeriodOverride = await insertAudit({ action: 'COMMITTED_AT_OVERRIDE', table: 'journal_entries', recordId: e.e3, at: '2021-02-01T08:00:00Z' })
  audit.lateGuard = await insertAudit({ action: 'GUARD_BYPASSED', table: 'supplier_invoices', at: '2021-03-01T08:00:00Z', newState: { guard: 'supplier_invoice_duplicate_payment', journal_entry_id: e.e2 } })
  audit.otherPeriodGuard = await insertAudit({ action: 'GUARD_BYPASSED', table: 'supplier_invoices', at: '2021-03-01T08:00:00Z', newState: { guard: 'supplier_invoice_duplicate_payment', journal_entry_id: e.e3 } })
  audit.chunk = await insertAudit({ action: 'COMMIT', table: 'sie_import_chunks', at: '2021-04-01T08:00:00Z', newState: { import_id: importId, phase: 'vouchers', chunk_no: 1 } })
  audit.otherChunk = await insertAudit({ action: 'COMMIT', table: 'sie_import_chunks', at: '2021-04-01T08:00:00Z', newState: { import_id: randomUUID(), phase: 'vouchers', chunk_no: 1 } })
  // Before the window: the company logged something before the year opened,
  // so the year's verifikat created outside the window are looked up there.
  audit.earlyEdit = await insertAudit({ action: 'UPDATE', table: 'journal_entries', recordId: e.e1, at: '2019-12-15T08:00:00Z', oldState: { status: 'posted', notes: 'x' }, newState: { status: 'posted', notes: 'y' } })
  // Created inside the window (its INSERT row a day after it opened): rows
  // after the window are still found.
  await insertAudit({ action: 'INSERT', table: 'journal_entries', recordId: e.mayCommit, at: '2020-05-20T09:00:00Z' })
  audit.mayCommitLateReverse = await insertAudit({ action: 'REVERSE', table: 'journal_entries', recordId: e.mayCommit, at: '2021-01-10T08:00:00Z', oldState: { status: 'posted' }, newState: { status: 'reversed' } })

  // Rättelser.
  rattelse.may = await insertRattelse(companyId, e.imported, '2020-05-15T08:00:00Z')
  rattelse.late = await insertRattelse(companyId, e.e2, '2021-01-05T08:00:00Z')
  rattelse.otherPeriod = await insertRattelse(companyId, e.e3, '2021-01-05T08:00:00Z')
  rattelse.foreign = await insertRattelse(otherCompanyId, e.foreign, '2020-05-15T08:00:00Z')

  // Decisions and the staged operations their receipts read.
  op.named = await insertOperation(companyId, 'committed', { journal_entry_id: e.mayCommit })
  op.byEntry = await insertOperation(companyId, 'committed', { journal_entry_id: e.e1 })
  op.byRegistration = await insertOperation(companyId, 'committed', { registration_journal_entry_id: e.e2 })
  op.notCommitted = await insertOperation(companyId, 'pending', { journal_entry_id: e.e1 })
  op.foreign = await insertOperation(otherCompanyId, 'committed', { journal_entry_id: e.e1 })
  decision.may = await insertDecision({ at: '2020-05-02T08:00:00Z', final: { journal_entry_id: e.e1 } })
  decision.late = await insertDecision({ at: '2021-01-12T08:00:00Z', final: { journal_entry_id: e.e2 } })
  decision.otherPeriod = await insertDecision({ at: '2021-01-12T08:00:00Z', final: { journal_entry_id: e.e3 } })
  decision.foreign = await insertDecision({ company: otherCompanyId, at: '2020-05-02T08:00:00Z', final: { journal_entry_id: e.foreign } })
  decision.named = await insertDecision({ at: '2020-05-03T08:00:00Z', final: { journal_entry_id: e.mayCommit }, pendingOperationId: op.named })
  decision.noFinal = await insertDecision({ at: '2020-05-04T08:00:00Z', final: null })
  decision.malformed = await insertDecision({ at: '2020-05-05T08:00:00Z', final: { journal_entry_id: 'not-a-uuid' } })
})

describe('behandlingshistorik_sources', () => {
  it('fiscal-year mode: the rows the reader fetched, the window and the record-id unions, minus rows without events', async () => {
    const result = await withUserContext(userId, (client) => sources(client, FROM, TO, true))
    const got = [...result.audit, ...result.audit_outside]
    expect(ids(got)).toEqual(await expectedAuditIds(FROM, TO, true))
    // Inside and outside the window are disjoint.
    expect(new Set(got.map((r) => r.id)).size).toBe(got.length)
    expect(result.audit_outside.every((r) => r.created_at < FROM || r.created_at > TO)).toBe(true)

    const all = new Set(got.map((r) => r.id))
    for (const key of [
      ...AUDITED_TABLES.map((t) => `table:${t}`),
      ...GLOBAL_ACTIONS.map((a) => `action:${a}`),
      'postedEdit', 'mayReverse', 'mayGuard', 'lateReverse', 'lateGuard', 'chunk', 'earlyEdit', 'mayCommitLateReverse',
    ]) {
      expect(all.has(audit[key]), key).toBe(true)
    }
    for (const key of [
      'register', 'entryInsert', 'entryCommit', 'draftEdit', 'documentInsert', 'documentUpdate', 'foreignAccount', 'global',
      'lateCommit', 'otherPeriodOverride', 'otherPeriodGuard', 'otherChunk',
    ]) {
      expect(all.has(audit[key]), key).toBe(false)
    }
    // The rows come whole, as select * did.
    const row = got.find((r) => r.id === audit.lateReverse)!
    expect(Object.keys(row).sort()).toEqual(
      ['action', 'actor_id', 'actor_label', 'actor_type', 'company_id', 'created_at', 'description', 'id', 'new_state', 'old_state', 'record_id', 'table_name', 'user_id'],
    )
    expect(row).toMatchObject({ action: 'REVERSE', table_name: 'journal_entries', record_id: e.e2, new_state: { status: 'reversed' } })
  })

  it('fiscal-year mode: every verifikat of the period, with the columns the reader reads', async () => {
    const result = await withUserContext(userId, (client) => sources(client, FROM, TO, true))
    const { rows } = await getPool().query<{ id: string }>('SELECT id FROM public.journal_entries WHERE company_id = $1 AND fiscal_period_id = $2', [companyId, p20])
    expect(ids(result.entries)).toEqual(rows.map((r) => r.id).sort())
    expect(Object.keys(result.entries[0]).sort()).toEqual([
      'commit_method', 'committed_actor_label', 'committed_actor_type', 'committed_at', 'committed_auth_role', 'committed_auth_uid',
      'correction_of_id', 'description', 'entry_date', 'id', 'import_batch_id', 'reverses_id', 'source_type', 'status', 'user_id',
      'voucher_number', 'voucher_series',
    ])
    expect(ids(result.rattelse)).toEqual([rattelse.may, rattelse.late].sort())
  })

  it('date-range mode: the window only, and the verifikat committed in it or looked up by its rows', async () => {
    const result = await withUserContext(userId, (client) => sources(client, MAY_FROM, MAY_TO, false))
    expect(ids(result.audit)).toEqual(await expectedAuditIds(MAY_FROM, MAY_TO, false))
    expect(ids(result.audit)).toEqual([audit.mayReverse, audit.mayGuard].sort())
    expect(result.audit_outside).toEqual([])
    expect(ids(result.rattelse)).toEqual([rattelse.may])
    // Committed in May (the last half millisecond included, as the reader
    // truncates), the storno the REVERSE row names, the vouchers the guard
    // names, the verifikat the rättelse corrected. Not the other period's
    // verifikat the guard also names, not the rest of the year.
    expect(ids(result.entries)).toEqual([e.mayCommit, e.mayLastInstant, e.storno, e.e2, e.imported].sort())
  })

  it('scopes to the caller: a user outside the company reads nothing, the service role reads the same rows', async () => {
    const outsider = await withUserContext(outsiderId, (client) => sources(client, FROM, TO, true))
    expect(outsider).toEqual({ entries: [], audit: [], audit_outside: [], rattelse: [] })
    const member = await withUserContext(userId, (client) => sources(client, FROM, TO, true))
    const service = await runAsServiceRole((client) => sources(client, FROM, TO, true))
    expect(ids(service.entries)).toEqual(ids(member.entries))
    expect(ids([...service.audit, ...service.audit_outside])).toEqual(ids([...member.audit, ...member.audit_outside]))
    expect(ids(service.rattelse)).toEqual(ids(member.rattelse))
  })

  it('fiscal-year mode, a year after everything the company logged: rows about its verifikat from before it opened', async () => {
    // Nothing is logged after this window, so only the look-up before it
    // finds the year's rows: the fixtures' trigger rows, written now.
    const owner = await insertAuthUser()
    const company = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId: company, userId: owner })
    const period = await insertFiscalPeriod({ userId: owner, companyId: company, periodStart: '2099-01-01', periodEnd: '2099-12-31', name: '2099' })
    const preset = await insertPostedJournalEntry({ userId: owner, companyId: company, fiscalPeriodId: period, voucherNumber: 1, entryDate: '2099-02-01', committedAt: '2099-02-01T10:00:00.000Z' })
    const from = '2099-01-01T00:00:00.000Z'
    const to = '2099-12-31T23:59:59.999Z'
    const result = await withUserContext(owner, (client) => sources(client, from, to, true, period, company))
    const expected = await expectedAuditIds(from, to, true, period, company)
    expect(ids([...result.audit, ...result.audit_outside])).toEqual(expected)
    // The preset registration time is logged (set_committed_at), before the window.
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.audit_log WHERE record_id = $1 AND action = 'COMMITTED_AT_OVERRIDE'`, [preset],
    )
    expect(rows).toHaveLength(1)
    expect(expected).toEqual([rows[0].id])
  })

  it('answers empty arrays for a period without history', async () => {
    const empty = await insertFiscalPeriod({ userId, companyId, periodStart: '2018-01-01', periodEnd: '2018-12-31', name: '2018' })
    const result = await withUserContext(userId, (client) => sources(client, '2018-01-01T00:00:00.000Z', '2018-12-31T23:59:59.999Z', true, empty))
    expect(result).toEqual({ entries: [], audit: [], audit_outside: [], rattelse: [] })
  })
})

describe('behandlingshistorik_decisions', () => {
  it("fiscal-year mode: the window's decisions and those that booked the year's verifikat, with what their receipts read", async () => {
    const result = await withUserContext(userId, (client) => decisions(client, FROM, TO, true))
    expect(ids(result.rows)).toEqual([decision.may, decision.late, decision.named, decision.noFinal, decision.malformed].sort())
    expect(Object.keys(result.rows[0]).sort()).toEqual([
      'acted_on', 'actor_type', 'checks', 'confidence_band', 'created_at', 'document_id', 'final', 'id', 'inbox_item_id',
      'input_hash', 'kind', 'outcome', 'pending_operation_id', 'policy_version', 'resolved_by', 'rule_version', 'suggestions',
      'transaction_id',
    ])
    // The vouchers they booked; a malformed id matches nothing instead of failing the read.
    expect(ids(result.entries)).toEqual([e.e1, e.e2, e.mayCommit].sort())
    const voucher = result.entries.find((r) => r.id === e.e1)!
    expect(Object.keys(voucher).sort()).toEqual(['commit_method', 'committed_actor_label', 'committed_actor_type', 'id', 'status', 'voucher_number', 'voucher_series'])
    expect(voucher).toMatchObject({ voucher_series: 'A', voucher_number: 1, status: 'posted' })
    // The operation a row names, whatever its state; the committed ones found
    // by the voucher for rows that name none.
    expect(ids(result.operations)).toEqual([op.named])
    expect(ids(result.legacy_by_entry)).toEqual([op.byEntry])
    expect(ids(result.legacy_by_registration)).toEqual([op.byRegistration])
    expect(result.legacy_by_entry[0]).toMatchObject({ journal_entry_id: e.e1, registration_journal_entry_id: null, actor_label: 'Zapier' })
  })

  it('date-range mode: the decisions registered in the window only', async () => {
    const result = await withUserContext(userId, (client) => decisions(client, MAY_FROM, MAY_TO, false))
    expect(ids(result.rows)).toEqual([decision.may, decision.named, decision.noFinal, decision.malformed].sort())
    expect(ids(result.entries)).toEqual([e.e1, e.mayCommit].sort())
    expect(ids(result.legacy_by_registration)).toEqual([])
  })

  it('scopes to the caller', async () => {
    const outsider = await withUserContext(outsiderId, (client) => decisions(client, FROM, TO, true))
    expect(outsider).toEqual({ rows: [], entries: [], operations: [], legacy_by_entry: [], legacy_by_registration: [] })
    const service = await runAsServiceRole((client) => decisions(client, FROM, TO, true))
    const member = await withUserContext(userId, (client) => decisions(client, FROM, TO, true))
    for (const key of ['rows', 'entries', 'operations', 'legacy_by_entry', 'legacy_by_registration'] as const) {
      expect(ids(service[key]), key).toEqual(ids(member[key]))
    }
  })
})
