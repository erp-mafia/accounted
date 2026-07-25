/**
 * Where the company logo lands in the invoice header.
 *
 * The logo box is always drawn at the full 240x80pt reserved area (any logo
 * larger than that gets clamped to it), so the image itself is positioned
 * *inside* that box by objectFit/objectPosition. With the default centering,
 * a near-square logo scaled down to fit 80pt of height ends up indented by
 * half the leftover width, which reads as "the logo is not aligned with the
 * left margin" while a wide banner logo looks fine. The template therefore
 * anchors the image top-left, so every aspect ratio starts at the margin.
 *
 * This test renders the real PDF and reads the image placement matrix out of
 * the content stream, so it fails if the anchoring regresses.
 */

import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

// The page uses a 40pt left margin; a left-anchored logo starts exactly there.
const PAGE_MARGIN_PT = 40

async function makeLogoDataUrl(width: number, height: number): Promise<string> {
  const { default: sharp } = await import('sharp')
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 80, b: 160 } },
  })
    .png()
    .toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

/**
 * Pull the placement of the first drawn image out of a rendered PDF.
 *
 * pdfkit emits `<w> 0 0 <-h> <x> <y> cm` followed by `/<label> Do` for every
 * image, where x is relative to the enclosing translations. The logo box sits
 * at the page margin via a plain `1 0 0 1 <tx> <ty> cm`, so the absolute left
 * edge of the drawn image is that translation plus the matrix offset.
 */
function firstImagePlacement(pdf: Buffer): { x: number; width: number } {
  const raw = pdf.toString('latin1')
  const streams: string[] = []
  const re = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue
    const bytes = Buffer.from(raw.slice(start, end), 'latin1')
    try {
      streams.push(inflateSync(bytes).toString('latin1'))
    } catch {
      streams.push(bytes.toString('latin1'))
    }
  }

  const placement = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*\/\w+ Do/
  for (const stream of streams) {
    const hit = placement.exec(stream)
    if (!hit) continue

    let translated = 0
    const translate = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g
    let step: RegExpExecArray | null
    while ((step = translate.exec(stream)) !== null && step.index < hit.index) {
      translated += Number(step[1])
    }

    return { width: Number(hit[1]), x: translated + Number(hit[3]) }
  }
  throw new Error('no image draw found in the rendered PDF')
}

async function renderWithLogo(logoWidth: number, logoHeight: number): Promise<Buffer> {
  const company = makeCompanySettings({
    logo_url: await makeLogoDataUrl(logoWidth, logoHeight),
    invoice_show_logo: true,
  })
  const invoice = makeInvoice({ status: 'sent', invoice_number: '2026-0001' })
  const items: InvoiceItem[] = [
    {
      id: 'item-1',
      invoice_id: invoice.id,
      sort_order: 0,
      line_type: 'product',
      description: 'Consulting',
      quantity: 1,
      unit: 'st',
      unit_price: 1000,
      line_total: 1000,
      vat_rate: 25,
      vat_amount: 250,
      created_at: '2026-01-15T00:00:00Z',
    },
  ]

  return renderToBuffer(
    React.createElement(InvoicePDF, {
      invoice,
      customer: makeCustomer(),
      items,
      company,
    }),
  )
}

describe('invoice PDF logo placement', () => {
  it('starts a wide banner logo at the left margin', async () => {
    const placement = firstImagePlacement(await renderWithLogo(600, 160))

    expect(placement.x).toBeCloseTo(PAGE_MARGIN_PT, 1)
  }, 30_000)

  it('starts a near-square logo at the left margin too', async () => {
    // Scaled to the 80pt height cap this logo is only ~117pt wide, so it used
    // to be centred in the 240pt box and printed ~60pt in from the margin.
    const placement = firstImagePlacement(await renderWithLogo(1500, 1024))

    expect(placement.width).toBeLessThan(200)
    expect(placement.x).toBeCloseTo(PAGE_MARGIN_PT, 1)
  }, 30_000)
})
