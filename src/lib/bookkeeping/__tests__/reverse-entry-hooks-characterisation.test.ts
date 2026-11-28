/**
 * Characterisation of reverseEntry's business-state mirrors (the reversal
 * hooks), written against the engine before the hooks became a registry and
 * kept byte-identical through that change: the snapshot beside this file is
 * the parity proof.
 *
 * For every journal entry source type it records, in order, every write and
 * RPC reverseEntry makes, the storno target check, the three hook functions
 * (with their arguments) and the two emits. The hooked source types today:
 *   - rot_rut_reclassification: assertMigratedDeductionReversible after the
 *     chain-depth guard and before assertStornoTarget (before any write, so a
 *     refusal spends no voucher number), syncMigratedDeductionAfterReversal
 *     after the storno;
 *   - the four payment source types: syncInvoiceStatusFromPaymentEntry;
 *   - rot_rut_reclaim: syncRotRutReclaimAfterReversal;
 *   - supplier_invoice_registered: assertSupplierInvoiceRegistrationReversible
 *     before (the same place as the migrated-deduction check), and
 *     releaseSupplierInvoiceRegistrationAfterReversal after the storno;
 *   - invoice_created: assertInvoiceVerifikatReversible before, nothing after;
 *   - salary_payment: assertSalaryRunVerifikatReversible before, nothing
 *     after, skipped on Korrigera lönekörning's own stornos
 *     (salaryRunCorrection).
 * Every after-hook runs after the CAS to 'reversed', the bank-line release,
 * the IB unlink and the depreciation release, and before the emits. Nothing
 * catches a hook's throw: it propagates, the storno stands and the emits are
 * skipped.
 *
 * correctEntry (storno plus rättelse) runs none of the hooks: pinned here so
 * that choice changes only on purpose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEntrySourceType } from '@/types'

const h = vi.hoisted(() => {
  const trace: string[] = []
  const subject: { client: unknown; original: unknown } = { client: null, original: null }
  const describeArg = (arg: unknown): string => {
    if (arg === subject.client) return '<client>'
    if (arg === subject.original) return '<original>'
    return JSON.stringify(arg)
  }
  const hook = (name: string) =>
    vi.fn(async (...args: unknown[]) => {
      trace.push(`${name}(${args.map(describeArg).join(', ')})`)
    })
  return {
    trace,
    subject,
    syncInvoiceStatusFromPaymentEntry: hook('syncInvoiceStatusFromPaymentEntry'),
    syncRotRutReclaimAfterReversal: hook('syncRotRutReclaimAfterReversal'),
    assertMigratedDeductionReversible: hook('assertMigratedDeductionReversible'),
    syncMigratedDeductionAfterReversal: hook('syncMigratedDeductionAfterReversal'),
    assertSupplierInvoiceRegistrationReversible: hook('assertSupplierInvoiceRegistrationReversible'),
    releaseSupplierInvoiceRegistrationAfterReversal: hook('releaseSupplierInvoiceRegistrationAfterReversal'),
    assertInvoiceVerifikatReversible: hook('assertInvoiceVerifikatReversible'),
    assertSalaryRunVerifikatReversible: hook('assertSalaryRunVerifikatReversible'),
    emit: vi.fn(async (event: { type: string }) => {
      trace.push(`emit ${event.type}`)
      return []
    }),
    assertStornoTarget: vi.fn(
      async (_supabase: unknown, _companyId: unknown, original: { entry_date: string; fiscal_period_id: string }, date?: string) => {
        trace.push('assertStornoTarget')
        return { date: date ?? original.entry_date, fiscal_period_id: original.fiscal_period_id, moved: false }
      },
    ),
  }
})

vi.mock('@/lib/events', () => ({ eventBus: { emit: h.emit } }))
vi.mock('@/lib/bookkeeping/account-backfill', () => ({ backfillStandardBASAccounts: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/core/bookkeeping/storno-target', () => ({ assertStornoTarget: h.assertStornoTarget }))
vi.mock('@/lib/bookkeeping/payment-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/payment-sync')>()),
  syncInvoiceStatusFromPaymentEntry: h.syncInvoiceStatusFromPaymentEntry,
}))
vi.mock('@/lib/invoices/rot-rut-reclaim-reversal', () => ({
  syncRotRutReclaimAfterReversal: h.syncRotRutReclaimAfterReversal,
}))
vi.mock('@/lib/invoices/migrated-deduction-reversal', () => ({
  assertMigratedDeductionReversible: h.assertMigratedDeductionReversible,
  syncMigratedDeductionAfterReversal: h.syncMigratedDeductionAfterReversal,
}))
vi.mock('@/lib/supplier-invoices/registration-reversal', () => ({
  assertSupplierInvoiceRegistrationReversible: h.assertSupplierInvoiceRegistrationReversible,
  releaseSupplierInvoiceRegistrationAfterReversal: h.releaseSupplierInvoiceRegistrationAfterReversal,
}))
vi.mock('@/lib/invoices/invoice-verifikat-reversal', () => ({
  assertInvoiceVerifikatReversible: h.assertInvoiceVerifikatReversible,
}))
vi.mock('@/lib/salary/run-verifikat-reversal', () => ({
  assertSalaryRunVerifikatReversible: h.assertSalaryRunVerifikatReversible,
}))

import { reverseEntry } from '../engine'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'

/** Every JournalEntrySourceType: the compiler fails here when one is added or removed. */
const SOURCE_TYPE_SET: Record<JournalEntrySourceType, true> = {
  manual: true,
  bank_transaction: true,
  invoice_created: true,
  invoice_paid: true,
  invoice_cash_payment: true,
  credit_note: true,
  salary_payment: true,
  opening_balance: true,
  year_end: true,
  storno: true,
  correction: true,
  import: true,
  system: true,
  tax_account: true,
  inbox_item: true,
  supplier_invoice_registered: true,
  supplier_invoice_paid: true,
  supplier_invoice_cash_payment: true,
  supplier_invoice_privately_paid: true,
  supplier_credit_note: true,
  currency_revaluation: true,
  reminder_fee: true,
  accrual: true,
  result_appropriation: true,
  rot_rut_payout: true,
  vat_settlement: true,
  stripe_payout: true,
  webshop_order: true,
  expense_claim: true,
  expense_payout: true,
  rot_rut_reclaim: true,
  pos_daily_sales: true,
  rot_rut_reclassification: true,
  collection_settlement: true,
  customer_loss: true,
  counterparty_setoff: true,
}
const SOURCE_TYPES = Object.keys(SOURCE_TYPE_SET) as JournalEntrySourceType[]

const HOOK_FUNCTIONS = [
  'syncInvoiceStatusFromPaymentEntry',
  'syncRotRutReclaimAfterReversal',
  'assertMigratedDeductionReversible',
  'syncMigratedDeductionAfterReversal',
  'assertSupplierInvoiceRegistrationReversible',
  'releaseSupplierInvoiceRegistrationAfterReversal',
  'assertInvoiceVerifikatReversible',
  'assertSalaryRunVerifikatReversible',
] as const

/** The before-hooks among HOOK_FUNCTIONS: each refuses before anything is written. */
const BEFORE_HOOK_CHECKS = [
  ['rot_rut_reclassification', 'assertMigratedDeductionReversible'],
  ['supplier_invoice_registered', 'assertSupplierInvoiceRegistrationReversible'],
  ['invoice_created', 'assertInvoiceVerifikatReversible'],
  ['salary_payment', 'assertSalaryRunVerifikatReversible'],
] as const

const CHART = ['1510', '1513', '1930', '3001', '3002'].map((n) => ({ id: `acc-${n}`, account_number: n }))

function originalOf(sourceType: JournalEntrySourceType) {
  return {
    id: 'entry-1',
    company_id: 'company-1',
    user_id: 'user-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 7,
    entry_date: '2026-03-10',
    description: 'Original',
    notes: null,
    source_type: sourceType,
    source_id: 'source-1',
    correction_of_id: null as string | null,
    reverses_id: null as string | null,
    lines: [
      { account_number: '1930', debit_amount: 100, credit_amount: 0, line_description: 'Bank' },
      { account_number: '3001', debit_amount: 0, credit_amount: 100, line_description: 'Sales' },
    ],
  }
}

function describeWrite(table: string, op: string, payload: unknown): string {
  if (Array.isArray(payload)) return `${op} ${table} x${payload.length}`
  if (!payload || typeof payload !== 'object') return `${op} ${table}`
  const fields = Object.entries(payload as Record<string, unknown>)
    .filter(([key]) =>
      table === 'journal_entries' ? ['status', 'source_type', 'reverses_id', 'reversed_by_id', 'correction_of_id'].includes(key) : true,
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
  return `${op} ${table}${fields.length ? ` ${fields.join(' ')}` : ''}`
}

/**
 * A client that walks the storno paths and appends every write and RPC to
 * the trace. Reads answer what the happy path needs: the original on the
 * first journal_entries read, the chart, and empty sets elsewhere.
 */
function recordingClient(original: ReturnType<typeof originalOf>) {
  let journalReads = 0
  let journalInserts = 0
  const insertedIds = ['reversal-1', 'corrected-1']

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let payload: unknown
    const b: Record<string, unknown> = {}
    const write = (kind: 'insert' | 'update' | 'delete') => (p?: unknown) => {
      op = kind
      payload = p
      h.trace.push(describeWrite(table, kind, p))
      return b
    }
    b.insert = write('insert')
    b.update = write('update')
    b.delete = write('delete')
    // Reads of the journal are traced too (the original, the correction-chain
    // walk, the final read of the storno); a select chained after a write is
    // part of that write.
    b.select = (columns?: string) => {
      if (table === 'journal_entries' && op === 'select') h.trace.push(`read journal_entries (${columns ?? '*'})`)
      return b
    }
    for (const m of ['eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit']) b[m] = () => b
    const resolve = () => {
      if (table === 'journal_entries') {
        if (op === 'insert') {
          const id = insertedIds[journalInserts++] ?? `inserted-${journalInserts}`
          return { data: { id, status: 'draft', ...(payload as object) }, error: null }
        }
        if (op === 'update') {
          const status = (payload as { status?: string } | undefined)?.status
          return status === 'reversed' ? { data: [{ id: original.id }], error: null } : { data: null, error: null }
        }
        journalReads++
        if (journalReads === 1) return { data: original, error: null }
        return { data: { id: `read-${journalReads}`, status: 'posted', lines: [] }, error: null }
      }
      if (table === 'chart_of_accounts') return { data: CHART, error: null }
      if (op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    }
    b.single = async () => resolve()
    b.maybeSingle = async () => resolve()
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected)
    return b
  }

  return {
    from: vi.fn((table: string) => builder(table)),
    rpc: vi.fn(async (name: string) => {
      h.trace.push(`rpc ${name}`)
      if (name === 'release_reversed_entry_transactions') return { data: { released: 0, dropped: 0 }, error: null }
      return { data: null, error: null }
    }),
  }
}

async function runReverse(
  sourceType: JournalEntrySourceType,
  overrides: Partial<ReturnType<typeof originalOf>> = {},
  options?: Parameters<typeof reverseEntry>[5],
) {
  const original = { ...originalOf(sourceType), ...overrides }
  const client = recordingClient(original)
  h.subject.client = client
  h.subject.original = original
  let error: string | undefined
  try {
    if (options) await reverseEntry(client as never, 'company-1', 'user-1', 'entry-1', undefined, options)
    else await reverseEntry(client as never, 'company-1', 'user-1', 'entry-1')
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : JSON.stringify(err)
  }
  return { trace: [...h.trace], ...(error ? { error } : {}) }
}

const hookCalls = (trace: string[]) => trace.filter((step) => HOOK_FUNCTIONS.some((fn) => step.startsWith(`${fn}(`)))

beforeEach(() => {
  vi.clearAllMocks()
  h.trace.length = 0
})

describe('reverseEntry: reversal hooks per source type (characterisation)', () => {
  it.each(SOURCE_TYPES)('%s', async (sourceType) => {
    const result = await runReverse(sourceType)
    expect(result).toMatchSnapshot()
  })

  it('runs at most one after-hook per source type, after every engine-owned release and before the emits', async () => {
    for (const sourceType of SOURCE_TYPES) {
      h.trace.length = 0
      const { trace } = await runReverse(sourceType)
      if (sourceType === 'storno') continue
      const after = hookCalls(trace).filter((step) => !BEFORE_HOOK_CHECKS.some(([, fn]) => step.startsWith(`${fn}(`)))
      expect(after.length, sourceType).toBeLessThanOrEqual(1)
      if (after.length === 0) continue
      const at = trace.indexOf(after[0])
      const lastEngineWrite = Math.max(
        trace.findIndex((s) => s.startsWith('update journal_entries') && s.includes('status=reversed')),
        trace.indexOf('rpc release_reversed_entry_transactions'),
        ...trace.map((s, i) => (s.startsWith('update fiscal_periods') || s.startsWith('update depreciation_schedules') ? i : -1)),
      )
      expect(at, sourceType).toBeGreaterThan(lastEngineWrite)
      expect(at, sourceType).toBeLessThan(trace.indexOf('emit journal_entry.committed'))
    }
  })

  it('runs the migrated-deduction check after the chain-depth guard, before the storno target check and any write', async () => {
    const result = await runReverse('rot_rut_reclassification', { correction_of_id: 'parent-1' })
    expect(result).toMatchSnapshot()
    const { trace } = result
    const at = trace.findIndex((s) => s.startsWith('assertMigratedDeductionReversible('))
    const chainRead = trace.findIndex((s) => s.startsWith('read journal_entries (id, correction_of_id'))
    expect(chainRead).toBeGreaterThan(0)
    expect(at).toBeGreaterThan(chainRead)
    expect(trace.indexOf('assertStornoTarget')).toBe(at + 1)
  })

  it('refuses before any write when the migrated-deduction check throws', async () => {
    h.assertMigratedDeductionReversible.mockRejectedValueOnce(new Error('held'))
    const result = await runReverse('rot_rut_reclassification')
    expect(result.error).toBe('Error: held')
    expect(result.trace.filter((s) => !s.startsWith('read journal_entries') && !s.startsWith('assertMigratedDeductionReversible('))).toEqual([])
  })

  it.each(BEFORE_HOOK_CHECKS.filter(([sourceType]) => sourceType !== 'rot_rut_reclassification'))(
    'runs the %s check right before the storno target check, and a refusal writes nothing',
    async (sourceType, fn) => {
      const { trace } = await runReverse(sourceType)
      const at = trace.findIndex((s) => s.startsWith(`${fn}(`))
      expect(at).toBeGreaterThan(0)
      expect(trace.indexOf('assertStornoTarget')).toBe(at + 1)

      h.trace.length = 0
      h[fn].mockRejectedValueOnce(new Error('refused'))
      const result = await runReverse(sourceType)
      expect(result.error).toBe('Error: refused')
      expect(result.trace.filter((s) => !s.startsWith('read journal_entries') && !s.startsWith(`${fn}(`))).toEqual([])
    },
  )

  it('skips the salary run check on the stornos of Korrigera lönekörning (salaryRunCorrection), and only there', async () => {
    const corrected = await runReverse('salary_payment', {}, { salaryRunCorrection: true })
    expect(corrected.error).toBeUndefined()
    expect(h.assertSalaryRunVerifikatReversible).not.toHaveBeenCalled()
    expect(corrected.trace).toContain('rpc commit_journal_entry')

    // The other storno options leave the check in place.
    h.trace.length = 0
    await runReverse('salary_payment', {}, { allowDeepChain: true, collectionsRebook: true })
    expect(h.assertSalaryRunVerifikatReversible).toHaveBeenCalledOnce()
  })

  it.each([
    ['invoice_paid', 'syncInvoiceStatusFromPaymentEntry'],
    ['supplier_invoice_cash_payment', 'syncInvoiceStatusFromPaymentEntry'],
    ['rot_rut_reclaim', 'syncRotRutReclaimAfterReversal'],
    ['rot_rut_reclassification', 'syncMigratedDeductionAfterReversal'],
    ['supplier_invoice_registered', 'releaseSupplierInvoiceRegistrationAfterReversal'],
  ] as const)(
    'propagates a throw from the %s after-hook: the storno stands and the emits are skipped',
    async (sourceType, fn) => {
      h[fn].mockRejectedValueOnce(new Error('mirror failed'))
      const result = await runReverse(sourceType)
      expect(result.error).toBe('Error: mirror failed')
      expect(result.trace).toContain('rpc commit_journal_entry')
      expect(result.trace.some((s) => s.startsWith('update journal_entries') && s.includes('status=reversed'))).toBe(true)
      expect(result.trace.filter((s) => s.startsWith('emit '))).toEqual([])
    },
  )
})

describe('correctEntry: runs no reversal hook (characterisation)', () => {
  it.each([
    'invoice_paid',
    'rot_rut_reclaim',
    'rot_rut_reclassification',
    'supplier_invoice_registered',
    'invoice_created',
    'salary_payment',
  ] as const)('%s', async (sourceType) => {
    const original = originalOf(sourceType)
    const client = recordingClient(original)
    h.subject.client = client
    h.subject.original = original

    await correctEntry(client as never, 'company-1', 'user-1', 'entry-1', [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '3002', debit_amount: 0, credit_amount: 100 },
    ])

    for (const fn of HOOK_FUNCTIONS) expect(h[fn], fn).not.toHaveBeenCalled()
    expect(hookCalls(h.trace)).toEqual([])
    expect(h.trace).toMatchSnapshot()
  })

  // The payment rows follow the rättelse whatever booked the payment
  // (correction-payment-relink.ts). A privately paid supplier invoice is paid
  // by the verifikat of its utlägg, source_type 'expense_claim', which is not
  // one of the payment source types: its rows used to stay on the reversed
  // original.
  it('moves the payment rows of an original that no payment source type names (expense_claim)', async () => {
    const original = originalOf('expense_claim')
    const client = recordingClient(original)
    h.subject.client = client
    h.subject.original = original

    await correctEntry(client as never, 'company-1', 'user-1', 'entry-1', [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '3002', debit_amount: 0, credit_amount: 100 },
    ])

    const paymentRowMoves = h.trace.filter((step) => /^update (invoice_payments|supplier_invoice_payments) |payment_journal_entry_id=/.test(step))
    expect(paymentRowMoves).toEqual([
      'update invoice_payments journal_entry_id=corrected-1',
      'update supplier_invoice_payments journal_entry_id=corrected-1',
      'update supplier_invoices payment_journal_entry_id=corrected-1',
    ])
  })
})
