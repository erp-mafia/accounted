/**
 * gnubok_send_invoice with channel kivra or billo: the invoice page's send to
 * the customer's digital mailbox, staged. Staging runs every check that send
 * runs (lib/invoices/digital-mailbox-send.ts checkInvoiceMailboxSend: the
 * company's active sending, the usage gate, the recipient and the provider's
 * match of the mailbox) and refuses with the same code, so an agent learns
 * "send by email instead" before anyone is asked to approve. The staged row
 * carries the channel for the approval; the preview names no identity number.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { sendingNotActiveRefusal } from '@/lib/digital-mailboxes/sending-not-active'

const checkInvoiceMailboxSend = vi.hoisted(() => vi.fn())
const getEmailService = vi.hoisted(() => vi.fn())

vi.mock('@/lib/invoices/digital-mailbox-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/digital-mailbox-send')>()),
  checkInvoiceMailboxSend,
}))
vi.mock('@/lib/email/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/service')>()),
  getEmailService,
}))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  createServiceClientNoCookies: () => ({ service: true }),
}))

import { tools } from '../server'

const sendInvoice = tools.find((t) => t.name === 'gnubok_send_invoice')!

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'

const DRAFT = {
  id: INVOICE_ID,
  invoice_number: 'F-007',
  status: 'draft',
  document_type: 'invoice',
  credited_invoice_id: null,
  journal_entry_id: null,
  total: 12500,
  total_sek: 12500,
  subtotal: 10000,
  vat_amount: 2500,
  currency: 'SEK',
  vat_treatment: 'standard_25',
  // No email: a mailbox send does not need one.
  customer: {
    name: 'Testkund AB',
    email: null,
    customer_type: 'swedish_business',
    org_number: '442005-9208',
    address_line1: 'Storgatan 1',
    postal_code: '111 22',
    city: 'Stockholm',
    country: 'SE',
  },
}

function setup() {
  return createTableMockSupabase({
    invoices: { data: DRAFT },
    invoice_items: { data: [] },
    company_settings: {
      data: {
        entity_type: 'aktiebolag',
        accounting_method: 'accrual',
        bookkeeping_locked_through: null,
        company_name: 'Test AB',
        address_line1: 'Testgatan 1',
        postal_code: '111 22',
        city: 'Stockholm',
      },
    },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

const call = (args: Record<string, unknown>, supabase: unknown) =>
  sendInvoice.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never)

beforeEach(() => {
  vi.clearAllMocks()
  checkInvoiceMailboxSend.mockResolvedValue({ ok: true, data: { provider: 'kivra', recipient_kind: 'company', will_issue: true } })
})

describe('gnubok_send_invoice: channel kivra or billo', () => {
  it('takes a channel in its schema, email by default', () => {
    const channel = (sendInvoice.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.channel
    expect(channel.enum).toEqual(['email', 'kivra', 'billo'])
    expect(sendInvoice.title).toBe('Send Invoice')
    expect(sendInvoice.annotations).toMatchObject({ openWorldHint: true, readOnlyHint: false })
  })

  it('stages the mailbox send with its channel, without a customer email or the email service', async () => {
    const { supabase, findCall } = setup()
    const result = (await call({ invoice_id: INVOICE_ID, channel: 'kivra' }, supabase)) as {
      staged: boolean
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(checkInvoiceMailboxSend).toHaveBeenCalledWith(
      expect.objectContaining({ supabase, service: { service: true }, companyId: 'company-1' }),
      INVOICE_ID,
      'kivra',
    )
    expect(getEmailService).not.toHaveBeenCalled()
    const staged = findCall('pending_operations', 'insert')![0] as { operation_type: string; title: string; params: Record<string, unknown> }
    expect(staged.operation_type).toBe('send_invoice')
    expect(staged.params).toEqual({ invoice_id: INVOICE_ID, channel: 'kivra' })
    expect(staged.title).toBe('Skicka till Kivra: F-007')
    expect(result.preview).toMatchObject({
      invoice_number: 'F-007',
      customer_name: 'Testkund AB',
      channel: 'kivra',
      recipient_kind: 'company',
      total: 12500,
      currency: 'SEK',
    })
    // The org number or personnummer the mailbox is addressed by stays out of the preview.
    expect(JSON.stringify(result.preview)).not.toMatch(/442005|4420059208/)
  })

  it('refuses a customer the mailbox cannot reach, naming email as the way, and stages nothing', async () => {
    checkInvoiceMailboxSend.mockResolvedValue({ ok: false, code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE', details: { recipient_kind: 'company' } })
    const { supabase, findCall } = setup()

    const error = await call({ invoice_id: INVOICE_ID, channel: 'kivra' }, supabase).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE', details: { recipient_kind: 'company' } })
    const structured = getStructuredError(error)
    expect(structured.remediation?.tool).toBe('gnubok_send_invoice')
    expect(structured.remediation?.description).toMatch(/by email instead/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses while the company has not switched on sending, saying where a person does it', async () => {
    checkInvoiceMailboxSend.mockResolvedValue({ ok: false, code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE' })
    const { supabase, findCall } = setup()

    const error = await call({ invoice_id: INVOICE_ID, channel: 'kivra' }, supabase).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE' })
    expect(getStructuredError(error).remediation?.description).toMatch(/\/settings\/connections/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('says that sending waits for Kivra\'s approval, with that state\'s sentence and next step', async () => {
    checkInvoiceMailboxSend.mockResolvedValue({
      ok: false,
      ...sendingNotActiveRefusal('kivra', {
        send_state: 'off',
        provider_meta: { sender_request: { ref: 'req-1', status: 'pending', requested_at: '2026-11-20T10:00:00Z', requested_by: 'user-1' } },
      }),
    })
    const { supabase, findCall } = setup()

    const error = await call({ invoice_id: INVOICE_ID, channel: 'kivra' }, supabase).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE', details: { state: 'pending' } })
    const structured = getStructuredError(error)
    expect(structured.message_sv).toMatch(/^Utskick via Kivra är påslaget men väntar på att Kivra godkänner det/)
    expect(structured.remediation?.description).toMatch(/Nothing to do but wait/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('passes the usage gate refusal through with its composed Swedish sentence', async () => {
    const messageSv = 'Utskick till Kivra kostar 3,00 kr st. Begär det under Inställningar, Abonnemang, Användning, så öppnar vi.'
    checkInvoiceMailboxSend.mockResolvedValue({
      ok: false,
      code: 'USAGE_LIMIT_REACHED',
      details: { kind: 'kivra_send', included: 0, used: 0, requested: 1, unit_price_ore: 300, period: '2026-11' },
      messageSv,
    })
    const { supabase, findCall } = setup()

    const error = await call({ invoice_id: INVOICE_ID, channel: 'kivra' }, supabase).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'USAGE_LIMIT_REACHED', message: messageSv, details: { kind: 'kivra_send' } })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses attachments on a mailbox send, and an unknown channel, before any check', async () => {
    const { supabase, findCall } = setup()
    await expect(
      call({ invoice_id: INVOICE_ID, channel: 'kivra', attachment_document_ids: ['44444444-4444-4444-8444-444444444444'] }, supabase),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'attachment_document_ids' }] })
    await expect(call({ invoice_id: INVOICE_ID, channel: 'fax' }, supabase)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      issues: [{ field: 'channel' }],
    })
    expect(checkInvoiceMailboxSend).not.toHaveBeenCalled()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('keeps the email send as it was without a channel', async () => {
    getEmailService.mockResolvedValue({ isConfigured: () => true })
    const { supabase } = setup()
    // The draft's customer has no email: the email send refuses, the mailbox check is never asked.
    await expect(call({ invoice_id: INVOICE_ID }, supabase)).rejects.toThrow(/no email address/)
    expect(checkInvoiceMailboxSend).not.toHaveBeenCalled()
  })
})
