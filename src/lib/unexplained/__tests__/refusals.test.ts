/**
 * Failing loudly: a check that cannot run answers cannot_check with a typed
 * reason and a Swedish sentence, never ok and never a zero. The doors refuse
 * only what the caller sent wrong.
 */
import { describe, expect, it } from 'vitest'
import { createFakeLedger, type FakeFailures } from '@/lib/measures/__tests__/fake-ledger'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { CHECK_ID_LIST } from '@/lib/operations/unexplained'
import { CHECK_DEFINITIONS, explainUnexplained, getUnexplainedCheck, listUnexplained } from '../registry'
import { CHECK_IDS, type CheckId } from '../types'
import { CA_1930, CO, TODAY, checkFixture, skvRow, type CheckFixtureOptions } from './fixtures'

function ctxFor(options: CheckFixtureOptions = {}, failures: FakeFailures = {}, patch?: (d: ReturnType<typeof checkFixture>) => void) {
  const data = checkFixture(options)
  patch?.(data)
  return { supabase: createFakeLedger(data, failures).supabase, companyId: CO }
}

async function results(ctx: ReturnType<typeof ctxFor>, id: CheckId, today = TODAY) {
  const outcome = await getUnexplainedCheck(ctx, id, { today })
  if (!outcome.ok) throw new Error(outcome.code)
  for (const r of outcome.data.results) {
    if (r.status === 'cannot_check') {
      expect(r.difference).toBeNull()
      expect(r.refusal!.message_sv.length).toBeGreaterThan(20)
      expect(r.refusal!.message_en.length).toBeGreaterThan(20)
      expect(r.summary_sv).toBe(r.refusal!.message_sv)
    }
  }
  return outcome.data
}

describe('cannot_check, never ok', () => {
  it('kontantmetoden: the reskontra checks do not run during the year', async () => {
    const ctx = ctxFor({ accountingMethod: 'cash' })
    for (const id of ['receivables_vs_ledger', 'payables_vs_ledger'] as const) {
      const data = await results(ctx, id)
      expect(data.status).toBe('cannot_check')
      expect(data.results[0].refusal).toMatchObject({ code: 'CASH_METHOD' })
      expect(data.results[0].refusal!.message_sv).toContain('kontantmetoden')
    }
  })

  it('a country whose pack has no account for the role is refused, never read off BAS', async () => {
    const ctx = ctxFor({ jurisdiction: 'NO' })
    for (const id of ['receivables_vs_ledger', 'payables_vs_ledger'] as const) {
      const r = (await results(ctx, id)).results[0]
      expect(r.refusal).toMatchObject({ code: 'ACCOUNT_ROLE_UNAVAILABLE', details: { jurisdiction: 'NO' } })
    }
  })

  it('no fiscal period covering today', async () => {
    const r = (await results(ctxFor(), 'receivables_vs_ledger', '2027-02-01')).results[0]
    expect(r.refusal).toMatchObject({ code: 'NO_FISCAL_PERIOD', details: { date: '2027-02-01' } })
  })

  it('a foreign-currency invoice without a rate makes the register incomplete', async () => {
    const base = checkFixture().invoices!
    const ctx = ctxFor({ invoices: [...base, { ...base[1], id: 'a1000000-0000-4000-8000-000000000009', invoice_number: '1009', currency: 'EUR', exchange_rate: null }] })
    const r = (await results(ctx, 'receivables_vs_ledger')).results[0]
    expect(r.refusal).toMatchObject({ code: 'FX_RATE_MISSING', details: { unconverted_fx_count: 1 } })
    expect(r.sides.map((s) => s.key)).toEqual(['register', 'ledger'])
  })

  it('a bank account in another currency, or sharing its ledger account, is not compared', async () => {
    const foreign = ctxFor({}, {}, (d) => {
      d.cashAccounts = d.cashAccounts!.map((a) => (a.id === CA_1930 ? { ...a, currency: 'EUR' } : a))
    })
    const fx = (await results(foreign, 'bank_balance_vs_bank')).results.find((r) => r.subject.kind === 'bank_account' && r.subject.cash_account_id === CA_1930)!
    expect(fx.refusal).toMatchObject({ code: 'FOREIGN_CURRENCY_ACCOUNT', details: { currency: 'EUR', ledger_currency: 'SEK' } })

    const shared = ctxFor({}, {}, (d) => {
      d.cashAccounts = d.cashAccounts!.map((a) => (a.ledger_account === '1940' ? { ...a, ledger_account: '1930' } : a))
    })
    const rows = (await results(shared, 'bank_balance_vs_bank')).results.filter((r) => r.subject.kind === 'bank_account')
    expect(rows.map((r) => r.refusal?.code)).toEqual(['SHARED_LEDGER_ACCOUNT', 'SHARED_LEDGER_ACCOUNT'])
  })

  it('a company without bank accounts in the register', async () => {
    const ctx = ctxFor({}, {}, (d) => {
      d.cashAccounts = []
    })
    const data = await results(ctx, 'bank_balance_vs_bank')
    expect(data.results).toEqual([expect.objectContaining({ status: 'cannot_check', subject: { kind: 'company' }, refusal: expect.objectContaining({ code: 'NO_BANK_BALANCE' }) })])
  })

  it('the skattekonto without a connection, or without a fetched saldo', async () => {
    expect((await results(ctxFor(), 'skattekonto_vs_skatteverket')).results[0].refusal).toMatchObject({ code: 'SKATTEKONTO_NOT_CONNECTED' })
    const noSaldo = ctxFor({ skvRows: [skvRow()] })
    expect((await results(noSaldo, 'skattekonto_vs_skatteverket')).results[0].refusal).toMatchObject({ code: 'NO_SKATTEVERKET_BALANCE' })
  })

  it('VAT: not registered, or nothing recorded as declared', async () => {
    expect((await results(ctxFor({ vatRegistered: false }), 'vat_declared_not_settled')).results[0].refusal).toMatchObject({ code: 'NOT_VAT_REGISTERED' })
    expect((await results(ctxFor({ declared: [] }), 'vat_declared_not_settled')).results[0].refusal).toMatchObject({ code: 'NO_DECLARED_PERIODS' })
  })

  it('an unreadable source is SOURCE_FAILED, retryable only when transient', async () => {
    // The kundreskontra reads its population in one call (get_ar_ledger_invoices).
    const permanent = ctxFor({}, { rpcs: { get_ar_ledger_invoices: { message: 'permission denied for table invoices', code: '42501' } } })
    const r = (await results(permanent, 'receivables_vs_ledger')).results[0]
    expect(r.refusal).toMatchObject({ code: 'SOURCE_FAILED', retryable: false })

    const transient = ctxFor({}, { tables: { open_bank_rows: { message: 'canceling statement due to statement timeout', code: '57014' } } })
    const t = (await results(transient, 'unbooked_bank_lines_overdue')).results[0]
    expect(t.refusal).toMatchObject({ code: 'SOURCE_FAILED', retryable: true })
  })

  it('the queue keeps running when one check fails, and counts the failure as cannot_check', async () => {
    const ctx = ctxFor({}, { tables: { deadlines: { message: 'relation does not exist', code: '42P01' } } })
    const list = await listUnexplained(ctx, { today: TODAY })
    const vat = list.items.find((r) => r.check_id === 'vat_declared_not_settled')!
    expect(vat).toMatchObject({ status: 'cannot_check', refusal_code: 'SOURCE_FAILED', difference: null })
    expect(list.items.some((r) => r.check_id === 'receivables_vs_ledger' && r.status === 'unexplained')).toBe(true)
  })
})

describe('what the caller sent wrong', () => {
  async function refusal(promise: ReturnType<typeof explainUnexplained>) {
    const outcome = await promise
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(getErrorEntry(outcome.code)?.thrown_message_sv).toBe(true)
    expect(outcome.messageSv.length).toBeGreaterThan(10)
    return outcome
  }

  it('an unknown check lists the valid ids', async () => {
    const outcome = await getUnexplainedCheck(ctxFor(), 'bank', { today: TODAY })
    expect(outcome.ok === false && outcome.code).toBe('UNEXPLAINED_CHECK_NOT_FOUND')
    expect(outcome.ok === false && outcome.details.valid).toEqual([...CHECK_IDS])
    const r = await refusal(explainUnexplained(ctxFor(), 'bank', {}, {}, { today: TODAY }))
    expect(r.code).toBe('UNEXPLAINED_CHECK_NOT_FOUND')
  })

  it('a subject parameter a company-wide check does not take is refused, not ignored', async () => {
    const r = await refusal(explainUnexplained(ctxFor(), 'receivables_vs_ledger', { cash_account_id: CA_1930 }, {}, { today: TODAY }))
    expect(r).toMatchObject({ code: 'UNEXPLAINED_PARAMETER_NOT_ACCEPTED', details: { refused: ['cash_account_id'] } })
  })

  it('a check with several results asks which one', async () => {
    const r = await refusal(explainUnexplained(ctxFor(), 'bank_balance_vs_bank', {}, {}, { today: TODAY }))
    expect(r.code).toBe('UNEXPLAINED_SUBJECT_REQUIRED')
    expect(r.details.subjects).toEqual([{ cash_account_id: CA_1930 }, { cash_account_id: 'ca000000-0000-4000-8000-000000000002' }])
  })

  it('a subject the check has no result for', async () => {
    const r = await refusal(explainUnexplained(ctxFor(), 'vat_declared_not_settled', { period_type: 'quarterly', year: 2026, period: 3 }, {}, { today: TODAY }))
    expect(r.code).toBe('UNEXPLAINED_SUBJECT_NOT_FOUND')
  })

  it('explaining a cannot_check result answers its refusal, not an error', async () => {
    const outcome = await explainUnexplained(ctxFor({ accountingMethod: 'cash' }), 'receivables_vs_ledger', {}, {}, { today: TODAY })
    expect(outcome.ok && outcome.data).toMatchObject({ status: 'cannot_check', refusal: { code: 'CASH_METHOD' }, parts: [], items: { total: 0 } })
  })
})

describe('the registry', () => {
  it('defines every check with a definition, a basis, what it compares and a fix', () => {
    expect(CHECK_DEFINITIONS.map((c) => c.id)).toEqual([...CHECK_IDS])
    for (const c of CHECK_DEFINITIONS) {
      expect(c.definition.length, c.id).toBeGreaterThan(150)
      expect(c.definition_sv.length, c.id).toBeGreaterThan(120)
      expect(c.basis.length, c.id).toBeGreaterThan(80)
      expect(c.compares.length, c.id).toBeGreaterThan(0)
      for (const s of c.compares) expect(s.mcp_tool, c.id).toMatch(/^gnubok_/)
      expect(c.next_action.tool, c.id).toMatch(/^gnubok_/)
      expect(c.next_action.message_sv, c.id).not.toMatch(/^Att /)
      expect(`${c.definition}${c.definition_sv}${c.basis}${c.name_sv}${c.next_action.message_sv}`, c.id).not.toMatch(/[–—]/)
    }
  })

  it('keeps the id list the operations document in step with the registry', () => {
    expect(CHECK_ID_LIST).toBe(CHECK_IDS.join(', '))
  })
})
