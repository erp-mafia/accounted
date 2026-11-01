import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const sendAttestRequestMail = vi.fn()
vi.mock('@/lib/email/send-attest-request', () => ({ sendAttestRequestMail: (...args: unknown[]) => sendAttestRequestMail(...args) }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: async () => 'https://app.example.se' }))
const service = createTableMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase, createClient: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import { notifyAttestersOfInvoice, registerAttestNotificationHandler } from '../attest-notify'

const POLICY = { company_id: 'c1', enabled: true, threshold_amount: 1000, mode: 'any', attesters: ['anna', 'bo', 'cilla'], preparer_may_attest: false, updated_by: null, updated_at: null }
const INVOICE = {
  id: 'inv-1',
  user_id: 'cilla',
  status: 'registered',
  approved_at: null,
  is_credit_note: false,
  currency: 'SEK',
  total: 12500,
  total_sek: null,
  exchange_rate: null,
  supplier_invoice_number: 'F-1',
  arrival_number: 7,
  due_date: '2026-10-31',
  supplier: { name: 'Kontorsvaror AB' },
}

function seed(overrides: Record<string, unknown> = {}) {
  service.reset()
  const tables: Record<string, unknown> = {
    company_attest_policies: { data: POLICY },
    supplier_invoices: { data: INVOICE },
    company_settings: { data: { accounting_method: 'accrual' } },
    companies: { data: { name: 'Testbolaget AB' } },
    company_members: { data: ['anna', 'bo', 'cilla'].map((user_id) => ({ user_id, role: 'member' })) },
    profiles: { data: [{ id: 'anna', email: 'anna@example.se', full_name: 'Anna Ek' }, { id: 'bo', email: 'bo@example.se', full_name: null }, { id: 'cilla', email: 'cilla@example.se', full_name: 'Cilla' }] },
    notification_settings: { data: [{ user_id: 'bo', attest_request_email_enabled: false }] },
    supplier_invoice_attest_links: { data: { id: 'link-1' } },
    ...overrides,
  }
  for (const [key, value] of Object.entries(tables)) service.setTable(key, value as never)
}

describe('notifyAttestersOfInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    sendAttestRequestMail.mockResolvedValue({ emailSent: true })
  })

  it('mails each attester who may attest, skips the registrant and whoever switched the mail off', async () => {
    seed()
    const result = await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')
    expect(result).toEqual({ mailed: 1, skipped_opted_out: 1, skipped_no_email: 0 })
    expect(sendAttestRequestMail).toHaveBeenCalledTimes(1)
    const [{ email, data }] = sendAttestRequestMail.mock.calls[0] as [{ email: string; data: Record<string, unknown> }]
    expect(email).toBe('anna@example.se')
    expect(data).toMatchObject({ supplierName: 'Kontorsvaror AB', total: 12500, registeredBy: 'Cilla', companyName: 'Testbolaget AB' })
    expect(data.approveUrl).toMatch(/^https:\/\/app\.example\.se\/attest\/[A-Za-z0-9_-]{43}\?beslut=godkann$/)
    expect(data.rejectUrl).toMatch(/\?beslut=neka$/)
    // The link is stored by its hash; the clear token only travels in the mail.
    const inserted = service.payloads('supplier_invoice_attest_links', 'insert')[0] as Record<string, unknown>
    expect(inserted).toMatchObject({ attester_user_id: 'anna', supplier_invoice_id: 'inv-1' })
    expect(inserted.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(String(data.approveUrl)).not.toContain(String(inserted.token_hash))
  })

  it('levels (#135): mails only whom the invoice needs, those whose limit covers it unless it needs two', async () => {
    // Anna attests up to 10 000 kr, Bo without a limit (and has the mail on here); the invoice is 12 500 kr.
    const limits = { company_attest_limits: { data: [{ user_id: 'anna', max_amount_sek: 10000 }] } }
    seed({ ...limits, notification_settings: { data: [] } })
    expect(await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')).toMatchObject({ mailed: 1 })
    expect(sendAttestRequestMail.mock.calls.map(([call]) => (call as { email: string }).email)).toEqual(['bo@example.se'])

    sendAttestRequestMail.mockClear()
    seed({ ...limits, notification_settings: { data: [] }, company_attest_policies: { data: { ...POLICY, two_step_from_sek: 10000 } } })
    expect(await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')).toMatchObject({ mailed: 2 })
    expect(sendAttestRequestMail.mock.calls.map(([call]) => (call as { email: string }).email).sort()).toEqual(['anna@example.se', 'bo@example.se'])
  })

  it('sends nothing when the policy is off, the invoice is under the threshold, or it is attested already', async () => {
    seed({ company_attest_policies: { data: { ...POLICY, enabled: false } } })
    expect((await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')).mailed).toBe(0)
    seed({ supplier_invoices: { data: { ...INVOICE, total: 999 } } })
    expect((await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')).mailed).toBe(0)
    seed({ supplier_invoices: { data: { ...INVOICE, approved_at: '2026-10-01T09:00:00Z' } } })
    expect((await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')).mailed).toBe(0)
    seed({ company_settings: { data: { accounting_method: 'cash' } } })
    expect((await notifyAttestersOfInvoice(service.supabase as unknown as SupabaseClient, 'c1', 'inv-1')).mailed).toBe(0)
    expect(sendAttestRequestMail).not.toHaveBeenCalled()
  })

  it('runs on supplier_invoice.registered and never throws at the emitter; a failure reaches the bus as an error', async () => {
    seed({ company_attest_policies: { error: { message: 'boom' } } })
    const unsubscribe = registerAttestNotificationHandler()
    await expect(
      eventBus.emit({ type: 'supplier_invoice.registered', payload: { supplierInvoice: { id: 'inv-1' } as never, userId: 'cilla', companyId: 'c1' } }),
    ).resolves.toBeUndefined()
    unsubscribe()
    expect(sendAttestRequestMail).not.toHaveBeenCalled()
    expect(logMock.error).toHaveBeenCalledWith('handler failed', expect.anything(), expect.objectContaining({
      eventType: 'supplier_invoice.registered',
      handler: 'handleSupplierInvoiceRegistered',
      companyId: 'c1',
    }))
  })
})
