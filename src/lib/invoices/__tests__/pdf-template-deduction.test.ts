/**
 * The ROT/RUT deduction box on the invoice PDF prints the buyer's
 * personnummer as YYYYMMDD-XXXX (birth date visible, last four hidden): the
 * same convention as the payroll roster and the invoice detail page. The
 * template derives it from the stored ciphertext, or takes an already-masked
 * value from the caller (the preview route has only plaintext), and drops the
 * row when neither yields anything rather than failing the render.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'

/** Every string leaf in the element tree, in document order. */
function textLeaves(node: ReactNode, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textLeaves(child, out)
    return out
  }
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.props) textLeaves(element.props.children, out)
  return out
}

function renderText(invoice: InvoicePdfInvoice): string {
  const items: InvoiceItem[] = [
    {
      id: 'item-1',
      invoice_id: invoice.id,
      sort_order: 0,
      line_type: 'product',
      description: 'Städning',
      quantity: 4,
      unit: 'tim',
      unit_price: 500,
      line_total: 2000,
      vat_rate: 25,
      vat_amount: 500,
      deduction_type: 'rut',
      deduction_amount: 1250,
      labor_hours: 4,
      work_type: 'STAD',
      created_at: '2026-01-15T00:00:00Z',
    },
  ]
  const tree = InvoicePDF({
    invoice,
    customer: makeCustomer(),
    items,
    company: makeCompanySettings(),
  })
  return textLeaves(tree).join('\n')
}

const rutInvoice = (overrides: Partial<InvoicePdfInvoice>): InvoicePdfInvoice => ({
  ...makeInvoice({ status: 'sent', invoice_number: '2026-0001', total: 2500 }),
  deduction_total: 1250,
  ...overrides,
})

describe('invoice PDF deduction box personnummer', () => {
  it('derives YYYYMMDD-XXXX from the stored ciphertext', () => {
    const text = renderText(
      rutInvoice({
        deduction_personnummer_encrypted: encryptPersonnummer('199001012385'),
        deduction_personnummer_last4: '2385',
      }),
    )

    expect(text).toContain('Underlag för skattereduktion')
    expect(text).toContain('19900101-XXXX')
    expect(text).not.toContain('XXXXXXXX-2385')
    expect(text).not.toContain('2385')
  })

  it('prints an already-masked value passed by the caller (preview has no ciphertext)', () => {
    const text = renderText(rutInvoice({ deduction_personnummer_masked: '19850716-XXXX' }))

    expect(text).toContain('19850716-XXXX')
  })

  it('omits the personnummer row, and still renders the box, when the ciphertext cannot be read', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const text = renderText(
        rutInvoice({
          deduction_personnummer_encrypted: 'deadbeef'.repeat(10),
          deduction_personnummer_last4: '2385',
        }),
      )

      expect(text).toContain('Underlag för skattereduktion')
      expect(text).not.toContain('Personnummer:')
      expect(text).not.toContain('2385')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('never falls back to the last four digits alone', () => {
    const text = renderText(rutInvoice({ deduction_personnummer_last4: '2385' }))

    expect(text).not.toContain('Personnummer:')
    expect(text).not.toContain('2385')
  })
})
