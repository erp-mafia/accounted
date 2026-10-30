import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const mail = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))

import { allowanceExceededMessage, bankPaymentsAllowanceRefusal, requestMoreBankPayments, swedishMonthName } from '../allowance'
import { createPayrollFakeDb } from '@/lib/salary/__tests__/payroll-fake-db'
import { paymentOrderRow } from './payment-order-row'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'

function sent(n: number, prefix = 's') {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, cash_account_id: 'a1' }))
}

function log() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
}

describe('bankPaymentsAllowanceRefusal', () => {
  it('lets a signing under the cap and one that lands exactly on it through', async () => {
    const under = createTableMockSupabase({ payment_orders: { data: sent(5) } })
    expect(await bankPaymentsAllowanceRefusal(under.supabase as unknown as SupabaseClient, COMPANY, ['n1', 'n2'], '2026-10')).toBeNull()
    const at = createTableMockSupabase({ payment_orders: { data: sent(8) } })
    expect(await bankPaymentsAllowanceRefusal(at.supabase as unknown as SupabaseClient, COMPANY, ['n1', 'n2'], '2026-10')).toBeNull()
  })

  it('refuses a signing that passes the cap, with the numbers and the Swedish sentence', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: sent(9) } })
    const refusal = await bankPaymentsAllowanceRefusal(db.supabase as unknown as SupabaseClient, COMPANY, ['n1', 'n2', 'n2'], '2026-10')
    expect(refusal).toEqual({
      ok: false,
      code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED',
      details: { period: '2026-10', used: 9, included: 10, remaining: 1, requested: 2 },
      messageSv: 'Ni har använt 9 av 10 betalningar som ingår i oktober. Välj högst 1 betalning, eller begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    })
  })

  it('counts an order of this signing that already reached the bank once, as part of the signing (a restart)', async () => {
    // 10 sent this month, two of them the waiting payments being signed again.
    const db = createTableMockSupabase({ payment_orders: { data: [...sent(8), { id: 'w1', cash_account_id: 'a1' }, { id: 'w2', cash_account_id: 'a1' }] } })
    expect(await bankPaymentsAllowanceRefusal(db.supabase as unknown as SupabaseClient, COMPANY, ['w1', 'w2'], '2026-10')).toBeNull()
    const over = createTableMockSupabase({ payment_orders: { data: [...sent(9), { id: 'w1', cash_account_id: 'a1' }, { id: 'w2', cash_account_id: 'a1' }] } })
    expect(await bankPaymentsAllowanceRefusal(over.supabase as unknown as SupabaseClient, COMPANY, ['w1', 'w2'], '2026-10')).toMatchObject({
      code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED',
      details: { used: 9, included: 10, remaining: 1, requested: 2 },
    })
  })

  it('counts the month\'s payments by when they were sent, so drafts from last month do not reopen the cap (#127)', async () => {
    // Ten drafted in October, all sent in November.
    const { supabase } = createPayrollFakeDb({
      payment_orders: Array.from({ length: 10 }, (_, i) =>
        paymentOrderRow(COMPANY, `s${i}`, { created: '2026-10-28T08:00:00.000Z', sent: `2026-11-0${(i % 5) + 1}T09:00:00.000Z` }),
      ),
    })
    expect(await bankPaymentsAllowanceRefusal(supabase, COMPANY, ['n1'], '2026-11')).toMatchObject({
      code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED',
      details: { period: '2026-11', used: 10, included: 10, remaining: 0, requested: 1 },
    })
    // October sent none of them, so it still has room.
    expect(await bankPaymentsAllowanceRefusal(supabase, COMPANY, ['n1'], '2026-10')).toBeNull()
  })

  it('follows the company\'s own allowance, and an allowance of 0 refuses every payment', async () => {
    const raised = createTableMockSupabase({ payment_orders: { data: sent(30) }, company_bank_payment_allowances: { data: { monthly_payments: 40 } } })
    expect(await bankPaymentsAllowanceRefusal(raised.supabase as unknown as SupabaseClient, COMPANY, ['n1'], '2026-10')).toBeNull()
    const stopped = createTableMockSupabase({ payment_orders: { data: [] }, company_bank_payment_allowances: { data: { monthly_payments: 0 } } })
    const refusal = await bankPaymentsAllowanceRefusal(stopped.supabase as unknown as SupabaseClient, COMPANY, ['n1'], '2026-10')
    expect(refusal?.details).toEqual({ period: '2026-10', used: 0, included: 0, remaining: 0, requested: 1 })
  })
})

describe('allowanceExceededMessage', () => {
  it('names the month in Swedish and drops the choice when nothing remains', () => {
    expect(swedishMonthName('2026-01')).toBe('januari')
    expect(swedishMonthName('2026-12')).toBe('december')
    expect(allowanceExceededMessage({ period: '2026-11', used: 10, included: 10, remaining: 0, requested: 3 })).toBe(
      'Ni har använt 10 av 10 betalningar som ingår i november. Begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    )
    expect(allowanceExceededMessage({ period: '2026-10', used: 6, included: 10, remaining: 4, requested: 5 })).toBe(
      'Ni har använt 6 av 10 betalningar som ingår i oktober. Välj högst 4 betalningar, eller begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    )
  })
})

describe('requestMoreBankPayments', () => {
  beforeEach(() => {
    mail.isConfigured.mockReset().mockReturnValue(true)
    mail.sendEmail.mockReset().mockResolvedValue({ success: true, messageId: 'm-1' })
  })

  it('stores the request and mails support with the company, the requester, the month and what is wanted', async () => {
    const db = createTableMockSupabase({
      bank_payment_allowance_requests: [{ data: [] }, { data: { id: 'r-1', created_at: '2026-10-14T10:00:00.000Z' } }],
      payment_orders: { data: sent(10) },
      companies: { data: { name: 'Bygg AB', org_number: '556677-8899' } },
    })
    const result = await requestMoreBankPayments(
      db.supabase as unknown as SupabaseClient,
      { companyId: COMPANY, userId: USER, email: 'anna@bygg.se', log: log() },
      { monthlyPaymentsWanted: 40, message: 'Vi betalar <många> leverantörer' },
      new Date('2026-10-14T10:00:00.000Z'),
    )
    expect(result).toEqual({ ok: true, created: true, data: { request_id: 'r-1', created_at: '2026-10-14T10:00:00.000Z' } })
    expect(db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([
      { company_id: COMPANY, requested_by: USER, monthly_payments_wanted: 40, message: 'Vi betalar <många> leverantörer' },
    ])
    // Only an open request younger than a day stops a new one.
    expect(db.findCall('bank_payment_allowance_requests', 'is')).toEqual(['handled_at', null])
    expect(db.findCall('bank_payment_allowance_requests', 'gte')).toEqual(['created_at', '2026-10-13T10:00:00.000Z'])
    const sentMail = mail.sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string; html: string; replyTo?: string }
    expect(sentMail.replyTo).toBe('anna@bygg.se')
    expect(sentMail.subject).toContain('Bygg AB')
    for (const part of ['Bygg AB', '556677-8899', 'anna@bygg.se', '10 av 10', 'Önskat per månad: 40', 'Vi betalar <många> leverantörer']) {
      expect(sentMail.text).toContain(part)
    }
    expect(sentMail.html).toContain('&lt;många&gt;')
    expect(sentMail.html).not.toContain('<många>')
  })

  it('refuses a second request while an unanswered one is younger than a day, and sends nothing', async () => {
    const db = createTableMockSupabase({
      bank_payment_allowance_requests: { data: [{ id: 'r-0', created_at: '2026-10-14T08:00:00.000Z' }] },
    })
    const result = await requestMoreBankPayments(
      db.supabase as unknown as SupabaseClient,
      { companyId: COMPANY, userId: USER, email: 'anna@bygg.se', log: log() },
      { monthlyPaymentsWanted: 40, message: null },
    )
    expect(result).toEqual({ ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_REQUEST_OPEN', details: { requested_at: '2026-10-14T08:00:00.000Z' } })
    expect(db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('removes the request again when the mail is not sent, so it can be asked again', async () => {
    mail.sendEmail.mockResolvedValue({ success: false, error: 'provider down' })
    const db = createTableMockSupabase({
      bank_payment_allowance_requests: [{ data: [] }, { data: { id: 'r-2', created_at: '2026-10-14T10:00:00.000Z' } }, { data: null }],
      payment_orders: { data: [] },
      companies: { data: { name: 'Bygg AB', org_number: '556677-8899' } },
    })
    const result = await requestMoreBankPayments(
      db.supabase as unknown as SupabaseClient,
      { companyId: COMPANY, userId: USER, email: null, log: log() },
      { monthlyPaymentsWanted: 20, message: null },
    )
    expect(result).toEqual({ ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_REQUEST_NOT_SENT' })
    expect(db.findCalls('bank_payment_allowance_requests', 'delete')).toHaveLength(1)
    expect(db.findCalls('bank_payment_allowance_requests', 'eq')).toContainEqual(['id', 'r-2'])
  })

  it('writes nothing when no mail can be sent at all', async () => {
    mail.isConfigured.mockReturnValue(false)
    const db = createTableMockSupabase({ bank_payment_allowance_requests: { data: [] } })
    const result = await requestMoreBankPayments(
      db.supabase as unknown as SupabaseClient,
      { companyId: COMPANY, userId: USER, email: null, log: log() },
      { monthlyPaymentsWanted: 20, message: null },
    )
    expect(result).toEqual({ ok: false, code: 'BANK_PAYMENTS_ALLOWANCE_REQUEST_NOT_SENT' })
    expect(db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([])
  })
})
