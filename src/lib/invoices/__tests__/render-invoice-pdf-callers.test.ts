/**
 * Every invoice PDF goes through ONE render entry point
 * (lib/invoices/render-invoice-pdf.ts), so no surface can print a different
 * QR code, payee or branding than another. This pins it structurally: each
 * known render site calls renderInvoicePdfBuffer, and nothing outside the
 * entry point draws InvoicePDF or builds a payment QR image of its own.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const ENTRY_POINT = 'src/lib/invoices/render-invoice-pdf.ts'

/** Every surface that produces an invoice PDF. */
const RENDER_SITES = [
  'src/app/api/invoices/[id]/send/route.ts',
  'src/app/api/v1/companies/[companyId]/invoices/[id]/send/route.ts',
  'src/app/api/invoices/[id]/pdf/route.ts',
  'src/app/api/v1/companies/[companyId]/invoices/[id]/pdf/route.ts',
  'src/app/api/invoices/[id]/send-payment-confirmation/route.ts',
  'src/app/api/invoices/preview-pdf/route.ts',
  'src/lib/pending-operations/commit.ts',
  'src/lib/invoices/issue-and-book-invoice.ts',
  'src/lib/invoices/recurring-schedule-service.ts',
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(relative(ROOT, path))
    }
  }
  return out
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

describe('invoice PDF render entry point', () => {
  it.each(RENDER_SITES)('%s renders through renderInvoicePdfBuffer', (file) => {
    const source = read(file)
    expect(source).toContain("from '@/lib/invoices/render-invoice-pdf'")
    expect(source).toMatch(/renderInvoicePdfBuffer\(/)
    expect(source).not.toMatch(/\bInvoicePDF\(/)
  })

  it('draws InvoicePDF and builds payment QR images nowhere else', () => {
    const offenders = sourceFiles(join(ROOT, 'src'))
      .filter((file) => file !== ENTRY_POINT)
      .filter((file) => {
        const source = read(file)
        return (
          /\bInvoicePDF\(/.test(source.replace(/export function InvoicePDF\(/, '')) ||
          /buildSwishQrDataUrl|buildPaymentLinkQrDataUrl|buildInvoicePaymentQrImage/.test(source)
        )
      })
    expect(offenders).toEqual([])
  })
})
