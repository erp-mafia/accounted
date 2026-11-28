import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PayslipData } from '@/lib/salary/pdf/payslip-template'

const providers = vi.hoisted(() => ({ getDigitalMailboxProviders: vi.fn() }))
vi.mock('@/lib/digital-mailboxes/providers', () => providers)
const connections = vi.hoisted(() => ({ getConnection: vi.fn() }))
vi.mock('@/lib/digital-mailboxes/connections', async (orig) => ({
  ...(await orig<typeof import('@/lib/digital-mailboxes/connections')>()),
  ...connections,
}))

import { payslipMailboxBlock, payslipStatement } from '../send-digital-mailbox'

const CONTACT = {
  address_line1: 'Storgatan 1',
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'SE',
  phone: '08-465 004 05',
  email: 'lon@example.test',
}

function settingsDb(row: Record<string, unknown> | null) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: row, error: null })),
  }
  return { db: { from: vi.fn(() => query) } as unknown as SupabaseClient, query }
}

function senderFor(provider: 'kivra' | 'billo', needsContact: boolean) {
  providers.getDigitalMailboxProviders.mockReturnValue({
    [provider]: { id: provider, receiver: null, sender: { payslipNeedsEmployerContact: needsContact } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  connections.getConnection.mockResolvedValue({ send_state: 'active', tenant_ref: 'tk1' })
})

describe('payslipMailboxBlock', () => {
  it('lets Kivra send when the company settings hold the address, email and phone', async () => {
    senderFor('kivra', true)
    const { db, query } = settingsDb(CONTACT)
    await expect(payslipMailboxBlock(db, 'company-1', 'kivra')).resolves.toBeNull()
    expect(query.select).toHaveBeenCalledWith('address_line1, postal_code, city, country, phone, email')
    expect(query.eq).toHaveBeenCalledWith('company_id', 'company-1')
  })

  it('refuses Kivra up front while the employer contact is incomplete', async () => {
    senderFor('kivra', true)
    await expect(payslipMailboxBlock(settingsDb({ ...CONTACT, phone: null }).db, 'company-1', 'kivra')).resolves.toEqual({
      code: 'DIGITAL_MAILBOX_EMPLOYER_CONTACT_MISSING',
    })
    await expect(payslipMailboxBlock(settingsDb(null).db, 'company-1', 'kivra')).resolves.toEqual({
      code: 'DIGITAL_MAILBOX_EMPLOYER_CONTACT_MISSING',
    })
  })

  it('never reads the contact for Billo, which shows the PDF only', async () => {
    senderFor('billo', false)
    const { db } = settingsDb(null)
    await expect(payslipMailboxBlock(db, 'company-1', 'billo')).resolves.toBeNull()
    expect(db.from).not.toHaveBeenCalled()
  })

  it('answers not configured and not active before looking at the contact', async () => {
    providers.getDigitalMailboxProviders.mockReturnValue({})
    await expect(payslipMailboxBlock(settingsDb(CONTACT).db, 'company-1', 'kivra')).resolves.toEqual({
      code: 'DIGITAL_MAILBOX_NOT_CONFIGURED',
    })

    senderFor('kivra', true)
    connections.getConnection.mockResolvedValue({ send_state: 'off', tenant_ref: null, provider_meta: {} })
    const { db } = settingsDb(null)
    await expect(payslipMailboxBlock(db, 'company-1', 'kivra')).resolves.toMatchObject({
      code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE',
      details: { state: 'off' },
    })
    expect(db.from).not.toHaveBeenCalled()
  })

  it('says where sending stands while it waits for Kivra\'s approval or was declined', async () => {
    senderFor('kivra', true)
    for (const status of ['pending', 'rejected'] as const) {
      connections.getConnection.mockResolvedValue({
        send_state: 'off',
        tenant_ref: null,
        provider_meta: { sender_request: { ref: 'req-1', status, requested_at: '2026-11-20T10:00:00Z', requested_by: 'user-1' } },
      })
      await expect(payslipMailboxBlock(settingsDb(CONTACT).db, 'company-1', 'kivra')).resolves.toMatchObject({
        code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE',
        details: { state: status },
        messageSv: expect.stringContaining('Kivra'),
      })
    }
  })
})

describe('payslipStatement', () => {
  it('reads the figures the PDF prints and spans the whole pay month', () => {
    const data = {
      companyName: 'Exempel AB',
      companyOrgNumber: '442005-9208',
      grossSalary: 32500,
      taxWithheld: 6962.5,
      netSalary: 25537.5,
      ytdGross: 65000,
      ytdTax: 13925,
    } as PayslipData
    const contact = {
      streetAddress: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      country: 'SE',
      email: 'lon@example.test',
      phone: '08-465 004 05',
    }
    expect(payslipStatement(data, { year: 2028, month: 2, paymentDate: '2028-02-25' }, contact)).toEqual({
      employer: { name: 'Exempel AB', orgNumber: '442005-9208', ...contact },
      periodStart: '2028-02-01',
      periodEnd: '2028-02-29',
      payoutDate: '2028-02-25',
      grossPay: 32500,
      taxDeducted: 6962.5,
      netPay: 25537.5,
      yearToDateGrossPay: 65000,
      yearToDateTax: 13925,
    })
    expect(payslipStatement(data, { year: 2026, month: 12, paymentDate: '2026-12-23T00:00:00Z' }, contact)).toMatchObject({
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      payoutDate: '2026-12-23',
    })
  })
})
