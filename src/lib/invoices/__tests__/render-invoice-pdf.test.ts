/**
 * The one invoice render entry point (lib/invoices/render-invoice-pdf.ts):
 * the payee is applied before the QR is resolved, the resolved code reaches
 * the template as ONE image (PNG with a 4-module quiet zone, or a vector
 * path for the bank-app code), and a document that asks for no payment gets
 * none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, Currency, InvoicePaymentAccount } from '@/types'

const mocks = vi.hoisted(() => ({
  renderToBuffer: vi.fn(),
  InvoicePDF: vi.fn(),
  prepare: vi.fn(),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => mocks.renderToBuffer(...args),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: (...args: unknown[]) => mocks.InvoicePDF(...args),
}))

// The real payee resolution, without the logo fetch and font registration.
vi.mock('@/lib/invoices/pdf-render-helpers', async () => {
  const { companyWithInvoicePaymentAccount, assertInvoicePaymentAccountForRender } = await import(
    '@/lib/invoices/payment-accounts'
  )
  return {
    prepareInvoicePdfRender: (
      company: CompanySettings,
      currency: Currency,
      options: { paymentAccountRequired?: boolean; payee?: Partial<InvoicePaymentAccount> | null },
    ) => {
      mocks.prepare(company, currency, options)
      if (options.paymentAccountRequired !== false) {
        assertInvoicePaymentAccountForRender(company, currency, options.payee ?? null)
      }
      return Promise.resolve({
        branding: { fontFamily: 'Helvetica' },
        company: companyWithInvoicePaymentAccount(company, currency, options.payee ?? null),
      })
    },
  }
})

import { buildInvoicePaymentQrImage, countPdfPages, renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'

const company = (overrides: Partial<CompanySettings> = {}) =>
  makeCompanySettings({
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
    bankgiro: '5050-1055',
    swish: '1234567890',
    invoice_show_swish: true,
    invoice_qr_mode: 'auto',
    ...overrides,
  })

const sentInvoice = (overrides: Parameters<typeof makeInvoice>[0] = {}) =>
  makeInvoice({ status: 'sent', invoice_number: '10234', ...overrides })

function templateProps(): Record<string, unknown> {
  const call = mocks.InvoicePDF.mock.calls.at(-1)
  if (!call) throw new Error('InvoicePDF was not called')
  return call[0] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.renderToBuffer.mockResolvedValue(Buffer.from('%PDF-'))
  mocks.InvoicePDF.mockReturnValue('pdf-element')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderInvoicePdfBuffer', () => {
  it('renders through InvoicePDF with the payee-applied company and returns the buffer', async () => {
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice(),
      customer: makeCustomer(),
      items: [],
      company: company(),
    })
    expect(result.buffer.toString()).toBe('%PDF-')
    expect(mocks.renderToBuffer).toHaveBeenCalledWith('pdf-element')
    expect(templateProps()).toMatchObject({
      company: expect.objectContaining({ bankgiro: '5050-1055' }),
      branding: { fontFamily: 'Helvetica' },
    })
  })

  it('draws the bank-app code as a vector path with its caption for a business customer', async () => {
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice(),
      customer: makeCustomer({ customer_type: 'swedish_business' }),
      items: [],
      company: company(),
    })
    expect(result.paymentQr.kind).toBe('bank_app')
    const qr = templateProps().paymentQr as { kind: string; caption: string; vector?: { path: string; size: number } }
    expect(qr.kind).toBe('bank_app')
    expect(qr.caption).toBe('Skanna med din bankapp')
    expect(qr.vector?.path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/)
    expect(qr.vector?.size).toBeGreaterThan(21)
  })

  it('draws Swish for a private customer as a PNG with a 4-module quiet zone', async () => {
    const toDataURL = vi.spyOn(QRCode, 'toDataURL')
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice(),
      customer: makeCustomer({ customer_type: 'individual' }),
      items: [],
      company: company(),
    })
    expect(result.paymentQr).toMatchObject({ kind: 'swish', payload: 'C1234567890;12500.00;10234;0' })
    expect(toDataURL).toHaveBeenCalledWith('C1234567890;12500.00;10234;0', expect.objectContaining({ margin: 4 }))
    expect(templateProps().paymentQr).toMatchObject({
      kind: 'swish',
      caption: 'Skanna för att betala med Swish',
      imageDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    })
  })

  it('resolves the code from the invoice\'s own frozen payee, not the company default', async () => {
    const payee: InvoicePaymentAccount = {
      bank_name: null,
      clearing_number: null,
      account_number: null,
      bankgiro: null,
      plusgiro: null,
      swish: null,
      iban: 'SE4550000000058398257466',
      bic: 'ESSESESS',
      bank_code: null,
      foreign_account_number: null,
    }
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice({ payment_details: payee }),
      customer: makeCustomer(),
      items: [],
      company: company(),
    })
    expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), 'SEK', expect.objectContaining({ payee }))
    // The printed payee has no giro and no Swish: no code, whatever the company default holds.
    expect(result.paymentQr).toEqual({ kind: null, mode: 'auto', reason: 'no_printed_giro' })
    expect(templateProps().paymentQr).toBeNull()
  })

  it('honours the invoice QR mode', async () => {
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice({ qr_mode: 'none' }),
      customer: makeCustomer(),
      items: [],
      company: company(),
    })
    expect(result.paymentQr).toEqual({ kind: null, mode: 'none', reason: 'mode_none' })
    expect(templateProps().paymentQr).toBeNull()
  })

  it('passes no pay-again code on a paid re-render (the betalningsbekräftelse)', async () => {
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice({ status: 'paid', paid_amount: 12500, remaining_amount: 0, payment_link_url: 'https://pay.example.test/x' }),
      customer: makeCustomer({ customer_type: 'individual' }),
      items: [],
      company: company(),
    })
    expect(result.paymentQr).toMatchObject({ kind: null, reason: 'not_payable' })
    expect(templateProps().paymentQr).toBeNull()
  })

  it('requires a payee for a real invoice and not for a credit note by default', async () => {
    await renderInvoicePdfBuffer({ invoice: sentInvoice(), customer: makeCustomer(), items: [], company: company() })
    expect(mocks.prepare).toHaveBeenLastCalledWith(
      expect.anything(),
      'SEK',
      expect.objectContaining({ paymentAccountRequired: true }),
    )
    await renderInvoicePdfBuffer({
      invoice: sentInvoice({ credited_invoice_id: 'inv-orig' }),
      customer: makeCustomer(),
      items: [],
      company: company(),
    })
    expect(mocks.prepare).toHaveBeenLastCalledWith(
      expect.anything(),
      'SEK',
      expect.objectContaining({ paymentAccountRequired: false }),
    )
  })

  it('forwards preview mode, language and the credit reference to the template', async () => {
    await renderInvoicePdfBuffer({
      invoice: sentInvoice(),
      customer: makeCustomer({ language: 'sv' }),
      items: [],
      company: company(),
      isPreview: true,
      language: 'en',
      originalInvoiceNumber: 'F-1001',
    })
    expect(templateProps()).toMatchObject({ isPreview: true, language: 'en', originalInvoiceNumber: 'F-1001' })
    expect((templateProps().paymentQr as { caption: string }).caption).toBe('Scan with your banking app')
  })
})

describe('buildInvoicePaymentQrImage', () => {
  it('renders no code when the payload cannot be encoded', async () => {
    vi.spyOn(QRCode, 'toDataURL').mockRejectedValueOnce(new Error('too long'))
    const image = await buildInvoicePaymentQrImage({
      kind: 'payment_link',
      mode: 'payment_link',
      caption: 'Skanna för att betala online',
      payload: 'https://pay.example.test/x',
      amount: 100,
    })
    expect(image).toBeNull()
  })

  it('is null when the resolver chose none', async () => {
    expect(await buildInvoicePaymentQrImage({ kind: null, mode: 'auto', reason: 'nothing_due' })).toBeNull()
  })
})

describe('countPdfPages', () => {
  it('counts the page objects, not the page tree root', () => {
    const pdf = Buffer.from(
      '%PDF-1.3\n1 0 obj\n<<\n/Type /Pages\n/Count 3\n>>\nendobj\n'
      + '2 0 obj\n<<\n/Type /Page\n/Parent 1 0 R\n>>\nendobj\n'
      + '3 0 obj\n<<\n/Type/Page\n/Parent 1 0 R\n>>\nendobj\n'
      + '4 0 obj\n<<\n/Type /Page\n/Parent 1 0 R\n>>\nendobj\n',
      'latin1',
    )
    expect(countPdfPages(pdf)).toBe(3)
    expect(countPdfPages(Buffer.from('not a pdf'))).toBe(0)
  })

  it('is returned with every render, so the editor can show it', async () => {
    mocks.renderToBuffer.mockResolvedValue(Buffer.from('<< /Type /Pages >> << /Type /Page >> << /Type /Page >>', 'latin1'))
    const result = await renderInvoicePdfBuffer({
      invoice: sentInvoice(),
      customer: makeCustomer(),
      items: [],
      company: company(),
    })
    expect(result.pageCount).toBe(2)
  })
})
