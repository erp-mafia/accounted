/**
 * Every check, ok and unexplained, on the in-memory company of the measure
 * tests (lib/measures/__tests__/fake-ledger.ts). The check and the report it
 * reads run against ONE database and neither is mocked: each case also
 * reads the report a person sees and asserts the check's difference is that
 * report's figure. A check without an ok and an unexplained case here fails
 * the coverage test at the bottom.
 */
import { describe, expect, it } from 'vitest'
import { createFakeLedger } from '@/lib/measures/__tests__/fake-ledger'
import { generateARReconciliation } from '@/lib/reports/ar-reconciliation'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateReconciliation as generateSupplierReconciliation } from '@/lib/reports/supplier-reconciliation'
import { buildVatSettlementProposal } from '@/lib/reports/vat-settlement'
import { getSkattekontoReconciliationStatus } from '@/lib/reconciliation/skattekonto-reconciliation'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import { explainUnexplained, getUnexplainedCheck, listUnexplained, REGISTERED_CHECK_IDS } from '../registry'
import { overdueCutoff, bookingDeadline } from '../checks/unbooked-bank'
import type { CheckId, CheckStatus } from '../types'
import {
  CA_1930,
  CA_1940,
  CO,
  FP,
  MANUAL_AP,
  MANUAL_AR,
  MANUAL_PAYABLE,
  MANUAL_RECEIVABLE,
  SKV_ROW2,
  TODAY,
  TXN1,
  checkFixture,
  skvRow,
  unbookedRow,
  withCarriedForwardIb,
  type CheckFixtureOptions,
} from './fixtures'

const seen = new Map<CheckId, Set<CheckStatus>>()

function ledger(options: CheckFixtureOptions = {}) {
  return createFakeLedger(checkFixture(options))
}

async function check(l: ReturnType<typeof ledger>, id: CheckId) {
  const outcome = await getUnexplainedCheck({ supabase: l.supabase, companyId: CO }, id, { today: TODAY })
  if (!outcome.ok) throw new Error(`${id} refused: ${outcome.code}`)
  for (const r of outcome.data.results) {
    const set = seen.get(id) ?? new Set()
    set.add(r.status)
    seen.set(id, set)
  }
  return outcome.data
}

async function explain(l: ReturnType<typeof ledger>, id: CheckId, params = {}) {
  const outcome = await explainUnexplained({ supabase: l.supabase, companyId: CO }, id, params, { limit: 200 }, { today: TODAY })
  if (!outcome.ok) throw new Error(`${id} explain refused: ${outcome.code}`)
  return outcome.data
}

describe('receivables_vs_ledger equals the kundreskontra reconciliation', () => {
  it('ok when every open invoice is booked', async () => {
    const l = ledger({
      invoices: checkFixture().invoices!.filter((inv) => inv.invoice_number === '1001'),
    })
    const result = (await check(l, 'receivables_vs_ledger')).results[0]
    const card = await generateARReconciliation(l.supabase, CO, FP)
    expect(result).toMatchObject({ status: 'ok', difference: card.difference, as_of: TODAY })
    expect(card.difference).toBe(0)
    expect(result.sides.map((s) => s.amount)).toEqual([12500, 12500])
  })

  it('unexplained by an open invoice without a verifikat, named with its inv_ handle', async () => {
    const l = ledger()
    const result = (await check(l, 'receivables_vs_ledger')).results[0]
    const card = await generateARReconciliation(l.supabase, CO, FP)
    // Register 12 500 + 3 000 open on invoice 1002; 1510: IB 12 000 + 12 500 - 12 000.
    expect(result).toMatchObject({ status: 'unexplained', difference: 3000 })
    expect(result.difference).toBe(card.difference)
    const e = await explain(l, 'receivables_vs_ledger')
    expect(e.parts).toEqual([
      expect.objectContaining({ key: 'register_without_voucher', amount: 3000, count: 1 }),
      expect.objectContaining({ key: 'ledger_without_invoice', amount: 0, count: 0 }),
    ])
    expect(e.items.list[0]).toMatchObject({ item_type: 'invoice', label: 'Faktura 1002, Beta HB', amount: 3000 })
    expect(e.items.list[0].handle).toMatch(/^inv_[0-9a-f]{32}$/)
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })

  it('names a manual verifikat on 1510 that no invoice references', async () => {
    const l = ledger({ extraEntries: [MANUAL_RECEIVABLE] })
    const result = (await check(l, 'receivables_vs_ledger')).results[0]
    expect(result.difference).toBe((await generateARReconciliation(l.supabase, CO, FP)).difference)
    expect(result.difference).toBe(2300)
    const e = await explain(l, 'receivables_vs_ledger')
    const manual = e.items.list.find((i) => i.journal_entry_id === MANUAL_AR)
    expect(manual).toMatchObject({ part: 'ledger_without_invoice', item_type: 'journal_line', account_number: '1510', amount: -700 })
    expect(manual!.handle).toMatch(/^je_[0-9a-f]{32}$/)
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })
})

describe('receivables_vs_ledger: stornos and corrections follow the entry they reverse', () => {
  const E1 = 'e0000000-0000-4000-8000-000000000001'
  const STORNO_INV = 'e0000000-0000-4000-8000-000000000501'
  const CORRECTION_INV = 'e0000000-0000-4000-8000-000000000502'
  const STORNO_MANUAL = 'e0000000-0000-4000-8000-000000000503'

  it('leaves out the storno and the correction of an invoice verifikat', async () => {
    const storno = {
      id: STORNO_INV, entry_date: '2026-02-11', voucher_number: 50, description: 'Storno Faktura 1001', source_type: 'storno',
      fiscal_period_id: FP, reverses_id: E1,
      lines: [{ account_number: '1510', credit: 12500 }, { account_number: '3001', debit: 10000 }, { account_number: '2611', debit: 2500 }],
    }
    const correction = {
      id: CORRECTION_INV, entry_date: '2026-02-11', voucher_number: 51, description: 'Rättelse Faktura 1001', source_type: 'correction',
      fiscal_period_id: FP, correction_of_id: E1,
      lines: [{ account_number: '1510', debit: 12500 }, { account_number: '3001', credit: 10000 }, { account_number: '2611', credit: 2500 }],
    }
    const l = ledger({ extraEntries: [storno, correction] as never })
    const e = await explain(l, 'receivables_vs_ledger')
    expect(e.difference).toBe(3000)
    expect(e.items.list.filter((i) => i.part === 'ledger_without_invoice')).toEqual([])
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })

  it('lists a manual verifikat and its storno as a pair that nets to zero', async () => {
    const storno = {
      id: STORNO_MANUAL, entry_date: '2026-07-03', voucher_number: 52, description: 'Storno Manuell kundfordran', source_type: 'storno',
      fiscal_period_id: FP, reverses_id: MANUAL_AR,
      lines: [{ account_number: '1510', credit: 700 }, { account_number: '3001', debit: 700 }],
    }
    const l = ledger({ extraEntries: [{ ...MANUAL_RECEIVABLE, status: 'reversed' }, storno] as never })
    const e = await explain(l, 'receivables_vs_ledger')
    expect(e.difference).toBe(3000)
    expect(e.items.list.filter((i) => i.part === 'ledger_without_invoice').map((i) => [i.journal_entry_id, i.amount])).toEqual([
      [MANUAL_AR, -700],
      [STORNO_MANUAL, 700],
    ])
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })
})

describe('payables_vs_ledger equals the leverantörsreskontra reconciliation', () => {
  it('ok when the open supplier invoice is booked', async () => {
    const l = ledger()
    const result = (await check(l, 'payables_vs_ledger')).results[0]
    const card = await generateSupplierReconciliation(l.supabase, CO, FP)
    expect(result).toMatchObject({ status: 'ok', difference: card.difference })
    expect(result.sides.map((s) => s.amount)).toEqual([10000, 10000])
  })

  it('unexplained by a manual credit on 2440, signed as it moves the difference', async () => {
    const l = ledger({ extraEntries: [MANUAL_PAYABLE] })
    const result = (await check(l, 'payables_vs_ledger')).results[0]
    expect(result.difference).toBe((await generateSupplierReconciliation(l.supabase, CO, FP)).difference)
    expect(result).toMatchObject({ status: 'unexplained', difference: -1500 })
    const e = await explain(l, 'payables_vs_ledger')
    expect(e.items.list).toEqual([
      expect.objectContaining({ journal_entry_id: MANUAL_AP, part: 'ledger_without_invoice', amount: -1500 }),
    ])
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })
})

describe('the reskontra checks read the control account as the balance sheet does, opening balance included (crm#1296)', () => {
  async function booked(l: ReturnType<typeof ledger>, account: string) {
    const bs = await generateBalanceSheet(l.supabase, CO, FP)
    return [...bs.asset_sections, ...bs.equity_liability_sections].flatMap((s) => s.rows).find((r) => r.account_number === account)!.amount
  }

  it('an IB carried from earlier years\' verifikat (no IB verifikat) is in the ledger side', async () => {
    // Without the carried IB the year's 1510 lines alone net to 500 and the
    // check showed the omitted 12 000 IB as a 15 000 difference.
    const l = createFakeLedger(withCarriedForwardIb(checkFixture()))
    const result = (await check(l, 'receivables_vs_ledger')).results[0]
    expect(result.sides.map((s) => s.amount)).toEqual([15500, 12500])
    expect(result.sides[1].amount).toBe(await booked(l, '1510'))
    expect(result).toMatchObject({ status: 'unexplained', difference: 3000 })
    const e = await explain(l, 'receivables_vs_ledger')
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })

  it('the same for payables: the carried 2440 IB is booked, the register ties out', async () => {
    const l = createFakeLedger(withCarriedForwardIb(checkFixture()))
    const result = (await check(l, 'payables_vs_ledger')).results[0]
    expect(result).toMatchObject({ status: 'ok', difference: 0 })
    expect(result.sides.map((s) => s.amount)).toEqual([10000, 10000])
    expect(result.sides[1].amount).toBe(await booked(l, '2440'))
  })

  it('a linked IB verifikat in the year counts once', async () => {
    // Base fixture: the IB verifikat sits in the year and is the period's
    // opening_balance_entry_id: 1510 = IB 12 000 + 12 500 - 12 000, not 24 500.
    const l = ledger()
    const card = await generateARReconciliation(l.supabase, CO, FP)
    expect(card.account_1510_balance).toBe(12500)
    expect(card.account_1510_balance).toBe(await booked(l, '1510'))
    const ap = await generateSupplierReconciliation(l.supabase, CO, FP)
    expect(ap.account_2440_balance).toBe(10000)
  })
})

describe('bank_balance_vs_bank equals the bank balance minus the balance sheet row that day', () => {
  async function bankRow(l: ReturnType<typeof ledger>) {
    const data = await check(l, 'bank_balance_vs_bank')
    return data.results.find((r) => r.subject.kind === 'bank_account' && r.subject.cash_account_id === CA_1930)!
  }

  it('ok when the books hold what the bank reported', async () => {
    const l = ledger()
    const row = await bankRow(l)
    const bs = await generateBalanceSheet(l.supabase, CO, FP, { toDate: '2026-06-30' })
    const booked = [...bs.asset_sections].flatMap((s) => s.rows).find((r) => r.account_number === '1930')!.amount
    expect(row).toMatchObject({ status: 'ok', difference: 0, as_of: '2026-06-30' })
    expect(row.sides.map((s) => s.amount)).toEqual([55350, booked])
  })

  it('unexplained by an unbooked bank row, named with its txn_ handle', async () => {
    const l = ledger({ bankBalance: { amount: 56350, at: '2026-06-30T10:00:00.000Z' }, transactions: [unbookedRow()] })
    const row = await bankRow(l)
    expect(row).toMatchObject({ status: 'unexplained', difference: 1000 })
    const e = await explain(l, 'bank_balance_vs_bank', { cash_account_id: CA_1930 })
    expect(e.items.list).toEqual([
      expect.objectContaining({ item_type: 'transaction', transaction_id: TXN1, amount: 1000, date: '2026-06-29' }),
    ])
    expect(e.items.list[0].handle).toMatch(/^txn_[0-9a-f]{32}$/)
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })

  it('leaves a residual when the difference is not an unbooked row', async () => {
    const l = ledger({ bankBalance: { amount: 55000, at: '2026-06-30T10:00:00.000Z' } })
    const e = await explain(l, 'bank_balance_vs_bank', { cash_account_id: CA_1930 })
    expect(e).toMatchObject({ difference: -350, residual: -350, reconciles: false })
    expect(e.note).toContain(`bank:${CA_1930}`)
  })

  it('cannot check an account the bank reported no balance for, nor a payment-provider account', async () => {
    const data = await check(ledger(), 'bank_balance_vs_bank')
    const savings = data.results.find((r) => r.subject.kind === 'bank_account' && r.subject.cash_account_id === CA_1940)!
    expect(savings).toMatchObject({ status: 'cannot_check', difference: null, refusal: { code: 'NO_BANK_BALANCE' } })
    expect(data.results).toHaveLength(2)
    expect(data.status).toBe('cannot_check')
  })
})

describe('skattekonto_vs_skatteverket equals the skattekonto reconciliation', () => {
  it('ok when every Skatteverket event is booked', async () => {
    const l = ledger({ skvSaldo: { amount: 5000, at: '2026-06-30T08:00:00.000Z' } })
    const result = (await check(l, 'skattekonto_vs_skatteverket')).results[0]
    const status = await getSkattekontoReconciliationStatus(l.supabase, CO, { today: TODAY })
    expect(result).toMatchObject({ status: 'ok', difference: status!.difference, as_of: '2026-06-30' })
    expect(result.sides.map((s) => s.amount)).toEqual([5000, 5000])
  })

  it('unexplained by a Skatteverket event missing from the books', async () => {
    const l = ledger({
      skvSaldo: { amount: 4988, at: '2026-06-30T08:00:00.000Z' },
      skvRows: [skvRow(), skvRow({ id: SKV_ROW2, transaktionsdatum: '2026-06-01', transaktionstext: 'Kostnadsränta', belopp_skatteverket: -12, journal_entry_id: null })],
    })
    const result = (await check(l, 'skattekonto_vs_skatteverket')).results[0]
    const status = await getSkattekontoReconciliationStatus(l.supabase, CO, { today: TODAY })
    expect(result).toMatchObject({ status: 'unexplained', difference: -12 })
    expect(result.difference).toBe(status!.difference)
    const e = await explain(l, 'skattekonto_vs_skatteverket')
    expect(e.parts).toContainEqual(expect.objectContaining({ key: 'unmatched_external', amount: -12, count: 1 }))
    expect(e.items.list).toEqual([
      expect.objectContaining({ item_type: 'skattekonto_transaction', skattekonto_transaction_id: SKV_ROW2, amount: -12, handle: null }),
    ])
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })
})

describe('vat_declared_not_settled reads the momsredovisning proposal of each declared period', () => {
  it('ok for a declared period whose settlement is booked; unexplained for one that is not', async () => {
    const l = ledger()
    const data = await check(l, 'vat_declared_not_settled')
    const byLabel = new Map(data.results.map((r) => [r.subject.kind === 'vat_period' ? r.subject.label : '', r]))
    expect(byLabel.get('Kvartal 1 2026')).toMatchObject({ status: 'ok', difference: 0 })
    const q2 = byLabel.get('Kvartal 2 2026')!
    const proposal = await buildVatSettlementProposal(l.supabase, CO, 'quarterly', 2026, 2)
    // Ruta 10 1 250 (the April cash sale) minus ruta 48 100 (office supplies).
    expect(q2).toMatchObject({ status: 'unexplained', difference: proposal.filed_net, as_of: '2026-06-30' })
    expect(q2.difference).toBe(1150)
    expect(q2.next_action).toMatchObject({ tool: 'gnubok_get_vat_settlement_proposal', arguments: { period_type: 'quarterly', year: 2026, period: 2 } })
    const e = await explain(l, 'vat_declared_not_settled', { period_type: 'quarterly', year: 2026, period: 2 })
    expect(e.items.list.map((i) => [i.account_number, i.amount])).toEqual([
      ['2611', 1250],
      ['2641', -100],
    ])
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })
})

describe('vat_declared_not_settled: a momsredovisning dated after the period', () => {
  it('stays unexplained but names the verifikat, so nobody books the period twice', async () => {
    const LATE = 'e0000000-0000-4000-8000-000000000601'
    const late = {
      id: LATE, entry_date: '2026-08-12', voucher_number: 60, description: 'Momsomföring Q2', source_type: 'manual', fiscal_period_id: FP,
      lines: [{ account_number: '2611', debit: 1250 }, { account_number: '2641', credit: 100 }, { account_number: '2650', credit: 1150 }],
    }
    const l = ledger({ extraEntries: [late] })
    const q2 = (await check(l, 'vat_declared_not_settled')).results.find((r) => r.subject.kind === 'vat_period' && r.subject.period === 2)!
    expect(q2).toMatchObject({ status: 'unexplained', difference: 1150 })
    expect(q2.summary_sv).toContain('kontrollera om det är periodens momsredovisning')
    expect(q2.facts).toMatchObject({ possible_late_settlement_handles: [expect.stringMatching(/^je_[0-9a-f]{32}$/)] })
    const e = await explain(l, 'vat_declared_not_settled', { period_type: 'quarterly', year: 2026, period: 2 })
    expect(e.items.list.find((i) => i.part === 'possible_late_settlement')).toMatchObject({ journal_entry_id: LATE, amount: 0, date: '2026-08-12' })
    expect(e.note).toContain('book the period twice')
  })
})

describe('unbooked_bank_lines_overdue counts the unbooked rows past the BFNAR 2013:2 p. 3.6 deadline', () => {
  it('places the cut-off at the last month whose 50th day after month end has passed', () => {
    // July's deadline is 19 September (passed), August's 20 October (not yet).
    expect(overdueCutoff('2026-10-16')).toBe('2026-07-31')
    expect(overdueCutoff('2026-10-21')).toBe('2026-08-31')
    expect(overdueCutoff('2026-10-20')).toBe('2026-07-31')
    expect(bookingDeadline('2026-06-29')).toBe('2026-08-19')
    expect(bookingDeadline('2026-02-10')).toBe('2026-04-19')
  })

  it('ok with no overdue rows, unexplained with one, equal to the unbooked count', async () => {
    const okLedger = ledger({ transactions: [unbookedRow({ date: '2026-09-01' })] })
    const ok = (await check(okLedger, 'unbooked_bank_lines_overdue')).results[0]
    expect(ok).toMatchObject({ status: 'ok', difference: 0, facts: { cutoff_date: '2026-07-31' } })

    const l = ledger({ transactions: [unbookedRow(), unbookedRow({ id: 'd0000000-0000-4000-8000-000000000002', is_ignored: true })] })
    const result = (await check(l, 'unbooked_bank_lines_overdue')).results[0]
    const counted = await countUnbookedBankTransactions(l.supabase, CO, { toDate: '2026-07-31' })
    expect(result).toMatchObject({ status: 'unexplained', difference: counted.total })
    expect(result.difference).toBe(1)
    const e = await explain(l, 'unbooked_bank_lines_overdue')
    expect(e.items.list).toEqual([
      expect.objectContaining({ transaction_id: TXN1, amount: 1, record_amount: 1000, days_past_deadline: 58 }),
    ])
    expect(e).toMatchObject({ residual: 0, reconciles: true })
  })
})

describe('the queue', () => {
  it('lists unexplained first, then cannot_check, then ok, with an explain handle on every row', async () => {
    const list = await listUnexplained({ supabase: ledger().supabase, companyId: CO }, { today: TODAY })
    const statuses = list.items.map((r) => r.status)
    const firstOk = statuses.indexOf('ok')
    const lastUnexplained = statuses.lastIndexOf('unexplained')
    expect(lastUnexplained).toBeLessThan(statuses.indexOf('cannot_check'))
    expect(statuses.lastIndexOf('cannot_check')).toBeLessThan(firstOk)
    // Base fixture: the AR gap (3 000) before the undeclared Q2 moms (1 150).
    expect(list.items.slice(0, 2).map((r) => [r.check_id, r.difference])).toEqual([
      ['receivables_vs_ledger', 3000],
      ['vat_declared_not_settled', 1150],
    ])
    expect(list.counts).toEqual({ unexplained: 2, cannot_check: 2, ok: 4 })
    for (const row of list.items) {
      expect(row.explain.tool).toBe('gnubok_explain_unexplained')
      expect(row.explain.v1_path).toMatch(new RegExp(`^/api/v1/companies/${CO}/unexplained/${row.check_id}/explain`))
      expect(row.next === null).toBe(row.status !== 'unexplained')
      expect(row.summary_sv).not.toMatch(/[–—]/)
    }
  })
})

describe('coverage', () => {
  it('has an ok and an unexplained case for every registered check', () => {
    // Runs last in the file: every case above has recorded its statuses.
    const missing = REGISTERED_CHECK_IDS.filter((id) => !seen.get(id)?.has('ok') || !seen.get(id)?.has('unexplained'))
    expect(missing).toEqual([])
  })
})
