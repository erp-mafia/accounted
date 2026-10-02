/**
 * Banklista: the payee lines buildSalaryPaymentFile() returns beside the file.
 * The generators are real, so every assertion here reads the file itself back
 * and checks the list against it: same payments, same order, same amounts,
 * same references, and a total equal to the file's control sum.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildSalaryPaymentFile } from '../build-payment-file'
import { buildSalaryBankList, salaryBankListFileName } from '../bank-list'

const COMPANY_ID = 'company-1'
const RUN_ID = 'run-1'
const USER_ID = 'user-1'

const run = { id: RUN_ID, status: 'approved', period_year: 2026, period_month: 4, payment_date: '2026-04-24' }
const company = { name: 'Testbolaget AB', org_number: '556000-0000' }
const settings = {
  company_name: 'Testbolaget AB',
  iban: 'SE4550000000058398257466',
  bic: 'HANDSESS',
  clearing_number: '6000',
  bank_name: null,
  bankgiro: '5050-1055',
  preferred_payment_format: 'pain001',
}

function employee(
  id: string,
  first: string,
  net: number,
  bank: { clearing: string; account: string },
  spec: number,
  taxOverride: number | null = null,
) {
  return {
    employee_id: id,
    net_salary: net,
    tax_withheld: 6000,
    tax_withheld_override: taxOverride,
    employee: {
      first_name: first,
      last_name: 'Test',
      clearing_number: bank.clearing,
      bank_account_number: bank.account,
      specification_number: spec,
    },
  }
}

// Three payees, one with a manual tax override (payout shifts by the
// difference), one on a 5-digit Swedbank clearing, and one at zero net that
// must stay out of both the file and the list.
const rows = [
  employee('emp-1', 'Anna', 20000.5, { clearing: '6000', account: '123456789' }, 1),
  employee('emp-2', 'Bo', 18250.25, { clearing: '83279', account: '1234567890' }, 2, 5500),
  employee('emp-3', 'Cia', 0, { clearing: '', account: '' }, 3),
]

function client() {
  const mock = createQueuedMockSupabase()
  return { ...mock, supabase: mock.supabase as unknown as Parameters<typeof buildSalaryPaymentFile>[0] }
}

async function build(format: 'pain001' | 'bg_lb', dryRun = true) {
  const { supabase, enqueueMany } = client()
  enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: rows }, { data: null }, { data: null }])
  const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format, dryRun })
  if (!result.ok) throw new Error(`expected a file, got ${result.code}`)
  return result
}

function sum(amounts: number[]): number {
  return Math.round(amounts.reduce((s, a) => s + a, 0) * 100) / 100
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('bank list: pain.001', () => {
  it('lists exactly the credit transfers in the file, in file order, with their EndToEndId and amount', async () => {
    const file = await build('pain001')
    const txs = [...file.content.matchAll(/<EndToEndId>([^<]+)<\/EndToEndId>[\s\S]*?<InstdAmt Ccy="SEK">([\d.]+)<\/InstdAmt>/g)].map(
      (m) => ({ reference: m[1], amount: Number(m[2]) }),
    )
    expect(txs).toHaveLength(2)
    expect(file.payees.map((p) => ({ reference: p.reference, amount: p.amount }))).toEqual(txs)
    expect(file.payees.map((p) => p.name)).toEqual(['Anna Test', 'Bo Test'])
    // The override lowers tax by 500, so Bo is paid 500 more than net_salary.
    expect(file.payees[1].amount).toBe(18750.25)
  })

  it('has a total equal to the file control sum and to the sum of its lines', async () => {
    const file = await build('pain001')
    const ctrlSums = [...file.content.matchAll(/<CtrlSum>([\d.]+)<\/CtrlSum>/g)].map((m) => Number(m[1]))
    expect(ctrlSums).toEqual([file.totalAmount, file.totalAmount])
    expect(file.totalAmount).toBe(sum(file.payees.map((p) => p.amount)))
    expect(file.totalAmount).toBe(38750.75)
    expect(file.employeeCount).toBe(file.payees.length)
  })

  it('names the payer as the file does', async () => {
    const file = await build('pain001')
    expect(file.payer).toEqual({ name: 'Testbolaget AB', orgNumber: '556000-0000', account: 'SE4550000000058398257466' })
    expect(file.content).toContain(`<IBAN>${file.payer.account}</IBAN>`)
  })
})

describe('bank list: Bankgirot LB', () => {
  it('lists exactly the TK14 payments in the file, with the utbetalningsnummer of their TK40/TK14 pair', async () => {
    const file = await build('bg_lb')
    const records = file.content.split('\r\n').filter(Boolean)
    const payments = records
      .filter((r) => r.startsWith('14'))
      .map((r) => ({ reference: r.slice(2, 12).replace(/^0+/, ''), amount: Number(r.slice(37, 49)) / 100 }))
    const accountRecords = records.filter((r) => r.startsWith('40')).map((r) => r.slice(6, 12))
    expect(payments).toHaveLength(2)
    expect(file.payees.map((p) => ({ reference: p.reference.replace(/^0+/, ''), amount: p.amount }))).toEqual(payments)
    expect(file.payees.map((p) => p.reference)).toEqual(accountRecords)
  })

  it('has a total equal to the TK29 total and payment count', async () => {
    const file = await build('bg_lb')
    const tk29 = file.content.split('\r\n').find((r) => r.startsWith('29')) as string
    expect(Number(tk29.slice(12, 20))).toBe(file.payees.length)
    expect(Number(tk29.slice(20, 32)) / 100).toBe(file.totalAmount)
    expect(file.totalAmount).toBe(sum(file.payees.map((p) => p.amount)))
  })

  it('names the sender bankgiro as the payer account', async () => {
    const file = await build('bg_lb')
    expect(file.payer.account).toBe('5050-1055')
  })
})

describe('bank list: masking and the live call', () => {
  it('masks every account to the clearing and the last four digits', async () => {
    const file = await build('pain001')
    expect(file.payees.map((p) => p.maskedAccount)).toEqual(['6000-****6789', '83279-****7890'])
    for (const p of file.payees) {
      expect(p.maskedAccount).not.toContain('123456789')
      expect(p.maskedAccount).not.toContain('1234567890')
    }
  })

  it('carries the same lines on the live (archived) call as on the dry run', async () => {
    const dry = await build('pain001', true)
    const live = await build('pain001', false)
    expect(live.paymentFileId).not.toBeNull()
    expect(live.payees).toEqual(dry.payees)
    expect(live.totalAmount).toBe(dry.totalAmount)
  })
})

describe('buildSalaryBankList', () => {
  it('is the builder dry run without the file: nothing archived, nothing stamped', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: rows }])
    const result = await buildSalaryBankList(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.list).not.toHaveProperty('content')
    expect(result.list.format).toBe('bg_lb')
    expect(result.list.payees).toHaveLength(2)
    expect(calls.some((c) => c.method === 'insert' || c.method === 'update')).toBe(false)
    expect(salaryBankListFileName(result.list)).toBe('banklista_lon_2026-04_bg_lb.pdf')
  })

  it('passes a builder refusal through unchanged', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: { ...run, status: 'draft' } }])
    const result = await buildSalaryBankList(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID })
    expect(result).toMatchObject({ ok: false, code: 'RUN_NOT_READY' })
  })
})
