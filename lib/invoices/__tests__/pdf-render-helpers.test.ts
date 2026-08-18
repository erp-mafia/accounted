/**
 * Regression tests for issue #772: "Logotyp kommer inte med på fakturor".
 *
 * Root cause: @react-pdf/renderer's <Image> only decodes JPG/PNG, but the logo
 * upload route and the `logos` bucket accept SVG and WebP. When a logo was an
 * SVG/WebP, @react-pdf silently dropped it (it swallows the decode error in a
 * try/catch), so invoices rendered with no logo and no error.
 *
 * Fix: prepareInvoicePdfRender fetches the stored logo and re-encodes it to a
 * PNG data URL via sharp, so every supported upload format renders. These tests
 * mock `fetch` and exercise the real sharp pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import QRCode from 'qrcode'
import { prepareInvoicePdfRender, buildPaymentLinkQrDataUrl, buildSwishQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { makeCompanySettings, makeInvoice } from '@/tests/helpers'

const fontDownloadMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({ download: fontDownloadMock }),
    },
  }),
}))

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

const SVG_LOGO = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">' +
    '<rect width="120" height="40" fill="#1a1a1a"/>' +
    '<text x="8" y="26" fill="#fff" font-size="18">ACME</text></svg>',
)

/** Build a one-shot fetch mock that returns the given bytes + content-type. */
function mockFetchOnce(buf: Buffer, contentType: string) {
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => contentType },
    arrayBuffer: async () => arrayBuffer,
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** A data: URL whose payload decodes to a valid PNG via sharp. */
async function expectValidEmbeddedPng(logoUrl: string | null | undefined) {
  expect(logoUrl).toMatch(new RegExp(`^${PNG_DATA_URL_PREFIX}`))
  const base64 = (logoUrl as string).slice(PNG_DATA_URL_PREFIX.length)
  const meta = await sharp(Buffer.from(base64, 'base64')).metadata()
  expect(meta.format).toBe('png')
}

describe('prepareInvoicePdfRender: logo resolution (issue #772)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    fontDownloadMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('renders only the payment account matching the invoice currency', async () => {
    const company = makeCompanySettings({
      iban: 'SE0011111111111111111111',
      invoice_payment_accounts: {
        EUR: {
          bank_name: 'EUR Bank',
          clearing_number: null,
          account_number: null,
          bankgiro: null,
          plusgiro: null,
          swish: null,
          iban: 'SE0022222222222222222222',
          bic: 'EURRSESS',
        },
      },
    })

    const { company: resolved } = await prepareInvoicePdfRender(company, 'EUR')

    expect(resolved.bank_name).toBe('EUR Bank')
    expect(resolved.iban).toBe('SE0022222222222222222222')
    expect(resolved.bankgiro).toBeNull()
  })

  it('rejects a foreign-currency PDF without a usable payment account', async () => {
    const company = makeCompanySettings({ invoice_payment_accounts: {} })

    await expect(prepareInvoicePdfRender(company, 'EUR')).rejects.toMatchObject({
      code: 'INVOICE_SEND_PAYMENT_ACCOUNT_MISSING',
      currency: 'EUR',
    })
  })

  it('renders non-payable foreign documents without requiring an account or leaking SEK details', async () => {
    const company = makeCompanySettings({
      iban: 'SE0011111111111111111111',
      invoice_payment_accounts: {},
    })

    const { company: resolved } = await prepareInvoicePdfRender(
      company,
      'EUR',
      { paymentAccountRequired: false },
    )

    expect(resolved.iban).toBeNull()
    expect(resolved.bankgiro).toBeNull()
  })

  it('embeds an SVG logo as a PNG data URL so @react-pdf can draw it', async () => {
    const fetchMock = mockFetchOnce(SVG_LOGO, 'image/svg+xml')
    const company = makeCompanySettings({
      logo_url: 'https://example.test/svg-logo-1.svg',
    })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    // Fetched with a timeout signal so a slow logo host can't hang the render.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/svg-logo-1.svg',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await expectValidEmbeddedPng(resolved.logo_url)
  })

  it('embeds a WebP logo as a PNG data URL', async () => {
    const webp = await sharp(SVG_LOGO).webp().toBuffer()
    mockFetchOnce(webp, 'image/webp')
    const company = makeCompanySettings({
      logo_url: 'https://example.test/webp-logo-1.webp',
    })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    await expectValidEmbeddedPng(resolved.logo_url)
  })

  it('re-encodes a PNG logo to an embedded data URL (no remote fetch at render time)', async () => {
    const png = await sharp(SVG_LOGO).png().toBuffer()
    mockFetchOnce(png, 'image/png')
    const company = makeCompanySettings({
      logo_url: 'https://example.test/png-logo-1.png',
    })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    await expectValidEmbeddedPng(resolved.logo_url)
  })

  it('falls back to the original URL when the logo fetch is not ok', async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: false,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    vi.stubGlobal('fetch', fn)
    const url = 'https://example.test/missing-logo.png'
    const company = makeCompanySettings({ logo_url: url })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    // Unchanged: never worse than before (@react-pdf still fetches PNG/JPEG).
    expect(resolved.logo_url).toBe(url)
  })

  it('falls back to the original URL when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    )
    const url = 'https://example.test/network-error-logo.png'
    const company = makeCompanySettings({ logo_url: url })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    expect(resolved.logo_url).toBe(url)
  })

  it('falls back to the original URL when the logo exceeds the size cap', async () => {
    // Declared content-length over the cap is rejected before reading the body.
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-length' ? String(11 * 1024 * 1024) : 'image/png',
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    vi.stubGlobal('fetch', fn)
    const url = 'https://example.test/oversized-logo.png'
    const company = makeCompanySettings({ logo_url: url })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    expect(fn).toHaveBeenCalled()
    expect(resolved.logo_url).toBe(url)
  })

  it('does not fetch when no logo is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const company = makeCompanySettings({ logo_url: null })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(resolved.logo_url).toBeNull()
  })

  it('passes through an already-embedded data: URL without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const dataUrl = `${PNG_DATA_URL_PREFIX}iVBORw0KGgo=`
    const company = makeCompanySettings({ logo_url: dataUrl })

    const { company: resolved } = await prepareInvoicePdfRender(company)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(resolved.logo_url).toBe(dataUrl)
  })

  it('still returns branding alongside the resolved company', async () => {
    mockFetchOnce(SVG_LOGO, 'image/svg+xml')
    const company = makeCompanySettings({
      logo_url: 'https://example.test/branding-logo.svg',
      invoice_primary_color: '#c2410c',
    })

    const { branding } = await prepareInvoicePdfRender(company)

    expect(branding.primaryColor).toBe('#c2410c')
  })
})

describe('prepareInvoicePdfRender: invoice fonts', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    fontDownloadMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('registers a bundled font before returning it to the PDF template', async () => {
    const company = makeCompanySettings({ invoice_font_family: 'Source Sans 3' })

    const { branding } = await prepareInvoicePdfRender(company)

    expect(branding.fontFamily).toBe('Source Sans 3')
  })

  it('registers a valid stored custom font under an isolated render family', async () => {
    const bytes = await readFile(
      join(process.cwd(), 'public', 'fonts', 'invoice', 'SourceSans3-Regular.ttf'),
    )
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    )
    fontDownloadMock.mockResolvedValue({
      data: new Blob([arrayBuffer]),
      error: null,
    })
    const company = makeCompanySettings({
      invoice_font_family: 'Custom',
      invoice_custom_font_path: 'company-1/invoice-font-1.ttf',
    })

    const { branding } = await prepareInvoicePdfRender(company)

    expect(branding.fontFamily).toMatch(/^InvoiceCustom-[0-9a-f]{12}$/)
  })

  it('falls back to Helvetica when a custom font cannot be parsed', async () => {
    const corruptedFont = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xff])
    fontDownloadMock.mockResolvedValue({
      data: new Blob([corruptedFont]),
      error: null,
    })
    const company = makeCompanySettings({
      invoice_font_family: 'Custom',
      invoice_custom_font_path: 'company-1/invoice-font-2.ttf',
    })

    const { branding } = await prepareInvoicePdfRender(company)

    expect(branding.fontFamily).toBe('Helvetica')
  })

  it('does not download a custom font from another company path', async () => {
    const company = makeCompanySettings({
      invoice_font_family: 'Custom',
      invoice_custom_font_path: 'company-2/invoice-font-3.ttf',
    })

    const { branding } = await prepareInvoicePdfRender(company)

    expect(fontDownloadMock).not.toHaveBeenCalled()
    expect(branding.fontFamily).toBe('Helvetica')
  })
})

describe('buildPaymentLinkQrDataUrl', () => {
  it('encodes the payment link as a PNG QR data URL for a real invoice', async () => {
    const invoice = makeInvoice({ payment_link_url: 'https://buy.stripe.com/test_abc123' })
    const qr = await buildPaymentLinkQrDataUrl(invoice)
    expect(qr).toMatch(new RegExp(`^${PNG_DATA_URL_PREFIX}`))
  })

  it('returns null when the invoice has no payment link', async () => {
    expect(await buildPaymentLinkQrDataUrl(makeInvoice())).toBeNull()
    expect(await buildPaymentLinkQrDataUrl(makeInvoice({ payment_link_url: '   ' }))).toBeNull()
  })

  it('returns null for non-payable documents (proforma, delivery note, credit note)', async () => {
    const url = 'https://buy.stripe.com/test_abc123'
    expect(
      await buildPaymentLinkQrDataUrl(makeInvoice({ payment_link_url: url, document_type: 'proforma' })),
    ).toBeNull()
    expect(
      await buildPaymentLinkQrDataUrl(makeInvoice({ payment_link_url: url, document_type: 'delivery_note' })),
    ).toBeNull()
    expect(
      await buildPaymentLinkQrDataUrl(makeInvoice({ payment_link_url: url, credited_invoice_id: 'inv-orig' })),
    ).toBeNull()
  })
})

describe('buildSwishQrDataUrl', () => {
  // Spy without replacing the implementation: the payload string is the unit
  // under test (the PNG pixels are qrcode's concern), and the passthrough
  // keeps the returned data URL real. The Swish payload locks the amount
  // (editmask 0), so an amount above "Att betala" makes the customer overpay
  // with no way to correct it in the app.
  let toDataURL: MockInstance

  beforeEach(() => {
    toDataURL = vi.spyOn(QRCode, 'toDataURL')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const company = () => makeCompanySettings({ swish: '1234567890' })

  it('encodes "Att betala" (total minus ROT/RUT deduction), not the invoice total', async () => {
    const invoice = makeInvoice({ total: 1250, deduction_total: 625 })
    const qr = await buildSwishQrDataUrl(company(), invoice)
    expect(qr).toMatch(new RegExp(`^${PNG_DATA_URL_PREFIX}`))
    expect(toDataURL).toHaveBeenCalledWith('C1234567890;625.00;F-2024001;0', expect.anything())
  })

  it('applies öresavrundning before the deduction, same order as the PDF totals block', async () => {
    const invoice = makeInvoice({ total: 1250.49, ore_rounding: true, deduction_total: 625 })
    await buildSwishQrDataUrl(company(), invoice)
    expect(toDataURL).toHaveBeenCalledWith('C1234567890;625.00;F-2024001;0', expect.anything())
  })

  it('renders no QR when the deduction covers the whole invoice (nothing to pay)', async () => {
    const invoice = makeInvoice({ total: 1250, deduction_total: 1250 })
    expect(await buildSwishQrDataUrl(company(), invoice)).toBeNull()
    expect(toDataURL).not.toHaveBeenCalled()
  })

  it('renders no QR for non-payable documents (credit note, proforma, delivery note)', async () => {
    const creditNote = makeInvoice({ total: 1250, deduction_total: 625, credited_invoice_id: 'inv-orig' })
    expect(await buildSwishQrDataUrl(company(), creditNote)).toBeNull()
    expect(await buildSwishQrDataUrl(company(), makeInvoice({ document_type: 'proforma' }))).toBeNull()
    expect(await buildSwishQrDataUrl(company(), makeInvoice({ document_type: 'delivery_note' }))).toBeNull()
    expect(toDataURL).not.toHaveBeenCalled()
  })

  it('keeps the plain total for invoices without a deduction', async () => {
    const invoice = makeInvoice()
    await buildSwishQrDataUrl(company(), invoice)
    expect(toDataURL).toHaveBeenCalledWith('C1234567890;12500.00;F-2024001;0', expect.anything())
  })
})
