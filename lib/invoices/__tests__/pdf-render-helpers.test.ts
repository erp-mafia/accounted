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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { prepareInvoicePdfRender, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { makeCompanySettings, makeInvoice } from '@/tests/helpers'

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
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
          h.toLowerCase() === 'content-length' ? String(6 * 1024 * 1024) : 'image/png',
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
