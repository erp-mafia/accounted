import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'

const getConnection = vi.hoisted(() => vi.fn())
const providers = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const issueAndBookInvoice = vi.hoisted(() => vi.fn())
const renderInvoicePdfBuffer = vi.hoisted(() => vi.fn())
const isSandboxCompany = vi.hoisted(() => vi.fn())

vi.mock('@/lib/digital-mailboxes/connections', () => ({ getConnection }))
vi.mock('@/lib/digital-mailboxes/providers', () => ({ getDigitalMailboxProviders: () => providers.value }))
vi.mock('@/lib/invoices/issue-and-book-invoice', () => ({ issueAndBookInvoice }))
vi.mock('@/lib/invoices/render-invoice-pdf', () => ({ renderInvoicePdfBuffer }))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany }))

import {
  invoiceMailboxBlock,
  invoiceMailboxPayment,
  invoiceMailboxRecipient,
  sendInvoiceToDigitalMailbox,
} from '../digital-mailbox-send'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

describe('invoiceMailboxBlock', () => {
  it('lets a SEK invoice through from draft and from issued, unpaid states', () => {
    for (const status of ['draft', 'sent', 'overdue', 'partially_paid'] as const) {
      expect(invoiceMailboxBlock(makeInvoice({ status }))).toBeNull()
    }
  })

  it('refuses credit notes, other documents, settled invoices and foreign currency', () => {
    expect(invoiceMailboxBlock(makeInvoice({ credited_invoice_id: 'x' }))).toBe('DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE')
    expect(invoiceMailboxBlock(makeInvoice({ total: -500 }))).toBe('DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE')
    expect(invoiceMailboxBlock(makeInvoice({ document_type: 'quote' }))).toBe('DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE')
    expect(invoiceMailboxBlock(makeInvoice({ status: 'paid' }))).toBe('DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE')
    expect(invoiceMailboxBlock(makeInvoice({ currency: 'EUR' }))).toBe('DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED')
  })
})

describe('invoiceMailboxRecipient', () => {
  it('addresses a company by organisationsnummer and a sole trader by personnummer', () => {
    expect(invoiceMailboxRecipient(makeCustomer({ customer_type: 'swedish_business', org_number: '442005-9208' }))).toEqual({
      kind: 'company',
      orgNumber: '4420059208',
    })
    expect(invoiceMailboxRecipient(makeCustomer({ customer_type: 'swedish_business', org_number: '500118-2046' }))).toEqual({
      kind: 'person',
      personnummer: '195001182046',
    })
  })

  it('addresses a private person by a plaintext or stored personnummer, and nothing else', () => {
    expect(invoiceMailboxRecipient(makeCustomer({ customer_type: 'individual', personal_number: '500118-2046' }))).toEqual({
      kind: 'person',
      personnummer: '195001182046',
    })
    expect(invoiceMailboxRecipient(makeCustomer({ customer_type: 'individual', personal_number: null }))).toBeNull()
    expect(invoiceMailboxRecipient(makeCustomer({ customer_type: 'eu_business', org_number: '442005-9208' }))).toBeNull()
    expect(invoiceMailboxRecipient(null)).toBeNull()
  })
})

describe('invoiceMailboxPayment', () => {
  const settings = makeCompanySettings({ bankgiro: '991-2346', plusgiro: null })

  it('pays the frozen payee giro with the OCR the PDF prints', () => {
    const invoice = makeInvoice({
      status: 'sent',
      invoice_number: '1042',
      due_date: '2026-11-18',
      total: 1250,
      remaining_amount: 1250,
      payment_details: { bankgiro: '123-4567', plusgiro: null } as never,
    })
    expect(invoiceMailboxPayment(invoice, settings, 'sv')).toEqual({
      amount: 1250,
      dueDate: '2026-11-18',
      method: 'bankgiro',
      account: '123-4567',
      reference: generateOcrReference('1042'),
      referenceType: 'ocr',
    })
  })

  it('uses the invoice number when the PDF prints no OCR, and nothing without a giro', () => {
    const invoice = makeInvoice({ status: 'sent', invoice_number: '1042', total: 100, remaining_amount: 100 })
    expect(invoiceMailboxPayment(invoice, settings, 'en')).toMatchObject({ reference: '1042', referenceType: 'invoice_number' })
    expect(invoiceMailboxPayment(invoice, makeCompanySettings({ bankgiro: null, plusgiro: null }), 'sv')).toBeNull()
  })
})

describe('sendInvoiceToDigitalMailbox', () => {
  const sender = {
    payslipReachesNonUsers: false,
    payslipNeedsEmployerContact: false,
    registerSender: vi.fn(),
    isReachable: vi.fn(),
    sendInvoice: vi.fn(),
    sendPayslip: vi.fn(),
  }
  const customer = makeCustomer({ customer_type: 'swedish_business', org_number: '442005-9208', language: 'sv' })
  let invoiceRow: Record<string, unknown>
  const dispatches: Array<Record<string, unknown>> = []

  function memberClient(): SupabaseClient {
    return {
      from: (table: string) => {
        const chain: Record<string, unknown> = {}
        const self = () => chain
        chain.select = self
        chain.eq = self
        chain.maybeSingle = async () => ({ data: table === 'invoices' ? invoiceRow : null, error: null })
        chain.single = async () => ({ data: table === 'company_settings' ? makeCompanySettings({ bankgiro: '991-2346' }) : null, error: null })
        return chain
      },
    } as unknown as SupabaseClient
  }
  const service = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        dispatches.push(row)
        return { select: () => ({ single: async () => ({ data: { id: `dispatch-${dispatches.length}` }, error: null }) }) }
      },
    }),
  } as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    dispatches.length = 0
    providers.value = { kivra: { sender } }
    isSandboxCompany.mockResolvedValue(false)
    getConnection.mockResolvedValue({ send_state: 'active', tenant_ref: 'tk1' })
    invoiceRow = { ...makeInvoice({ id: 'inv-1', status: 'draft', invoice_number: null }), customer, items: [] }
    renderInvoicePdfBuffer.mockResolvedValue({ buffer: Buffer.from('%PDF') })
    issueAndBookInvoice.mockImplementation(async () => {
      invoiceRow = { ...invoiceRow, status: 'sent', invoice_number: '1042' }
      return { ok: true, journalEntryId: 'je-1', partialFailures: [] }
    })
  })

  const ctx = () => ({ supabase: memberClient(), service, companyId: 'company-1', userId: 'user-1', log })

  it('refuses an unreachable recipient before anything is issued', async () => {
    sender.isReachable.mockResolvedValue(false)
    const outcome = await sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')
    expect(outcome).toMatchObject({ ok: false, code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE' })
    expect(issueAndBookInvoice).not.toHaveBeenCalled()
    expect(sender.sendInvoice).not.toHaveBeenCalled()
  })

  it('refuses without an active sender, and in the demo company', async () => {
    getConnection.mockResolvedValue(null)
    await expect(sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')).resolves.toMatchObject({ code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE' })
    isSandboxCompany.mockResolvedValue(true)
    await expect(sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')).resolves.toMatchObject({ code: 'DIGITAL_MAILBOX_SANDBOX' })
    providers.value = {}
    await expect(sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')).resolves.toMatchObject({ code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' })
  })

  it('issues a draft, then sends it and records the dispatch', async () => {
    sender.isReachable.mockResolvedValue(true)
    sender.sendInvoice.mockResolvedValue({ providerRef: 'content-1' })
    const outcome = await sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')
    expect(outcome).toEqual({
      ok: true,
      data: { dispatch_id: 'dispatch-1', provider: 'kivra', provider_ref: 'content-1', recipient_kind: 'company', issued: true, journal_entry_id: 'je-1' },
    })
    expect(issueAndBookInvoice.mock.invocationCallOrder[0]).toBeLessThan(sender.sendInvoice.mock.invocationCallOrder[0]!)
    const [, recipient, invoice] = sender.sendInvoice.mock.calls[0]!
    expect(recipient).toEqual({ kind: 'company', orgNumber: '4420059208' })
    expect(invoice).toMatchObject({ invoiceNumber: '1042', payment: { method: 'bankgiro', account: '991-2346', referenceType: 'ocr' } })
    expect(dispatches[0]).toMatchObject({ provider: 'kivra', invoice_id: 'inv-1', status: 'sent', provider_ref: 'content-1', recipient_kind: 'company' })
  })

  it('keeps the issue and logs a failed dispatch when the delivery fails', async () => {
    sender.isReachable.mockResolvedValue(true)
    sender.sendInvoice.mockRejectedValue(new Error('provider down'))
    const outcome = await sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')
    expect(outcome).toMatchObject({ ok: false, code: 'DIGITAL_MAILBOX_SEND_FAILED', details: { issued: true, journal_entry_id: 'je-1' } })
    expect(dispatches[0]).toMatchObject({ status: 'failed', error_code: 'DIGITAL_MAILBOX_SEND_FAILED' })
  })

  it('passes the issue path\'s refusal through untouched', async () => {
    sender.isReachable.mockResolvedValue(true)
    issueAndBookInvoice.mockResolvedValue({ ok: false, errorCode: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', details: { currency: 'SEK' } })
    await expect(sendInvoiceToDigitalMailbox(ctx(), 'inv-1', 'kivra')).resolves.toMatchObject({
      ok: false,
      code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
    })
    expect(sender.sendInvoice).not.toHaveBeenCalled()
  })
})
