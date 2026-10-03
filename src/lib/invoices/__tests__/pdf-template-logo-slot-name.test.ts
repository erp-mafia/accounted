/**
 * Without a logo, the identity band's logo slot carries the company name.
 * The fixed layout has no switch for it: the "Visa företagsnamn" setting and
 * its placement control were removed, so a stored invoice_show_company_name
 * = false must not leave the slot empty.
 */
import { describe, expect, it } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { pdfTextStrings } from '@/tests/pdf-text'

async function nameCount(showCompanyName: boolean): Promise<number> {
  const company = makeCompanySettings({
    company_name: 'Slotnamn Konsult AB',
    logo_url: null,
    invoice_show_company_name: showCompanyName,
  })
  const pdf = await renderToBuffer(
    InvoicePDF({ invoice: makeInvoice({ invoice_number: '1043' }), customer: makeCustomer(), items: [], company }),
  )
  const text = pdfTextStrings(pdf).join('\n')
  return text.split('Slotnamn Konsult AB').length - 1
}

describe('logo slot without a logo', () => {
  it('prints the company name even when the old switch is stored as off', async () => {
    expect(await nameCount(false)).toBe(await nameCount(true))
  })
})
