/**
 * A corrected salary run's AGI, end to end over one in-memory database:
 * generate (lib/salary/agi/generate-declaration.ts) -> submit
 * (lib/agi-submit.ts) -> kvittens reconciliation (lib/agi-kvittens-reconcile.ts).
 *
 * agi_declarations holds one row per company and redovisningsperiod. A
 * correction run's generation takes over the original's FILED row; it used to
 * keep the original's status 'submitted' and kvittens, so the submit never
 * moved it to pending_signature, the cron (which only polls
 * pending_signature) never asked for the correction's kvittens, and the app
 * kept showing the original's filing. A correction is a complete replacement
 * declaration for the period with its own kvittens (agi-filing.md,
 * Corrections). Skatteverket is never called: the AGI client is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: () => '199001011234',
}))
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  sleep: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/agi-client', () => ({
  agiPostUnderlag: vi.fn(),
  agiGetKontrollresultat: vi.fn(),
  agiSkapaGranskningsunderlag: vi.fn(),
  agiGetKvittenser: vi.fn(),
}))
vi.mock('../lib/resolve-auth', () => ({ resolveReadAuth: vi.fn() }))
vi.mock('../lib/kvittens-notification', () => ({
  sendKvittensNotification: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: vi.fn().mockResolvedValue(undefined),
}))

import { generateAgiDeclaration } from '@/lib/salary/agi/generate-declaration'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import { submitAgiChain } from '../lib/agi-submit'
import { reconcileAgiDeclaration, type PendingAgiDeclaration } from '../lib/agi-kvittens-reconcile'
import {
  agiGetKontrollresultat,
  agiGetKvittenser,
  agiPostUnderlag,
  agiSkapaGranskningsunderlag,
} from '../lib/agi-client'
import { resolveReadAuth } from '../lib/resolve-auth'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'

type Row = Record<string, unknown>

/**
 * The PostgREST surface the three steps use, over plain arrays: filters,
 * single/maybeSingle, insert with the agi_declarations defaults, update with
 * an optional returning select, upsert with ignoreDuplicates, delete. Column
 * projections are ignored (an embedded select is stored embedded).
 */
function memoryDb(tables: Record<string, Row[]>) {
  let nextId = 1
  const defaults: Record<string, Row> = {
    agi_declarations: {
      status: 'generated',
      kvittensnummer: null,
      submitted_at: null,
      submitted_by: null,
      response_data: null,
      is_correction: false,
    },
  }
  const from = (table: string) => {
    const rows = (tables[table] ??= [])
    const filters: Array<(row: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let values: Row | Row[] = {}
    let conflictKeys: string[] = []
    let returning = false
    let limit: number | null = null
    let order: { column: string; ascending: boolean } | null = null

    const run = (): { data: unknown; error: unknown } => {
      const matched = () => rows.filter((row) => filters.every((f) => f(row)))
      if (op === 'insert') {
        const inserted = (values as Row[]).map((v) => ({
          id: `${table}-${nextId++}`,
          created_at: new Date().toISOString(),
          ...(defaults[table] ?? {}),
          ...v,
        }))
        rows.push(...inserted)
        return { data: returning ? inserted.map((r) => ({ ...r })) : null, error: null }
      }
      if (op === 'upsert') {
        for (const v of values as Row[]) {
          if (!rows.some((row) => conflictKeys.every((k) => row[k] === v[k]))) rows.push({ id: `${table}-${nextId++}`, ...v })
        }
        return { data: null, error: null }
      }
      if (op === 'update') {
        const hit = matched()
        for (const row of hit) Object.assign(row, values)
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      if (op === 'delete') {
        const hit = new Set(matched())
        tables[table] = rows.filter((row) => !hit.has(row))
        return { data: null, error: null }
      }
      let result = matched()
      if (order) {
        const { column, ascending } = order
        result = [...result].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1))
      }
      if (limit !== null) result = result.slice(0, limit)
      return { data: result.map((r) => ({ ...r })), error: null }
    }

    const chain: Record<string, unknown> = {
      select: () => {
        if (op !== 'select') returning = true
        return chain
      },
      insert: (v: Row | Row[]) => {
        op = 'insert'
        values = Array.isArray(v) ? v : [v]
        return chain
      },
      update: (v: Row) => {
        op = 'update'
        values = v
        return chain
      },
      upsert: (v: Row | Row[], options?: { onConflict?: string }) => {
        op = 'upsert'
        values = Array.isArray(v) ? v : [v]
        conflictKeys = (options?.onConflict ?? 'id').split(',')
        return chain
      },
      delete: () => {
        op = 'delete'
        return chain
      },
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), chain),
      neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), chain),
      in: (column: string, list: unknown[]) => (filters.push((row) => list.includes(row[column])), chain),
      is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), chain),
      not: (column: string, _operator: 'is', value: unknown) => (filters.push((row) => (row[column] ?? null) !== value), chain),
      gte: (column: string, value: string) => (filters.push((row) => String(row[column]) >= value), chain),
      lte: (column: string, value: string) => (filters.push((row) => String(row[column]) <= value), chain),
      order: (column: string, options?: { ascending?: boolean }) => {
        order = { column, ascending: options?.ascending !== false }
        return chain
      },
      limit: (n: number) => {
        limit = n
        return chain
      },
      single: async () => {
        const { data } = run()
        const first = (data as Row[])[0]
        return first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
      },
      maybeSingle: async () => ({ data: (run().data as Row[])[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        try {
          resolve(run())
        } catch (err) {
          reject(err)
        }
      },
    }
    return chain
  }
  const one = (table: string, id: string) => (tables[table] ?? []).find((row) => row.id === id) as Row
  return { supabase: { from } as never, tables, one }
}

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
const settings = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), clear: vi.fn() } as never

const ORIGINAL_KVITTENS = {
  arbetsgivare: '165561234567',
  period: '202605',
  uuidKvittens: 'k-original',
  signeradAv: '191212121212',
  signeradTid: '2026-06-10T09:00:00Z',
  underlag: { arbetsgivarregistrerad: '165561234567', redovisningsperiod: '202605', antalIu: 1, antalIuTillagda: 0, antalIuBorttagna: 0 },
}
const CORRECTION_KVITTENS = { ...ORIGINAL_KVITTENS, uuidKvittens: 'k-correction', signeradTid: '2026-06-20T14:00:00Z' }

function baseTables(): Record<string, Row[]> {
  return {
    companies: [{ id: COMPANY_ID, name: 'Test AB', org_number: '556123-4567' }],
    company_settings: [
      {
        company_id: COMPANY_ID,
        company_name: 'Test AB',
        org_number: '556123-4567',
        entity_type: 'aktiebolag',
        phone: '0701234567',
        email: 'agi@test.se',
      },
    ],
    profiles: [{ id: USER_ID, full_name: 'Anna Admin', email: 'anna@test.se' }],
    salary_absence_days: [],
    agi_kvittenser: [],
    extension_data: [],
  }
}

function salaryRun(id: string, overrides: Row = {}): Row {
  return {
    id,
    company_id: COMPANY_ID,
    status: 'booked',
    period_year: 2026,
    period_month: 5,
    payment_date: '2026-05-25',
    total_gross: 40000,
    total_tax: 12000,
    calculation_params: {},
    is_correction: false,
    corrects_run_id: null,
    agi_generated_at: null,
    agi_submitted_at: null,
    ...overrides,
  }
}

function payslip(runId: string, gross: number): Row {
  return {
    salary_run_id: runId,
    company_id: COMPANY_ID,
    employee_id: '11111111-1111-4111-8111-111111111111',
    monthly_salary: gross,
    gross_salary: gross,
    tax_withheld: 12000,
    avgifter_basis: gross,
    avgifter_amount: Math.round(gross * 0.3142 * 100) / 100,
    avgifter_rate: 0.3142,
    avgifter_category: 'standard',
    employee: { personnummer: 'enc', specification_number: 1, f_skatt_status: 'a_skatt' },
    line_items: [],
  }
}

function generate(db: ReturnType<typeof memoryDb>, salaryRunId: string) {
  return generateAgiDeclaration({
    supabase: db.supabase,
    companyId: COMPANY_ID,
    userId: USER_ID,
    userEmail: null,
    salaryRunId,
    log,
    requestId: 'req-1',
  })
}

/** What the kvittens cron does: every pending_signature declaration, reconciled. */
async function cronPass(db: ReturnType<typeof memoryDb>) {
  const pending = (db.tables.agi_declarations ?? []).filter((d) => d.status === 'pending_signature')
  const outcomes = []
  for (const decl of pending) {
    outcomes.push(await reconcileAgiDeclaration(db.supabase, decl as unknown as PendingAgiDeclaration, { reconciledBy: 'cron' }))
  }
  return outcomes
}

function kvittenserListed(...kvittenser: unknown[]) {
  vi.mocked(agiGetKvittenser).mockResolvedValue({ ok: true, status: 200, data: { kvittenser } } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(agiPostUnderlag).mockResolvedValue({ ok: true, data: { inlamningId: 42 } } as never)
  vi.mocked(agiGetKontrollresultat).mockResolvedValue({ ok: true, data: { status: 'DONE_SUCCESS' } } as never)
  vi.mocked(agiSkapaGranskningsunderlag).mockResolvedValue({
    ok: true,
    data: { tillstand: 'LOCKED_FOR_SIGNING', link: 'https://skatteverket.se/sign', meddelande: null },
  } as never)
  vi.mocked(resolveReadAuth).mockResolvedValue({
    ok: true,
    auth: { mode: 'user' },
    source: 'user',
    tokenUserId: USER_ID,
  } as never)
})

describe('a corrected run: generate, submit, and the kvittens promotes the correction', () => {
  function correctedMonth() {
    const tables = baseTables()
    tables.salary_runs = [
      // The original, filed on 10 June, then corrected.
      salaryRun('run-orig', {
        status: 'corrected',
        agi_generated_at: '2026-06-01T08:00:00Z',
        agi_submitted_at: ORIGINAL_KVITTENS.signeradTid,
      }),
      salaryRun('run-corr', { total_gross: 41000, is_correction: true, corrects_run_id: 'run-orig' }),
    ]
    tables.salary_run_employees = [payslip('run-orig', 40000), payslip('run-corr', 41000)]
    tables.agi_declarations = [
      {
        id: 'agi-1',
        company_id: COMPANY_ID,
        user_id: USER_ID,
        salary_run_id: 'run-orig',
        period_year: 2026,
        period_month: 5,
        xml_content: '<original/>',
        status: 'submitted',
        kvittensnummer: 'k-original',
        submitted_at: ORIGINAL_KVITTENS.signeradTid,
        submitted_by: USER_ID,
        response_data: { uuidKvittens: 'k-original', signeradTid: ORIGINAL_KVITTENS.signeradTid },
        is_correction: false,
        total_gross: 40000,
        created_at: '2026-06-01T08:00:00Z',
      },
    ]
    tables.agi_kvittenser = [
      { company_id: COMPANY_ID, period_year: 2026, period_month: 5, uuid_kvittens: 'k-original', signerad_tid: ORIGINAL_KVITTENS.signeradTid, receipt: ORIGINAL_KVITTENS, recorded_by: 'cron' },
    ]
    return memoryDb(tables)
  }

  it('starts the correction unfiled, submits it, waits for its own kvittens and promotes the correction', async () => {
    const db = correctedMonth()

    // 1. Generate the correction's AGI: the period's row is taken over, unfiled.
    const generated = await generate(db, 'run-corr')
    expect(generated).toMatchObject({ ok: true, isCorrection: true, periodYear: 2026, periodMonth: 5 })
    expect(db.one('agi_declarations', 'agi-1')).toMatchObject({
      salary_run_id: 'run-corr',
      status: 'generated',
      kvittensnummer: null,
      submitted_at: null,
      total_gross: 41000,
    })
    // The original filing is kept where it has always been kept.
    expect(db.one('salary_runs', 'run-orig').agi_submitted_at).toBe(ORIGINAL_KVITTENS.signeradTid)
    expect(db.tables.agi_kvittenser.map((k) => k.uuid_kvittens)).toEqual(['k-original'])

    // 2. Submit: the correction's XML is posted and the row awaits signature.
    const submitted = await submitAgiChain(db.supabase, USER_ID, COMPANY_ID, settings, 'run-corr')
    expect(submitted).toMatchObject({ ok: true, period: '202605' })
    expect(vi.mocked(agiPostUnderlag).mock.calls[0][3]).toBe(db.one('agi_declarations', 'agi-1').xml_content)
    expect(db.one('agi_declarations', 'agi-1').status).toBe('pending_signature')

    // 3. The cron asks before the correction is signed: Skatteverket lists only
    //    the original's kvittens, which is not the correction's.
    kvittenserListed(ORIGINAL_KVITTENS)
    expect(await cronPass(db)).toEqual([{ status: 'still_pending' }])
    expect(db.one('agi_declarations', 'agi-1').status).toBe('pending_signature')
    expect(db.one('salary_runs', 'run-corr').agi_submitted_at).toBeNull()
    expect(completeTaxDeadline).not.toHaveBeenCalled()

    // 4. Signed: the correction's own kvittens promotes it.
    kvittenserListed(ORIGINAL_KVITTENS, CORRECTION_KVITTENS)
    expect(await cronPass(db)).toEqual([{ status: 'signed', kvittensnummer: 'k-correction' }])
    expect(db.one('agi_declarations', 'agi-1')).toMatchObject({
      salary_run_id: 'run-corr',
      status: 'submitted',
      kvittensnummer: 'k-correction',
      submitted_at: CORRECTION_KVITTENS.signeradTid,
    })
    expect(db.one('salary_runs', 'run-corr').agi_submitted_at).toBe(CORRECTION_KVITTENS.signeradTid)
    expect(db.one('salary_runs', 'run-orig').agi_submitted_at).toBe(ORIGINAL_KVITTENS.signeradTid)
    expect(db.tables.agi_kvittenser.map((k) => k.uuid_kvittens).sort()).toEqual(['k-correction', 'k-original'])
    expect(completeTaxDeadline).toHaveBeenCalledTimes(1)

    // Nothing is left for the cron.
    expect(await cronPass(db)).toEqual([])
  })
})

describe('the normal path is unchanged: generate, submit, kvittens', () => {
  it('files a run with no earlier filing on the newest kvittens', async () => {
    const tables = baseTables()
    tables.salary_runs = [salaryRun('run-1')]
    tables.salary_run_employees = [payslip('run-1', 40000)]
    const db = memoryDb(tables)

    const generated = await generate(db, 'run-1')
    expect(generated).toMatchObject({ ok: true, isCorrection: false })
    expect(db.tables.agi_declarations).toHaveLength(1)
    expect(db.tables.agi_declarations[0]).toMatchObject({ salary_run_id: 'run-1', status: 'generated' })

    expect(await submitAgiChain(db.supabase, USER_ID, COMPANY_ID, settings, 'run-1')).toMatchObject({ ok: true })
    expect(db.tables.agi_declarations[0].status).toBe('pending_signature')

    kvittenserListed(ORIGINAL_KVITTENS)
    expect(await cronPass(db)).toEqual([{ status: 'signed', kvittensnummer: 'k-original' }])
    expect(db.tables.agi_declarations[0]).toMatchObject({ status: 'submitted', kvittensnummer: 'k-original' })
    expect(db.one('salary_runs', 'run-1').agi_submitted_at).toBe(ORIGINAL_KVITTENS.signeradTid)
  })
})
