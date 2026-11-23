import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import { AUDITED_TABLES, GLOBAL_ACTIONS } from '@/lib/reports/behandlingshistorik'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
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
  // A global action on an audited table, and one on no table: the window read
  // keeps each once, through the global actions (20261123104000).
  audit.globalOnAudited = await insertAudit({ action: 'RETENTION_BLOCK', table: 'journal_entries', recordId: e.e1, at: '2020-02-11T09:00:00Z' })
  audit.globalOnNoTable = await insertAudit({ action: 'SECURITY_EVENT', table: null, at: '2020-02-11T09:00:01Z' })
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
      'globalOnAudited', 'globalOnNoTable',
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
      'acted_on', 'actor_type', 'agent_reason', 'checks', 'confidence_band', 'created_at', 'document_id', 'final', 'id', 'inbox_item_id',
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

/**
 * idx_audit_log_history_window and idx_audit_log_history_entry (migrations
 * 20261123091600 and 20261123091700) hold only the audit rows an event can
 * come from, so the function's two audit reads stop fetching a verifikat's
 * INSERT and COMMIT rows from the heap only to drop them (production,
 * 2026-11-23: a month and a fiscal year of the largest company past the 8 s
 * statement timeout). The planner can use a partial index only when it
 * proves the index's predicate from the statement's own WHERE clause, and
 * each predicate is that statement's exclusion word for word: an edit to one
 * without the other leaves the index unusable, and the first test fails.
 * Which index production's planner prefers is a matter of size and is not
 * asked here: these tables are nearly empty, so each call runs with only one
 * side's indexes (the other audit_log indexes dropped, or the history ones)
 * and sequential scans priced out.
 */
describe('behandlingshistorik_sources: the history indexes', () => {
  const HISTORY_INDEXES = ['idx_audit_log_history_window', 'idx_audit_log_history_entry']
  /** Kept on both sides: the primary key, and the action index the window's other arm (global actions) reads. */
  const SHARED_INDEXES = ['audit_log_pkey', 'idx_audit_log_action']

  interface PlanNode {
    'Index Name'?: string
    'Index Cond'?: string
    'Recheck Cond'?: string
    Filter?: string
    Plans?: PlanNode[]
  }
  /** Every index scan in the plan, with its index condition. */
  const indexScans = (node: PlanNode): Array<{ index: string; cond: string }> => [
    ...(node['Index Name'] ? [{ index: node['Index Name'], cond: node['Index Cond'] ?? '' }] : []),
    ...(node.Plans ?? []).flatMap(indexScans),
  ]
  /** Every condition in the plan: index conditions, rechecks and filters. */
  const conditions = (node: PlanNode): string[] => [
    ...[node['Index Cond'], node['Recheck Cond'], node.Filter].filter((c): c is string => !!c),
    ...(node.Plans ?? []).flatMap(conditions),
  ]

  /**
   * One call as the member, in a transaction that is rolled back, with only
   * the history indexes on audit_log or only the others: the function's
   * result, and each statement it ran with the indexes its plan names
   * (auto_explain reports the nested statements to the client).
   */
  async function call(from: string, to: string, fiscalYear: boolean, side: 'history' | 'others', settings: string[] = []) {
    const client = await getClient()
    const notices: string[] = []
    const onNotice = (notice: { message?: string }) => {
      if (notice.message) notices.push(notice.message)
    }
    client.on('notice', onNotice)
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'audit_log'`,
      )
      const drop = rows
        .map((r) => r.indexname)
        .filter((name) => !SHARED_INDEXES.includes(name) && HISTORY_INDEXES.includes(name) === (side === 'others'))
      for (const index of drop) await client.query(`DROP INDEX public.${index}`)
      for (const setting of ['enable_seqscan = off', ...settings]) await client.query(`SET LOCAL ${setting}`)
      for (const setting of ['log_min_duration = 0', 'log_nested_statements = on', 'log_format = json', 'log_level = notice']) {
        await client.query(`SET LOCAL auto_explain.${setting}`)
      }
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
      await client.query('SET LOCAL ROLE authenticated')
      const result = await sources(client, from, to, fiscalYear)
      const plans = notices
        .filter((message) => message.includes('"Plan"'))
        .map((message) => JSON.parse(message.slice(message.indexOf('{'))) as { 'Query Text': string; Plan: PlanNode })
        .map((explained) => {
          const scans = indexScans(explained.Plan)
          return { query: explained['Query Text'], scans, indexes: scans.map((scan) => scan.index), conditions: conditions(explained.Plan) }
        })
      return { result, plans }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.off('notice', onNotice)
      client.release()
    }
  }

  /** The one statement whose text contains `marker`. */
  const find = <T extends { query: string }>(plans: T[], marker: string): T => {
    const found = plans.filter((p) => p.query.includes(marker))
    expect(found, marker).toHaveLength(1)
    return found[0]
  }
  /** The indexes of the one statement whose text contains `marker`. */
  const statement = (plans: Array<{ query: string; indexes: string[] }>, marker: string) => find(plans, marker).indexes

  it("can read the window's rows through idx_audit_log_history_window and the year's verifikat through idx_audit_log_history_entry", async () => {
    // Fiscal-year mode: the window, then the rows about the year's verifikat
    // logged after it (the fixtures' trigger rows are logged now).
    const year = await call(FROM, TO, true, 'history')
    expect(statement(year.plans, 'SELECT coalesce(json_agg(a)')).toContain('idx_audit_log_history_window')
    expect(statement(year.plans, 'outside_window AS')).toContain('idx_audit_log_history_entry')
    const month = await call(MAY_FROM, MAY_TO, false, 'history')
    expect(statement(month.plans, 'SELECT coalesce(json_agg(a)')).toContain('idx_audit_log_history_window')
  })

  it('reads the audited tables apart from the global actions, so the table list is an index condition', async () => {
    // The planner can read a large company's year with a plain index scan of
    // idx_audit_log_history_window. With the table list in one OR with the
    // global actions, only the company and the dates were index conditions
    // there, and the rows of every other table were fetched and dropped, past
    // the statement timeout. Read apart (20261123104000), the table list is an
    // index condition in a bitmap plan and in a plain one alike.
    // PostgreSQL 15, which pg-real runs, may still plan a lower-order IN list
    // as a filter when the table is nearly empty; 17, which production runs,
    // always makes it an index condition. So the plan's index condition is
    // checked on 17, and on every version that no condition holds the table
    // list together with the global actions. (A bitmap heap scan's recheck
    // repeats the index predicate, which names INSERT and COMMIT: the global
    // actions are told apart by their own list.)
    const { rows } = await getPool().query<{ server_version_num: string }>('SHOW server_version_num')
    const indexCondition = Number(rows[0].server_version_num) >= 170000
    const globalActions = `action = ANY ('{${GLOBAL_ACTIONS.join(',')}}'`
    for (const settings of [['enable_indexscan = off'], ['enable_bitmapscan = off']]) {
      for (const [from, to, fiscalYear] of [[FROM, TO, true], [MAY_FROM, MAY_TO, false]] as const) {
        const { plans } = await call(from, to, fiscalYear, 'history', settings)
        const window = find(plans, 'SELECT coalesce(json_agg(a)')
        const label = `${settings.join()} ${fiscalYear ? 'year' : 'month'}`
        expect(window.conditions.filter((c) => c.includes('table_name = ANY') && c.includes(globalActions)), label).toEqual([])
        const scans = window.scans.filter((scan) => scan.index === 'idx_audit_log_history_window')
        expect(scans.length, label).toBeGreaterThan(0)
        if (indexCondition) for (const scan of scans) expect(scan.cond, label).toContain('table_name = ANY')
      }
    }
  })

  it('returns the same rows through the history indexes as through the others', async () => {
    // Each array comes in the order its plan reads the rows (the function's
    // json_agg has no ORDER BY, before these indexes as after), so they are
    // compared by id. The report orders its events itself, by time, source
    // and id: behandlingshistorik.test.ts pins that the database's order does
    // not reach it.
    const byId = (rows: Array<{ id: string }>) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const [from, to, fiscalYear] of [[FROM, TO, true], [MAY_FROM, MAY_TO, false]] as const) {
      const history = await call(from, to, fiscalYear, 'history')
      const others = await call(from, to, fiscalYear, 'others')
      expect(others.plans.flatMap((p) => p.indexes).filter((i) => HISTORY_INDEXES.includes(i))).toEqual([])
      for (const key of ['entries', 'audit', 'audit_outside', 'rattelse'] as const) {
        expect(byId(history.result[key]), key).toEqual(byId(others.result[key]))
      }
      // What the indexes leave out is what the function drops: the noise is
      // absent and the rows the report shows are there.
      const got = new Set([...history.result.audit, ...history.result.audit_outside].map((r) => r.id))
      for (const key of ['entryInsert', 'entryCommit', 'draftEdit', 'documentInsert', 'documentUpdate', 'lateCommit']) {
        expect(got.has(audit[key]), key).toBe(false)
      }
      for (const key of fiscalYear
        ? ['postedEdit', 'mayReverse', 'mayGuard', 'lateReverse', 'mayCommitLateReverse', 'globalOnAudited', 'globalOnNoTable']
        : ['mayReverse', 'mayGuard']) {
        expect(got.has(audit[key]), key).toBe(true)
      }
    }
  })
})
