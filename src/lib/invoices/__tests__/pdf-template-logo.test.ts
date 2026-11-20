/**
 * Where the company logo lands in the invoice header.
 *
 * The logo box is always drawn at the full logo slot of the identity band
 * (LOGO_SLOT_WIDTH_PT x LOGO_SLOT_HEIGHT_PT), and the image is scaled to fit
 * *inside* it by objectFit/objectPosition. With the default centering,
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
import { LOGO_SLOT_WIDTH_PT } from '@/lib/invoices/pdf/geometry'
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
 * image, where x is relative to the enclosing translations. The logo sits
 * inside nested `1 0 0 1 <tx> <ty> cm` translations, each scoped by a q/Q
 * (save/restore) pair, so the absolute left edge of the drawn image is the
 * sum of the translations still in effect, plus the matrix offset.
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

  const op = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*\/\w+ Do|1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm|(?<![\w/])([qQ])(?![\w])/g
  for (const stream of streams) {
    if (!/\/\w+ Do/.test(stream)) continue
    const stack: number[] = []
    let translated = 0
    let step: RegExpExecArray | null
    while ((step = op.exec(stream)) !== null) {
      if (step[1] !== undefined) {
        op.lastIndex = 0
        return { width: Number(step[1]), x: translated + Number(step[3]) }
      }
      if (step[5] !== undefined) translated += Number(step[5])
      else if (step[7] === 'q') stack.push(translated)
      else if (step[7] === 'Q') translated = stack.pop() ?? 0
    }
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
    // Scaled into the slot, never cropped by it.
    expect(placement.width).toBeLessThanOrEqual(LOGO_SLOT_WIDTH_PT + 0.5)
    expect(placement.width).toBeGreaterThan(LOGO_SLOT_WIDTH_PT - 1)
  }, 30_000)

  it('starts a near-square logo at the left margin too', async () => {
    // Scaled into the logo slot this logo is far narrower than the slot, so
    // centred it would print well in from the margin.
    const placement = firstImagePlacement(await renderWithLogo(1500, 1024))

    expect(placement.width).toBeLessThan(200)
    expect(placement.x).toBeCloseTo(PAGE_MARGIN_PT, 1)
  }, 30_000)
})
