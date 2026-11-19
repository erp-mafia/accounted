import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { effectiveNetPayout } from '../effective-net'
import {
  loadCorrectionPaidBefore,
  overpaidEmployees,
  overpaidSentenceSv,
  paidBeforeFromChain,
  payableAmount,
  type CorrectionPaidBefore,
} from '../payable'

const COMPANY = 'company-1'

function row(employee_id: string, net: number, name = employee_id, tax = 0, override: number | null = null) {
  return { employee_id, name, net_salary: net, tax_withheld: tax, tax_withheld_override: override }
}

function chainOf(...runs: Array<Array<ReturnType<typeof row>>>): CorrectionPaidBefore {
  return { correctsRunId: 'run-0', chainRunIds: runs.map((_, i) => `run-${i}`), byEmployee: paidBeforeFromChain(runs.flat()) }
}

describe('payableAmount', () => {
  it('pays an ordinary run its effective net, the figure every payment path wrote before', () => {
    // Every pair of whole-öre net and tax override the old formula saw: the
    // rule must give the same number, byte for byte.
    const samples: Array<[number, number, number | null]> = [
      [28291, 6709, null],
      [27866, 7134, 7000],
      [0, 0, null],
      [12345.67, 3456.78, 3000.01],
      [10.07, 0.01, 0.02],
      [-150.5, 0, null],
    ]
    for (const [net, tax, override] of samples) {
      const input = { net_salary: net, tax_withheld: tax, tax_withheld_override: override }
      const before = Math.round(effectiveNetPayout(input) * 100) / 100
      expect(payableAmount(input, 'e', null)).toBe(before)
    }
  })

  it('pays a correction the difference against what the corrected run paid', () => {
    const paid = chainOf([row('anna', 28291)])
    expect(payableAmount(row('anna', 29291.5), 'anna', paid)).toBe(1000.5)
    // Unchanged: nothing to pay.
    expect(payableAmount(row('anna', 28291), 'anna', paid)).toBe(0)
    // Lower: an overpayment, negative.
    expect(payableAmount(row('anna', 27000), 'anna', paid)).toBe(-1291)
  })

  it('reads the effective net on both sides, a tax override included', () => {
    // Original paid 27 866 + (7 134 - 7 000) = 28 000; the correction drops the override.
    const paid = chainOf([row('bertil', 27866, 'Bertil', 7134, 7000)])
    expect(payableAmount(row('bertil', 28500, 'Bertil', 7134, null), 'bertil', paid)).toBe(500)
  })

  it('pays an employee new on the correction the full net', () => {
    const paid = chainOf([row('anna', 28291)])
    expect(payableAmount(row('david', 21000), 'david', paid)).toBe(21000)
  })

  it('over a chain of two corrections pays only what neither earlier run paid', () => {
    // R0 paid 30 000; C1 raised it to 31 000 (paid 1 000); C2 is 31 500.
    const paid = chainOf([row('anna', 31000)], [row('anna', 30000)])
    expect(payableAmount(row('anna', 31500), 'anna', paid)).toBe(500)
  })

  it('never pays back what an earlier correction lowered: the employee still holds the higher amount', () => {
    // R0 paid 30 000; C1 lowered it to 29 000 and paid nothing back; C2 is 30 000 again.
    const paid = chainOf([row('anna', 29000)], [row('anna', 30000)])
    expect(payableAmount(row('anna', 30000), 'anna', paid)).toBe(0)
    expect(payableAmount(row('anna', 30200), 'anna', paid)).toBe(200)
  })
})

describe('paidBeforeFromChain', () => {
  it('takes the largest effective net per employee, never below zero', () => {
    const paid = paidBeforeFromChain([row('anna', 100, 'Anna'), row('anna', 300, 'Anna'), row('anna', 200, 'Anna'), row('cecilia', -50, 'Cecilia')])
    expect(Object.fromEntries(paid)).toEqual({
      anna: { amount: 300, name: 'Anna' },
      cecilia: { amount: 0, name: 'Cecilia' },
    })
  })
})

describe('overpaidEmployees', () => {
  it('is empty for an ordinary run', () => {
    expect(overpaidEmployees([row('anna', -10)], null)).toEqual([])
  })

  it('names an employee whose corrected net is lower and one removed from the correction, by name', () => {
    const paid = chainOf([row('anna', 28291, 'Anna Andersson'), row('bertil', 28000, 'Bertil Berg'), row('cecilia', 0, 'Cecilia Ceder')])
    const onCorrection = [row('anna', 27000.25, 'Anna Andersson'), row('david', 100, 'David Dahl')]
    expect(overpaidEmployees(onCorrection, paid)).toEqual([
      { employee_id: 'anna', name: 'Anna Andersson', amount: 1290.75 },
      // Removed: everything paid before was too much. Cecilia was paid nothing.
      { employee_id: 'bertil', name: 'Bertil Berg', amount: 28000 },
    ])
  })
})

describe('overpaidSentenceSv', () => {
  it('names every overpaid employee and amount in one sentence and claims nothing about deducting it', () => {
    const sentence = overpaidSentenceSv(
      [
        { employee_id: 'anna', name: 'Anna Andersson', amount: 1290.75 },
        { employee_id: 'bertil', name: 'Bertil Berg', amount: 300 },
      ],
      (amount) => `${amount} kr`,
    )
    expect(sentence).toBe(
      'Enligt rättelsen har Anna Andersson (1290.75 kr), Bertil Berg (300 kr) fått för mycket utbetalt; det ingår inte i betalningen och dras inte av automatiskt, så hantera det separat.',
    )
    expect(overpaidSentenceSv([], String)).toBeNull()
  })
})

describe('loadCorrectionPaidBefore', () => {
  it('reads nothing for an ordinary run', async () => {
    const db = createTableMockSupabase({})
    expect(await loadCorrectionPaidBefore(db.supabase as never, COMPANY, { id: 'run-1', corrects_run_id: null })).toEqual({
      ok: true,
      paidBefore: null,
    })
    expect(db.tables()).toEqual([])
  })

  it('walks the chain up to the first ordinary run and reads every roster of it, company-scoped', async () => {
    const runs: Record<string, string | null> = { 'run-c1': 'run-0', 'run-0': null }
    const db = createTableMockSupabase({
      salary_runs: (calls) => {
        const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1] as string
        return { data: id in runs ? { id, corrects_run_id: runs[id] } : null }
      },
      salary_run_employees: {
        data: [
          { id: 'sre-1', employee_id: 'anna', net_salary: '30000.00', tax_withheld: '9000.00', tax_withheld_override: null, employee: { first_name: 'Anna', last_name: 'Andersson' } },
          { id: 'sre-2', employee_id: 'anna', net_salary: '31000.00', tax_withheld: '9500.00', tax_withheld_override: null, employee: { first_name: 'Anna', last_name: 'Andersson' } },
          { id: 'sre-3', employee_id: 'bertil', net_salary: '20000.00', tax_withheld: '5000.00', tax_withheld_override: '4000.00', employee: { first_name: 'Bertil', last_name: 'Berg' } },
        ],
      },
    })
    const result = await loadCorrectionPaidBefore(db.supabase as never, COMPANY, { id: 'run-c2', corrects_run_id: 'run-c1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paidBefore?.correctsRunId).toBe('run-c1')
    expect(result.paidBefore?.chainRunIds).toEqual(['run-c1', 'run-0'])
    expect(Object.fromEntries(result.paidBefore!.byEmployee)).toEqual({
      anna: { amount: 31000, name: 'Anna Andersson' },
      bertil: { amount: 21000, name: 'Bertil Berg' },
    })
    expect(db.findCalls('salary_runs', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(db.findCall('salary_run_employees', 'in')).toEqual(['salary_run_id', ['run-c1', 'run-0']])
    expect(db.findCalls('salary_run_employees', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('refuses rather than guesses when the corrected run cannot be read, or the chain loops', async () => {
    const missing = createTableMockSupabase({ salary_runs: { data: null } })
    expect((await loadCorrectionPaidBefore(missing.supabase as never, COMPANY, { id: 'run-c1', corrects_run_id: 'run-0' })).ok).toBe(false)

    const loop = createTableMockSupabase({
      salary_runs: (calls) => {
        const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1] as string
        return { data: { id, corrects_run_id: id === 'run-a' ? 'run-b' : 'run-a' } }
      },
    })
    expect((await loadCorrectionPaidBefore(loop.supabase as never, COMPANY, { id: 'run-c', corrects_run_id: 'run-a' })).ok).toBe(false)

    const failing = createTableMockSupabase({
      salary_runs: { data: { id: 'run-0', corrects_run_id: null } },
      salary_run_employees: { data: null, error: { message: 'timeout', code: '57014' } },
    })
    expect((await loadCorrectionPaidBefore(failing.supabase as never, COMPANY, { id: 'run-c1', corrects_run_id: 'run-0' })).ok).toBe(false)
  })
})
