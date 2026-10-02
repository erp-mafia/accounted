/**
 * The invoice PDF of a grön teknik invoice carries what Skatteverket lists
 * for the invoice ("Så fungerar skattereduktionen för grön teknik", företag,
 * checked 2026-09-30): the total and the reduction incl. moms, the cost of
 * the installation (arbete och material) apart from övriga kostnader, the
 * type of work, the F-skatt statement, the buyer, and the fastighets-
 * beteckning or the förening's orgnr with the lägenhetsnummer. ROT/RUT
 * invoices render exactly as before.
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { Font, pdf } from '@react-pdf/renderer'
import layoutDocument from '@react-pdf/layout'
import { GRON_TEKNIK_BASE_NOTICE, InvoicePDF, type InvoicePdfInvoice } from '@/lib/invoices/pdf-template'
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

interface LaidOutNode {
  type: string
  value?: string
  box?: { top: number; left: number; width: number; height: number }
  children?: LaidOutNode[]
}

async function layOut(element: ReactElement): Promise<LaidOutNode[]> {
  const instance = pdf(element as Parameters<typeof pdf>[0]) as unknown as { container: { document: unknown } }
  const layout = layoutDocument as unknown as (document: unknown, fontStore: unknown) => Promise<LaidOutNode>
  const root = await layout(instance.container.document, Font)
  return root.children ?? []
}

function textOf(node: LaidOutNode): string {
  let out = node.type === 'TEXT_INSTANCE' ? (node.value ?? '') : ''
  for (const child of node.children ?? []) out += textOf(child)
  return out
}

function expectNothingPastThePageEdge(pages: LaidOutNode[]) {
  for (const page of pages) {
    const pageHeight = page.box!.height
    const visit = (node: LaidOutNode, offset: number) => {
      const top = offset + (node.box?.top ?? 0)
      if (node.type === 'TEXT' && node.box) {
        expect(top + node.box.height, `"${textOf(node).slice(0, 40)}" ends past the page edge`).toBeLessThanOrEqual(pageHeight + 0.5)
      }
      for (const child of node.children ?? []) visit(child, top)
    }
    for (const child of page.children ?? []) visit(child, 0)
  }
}

const PNR = '199110306645'

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-labour',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Montage solceller',
    quantity: 1,
    unit: 'st',
    unit_price: 20000,
    line_total: 20000,
    vat_rate: 25,
    vat_amount: 5000,
    deduction_type: 'gron_teknik',
    deduction_amount: 3750,
    labor_hours: 24,
    work_type: 'INSTALLATION_SOLCELLER',
    housing_designation: 'Exempelby 1:1',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

const gronItems = (): InvoiceItem[] => [
  item(),
  item({
    id: 'item-material',
    sort_order: 1,
    description: 'Solpaneler och växelriktare',
    unit_price: 60000,
    line_total: 60000,
    vat_amount: 15000,
    deduction_amount: 11250,
    labor_hours: null,
  }),
  item({
    id: 'item-travel',
    sort_order: 2,
    description: 'Resa',
    unit_price: 1000,
    line_total: 1000,
    vat_amount: 250,
    deduction_type: null,
    deduction_amount: 0,
    labor_hours: null,
    work_type: null,
    housing_designation: null,
  }),
]

function gronInvoice(overrides: Partial<InvoicePdfInvoice> = {}): InvoicePdfInvoice {
  return {
    ...makeInvoice({
      status: 'sent',
      invoice_number: '1001',
      subtotal: 81000,
      vat_amount: 20250,
      total: 101250,
      vat_rate: 25,
    }),
    deduction_total: 15000,
    deduction_personnummer_encrypted: encryptPersonnummer(PNR),
    deduction_personnummer_last4: PNR.slice(-4),
    ...overrides,
  }
}

const company = makeCompanySettings({ f_skatt: true })
const customer = makeCustomer({ name: 'Kund Privat' })

function render(invoice: InvoicePdfInvoice, items: InvoiceItem[], language?: 'sv' | 'en'): string {
  return textLeaves(InvoicePDF({ invoice, customer, items, company, language })).join('\n')
}

describe('invoice PDF: grön teknik', () => {
  it('states the total and the reduction incl. moms, the buyer and the F-skatt approval', () => {
    const text = render(gronInvoice(), gronItems())
    expect(text).toContain('Totalt inkl. moms:')
    expect(text).toContain('Skattereduktion grön teknik:')
    expect(text).not.toContain('Skattereduktion ROT/RUT:')
    expect(text).toContain('Kund Privat')
    expect(text).toContain('19911030-XXXX')
    expect(text).toContain('Godkänd för F-skatt')
    expect(text).toContain('Fastighetsbeteckning:')
    expect(text).toContain('Exempelby 1:1')
  })

  it('separates the installation cost from övriga kostnader and names the type of work', () => {
    const text = render(gronInvoice(), gronItems())
    expect(text).toContain('Arbete och material:')
    expect(text).toContain('Övriga kostnader:')
    expect(text).toMatch(/100\s000,00 SEK inkl\. moms/)
    expect(text).toMatch(/1\s250,00 SEK inkl\. moms/)
    expect(text).toContain('Grön teknik, Installation av solceller: Montage solceller')
    expect(text).toContain('Grön teknik, Installation av solceller: Solpaneler och växelriktare')
  })

  it('replaces the labour-only notice with what the grön teknik base covers', () => {
    const text = render(gronInvoice(), gronItems())
    expect(text).toContain(GRON_TEKNIK_BASE_NOTICE)
    expect(text).not.toContain('Endast arbetskostnad har inkluderats')
  })

  it('says the seller requests the payout, never the buyer (fakturamodellen)', () => {
    const text = render(gronInvoice(), gronItems())
    expect(text).toContain('Säljaren begär utbetalningen från Skatteverket när köparen har betalat sin del')
    expect(text).not.toContain('Köparen ansöker')
    expect(render(gronInvoice(), gronItems(), 'en')).toContain('The seller requests the payout from Skatteverket')
  })

  it('separates the cost per installation type when there are several', () => {
    const items = [
      ...gronItems(),
      item({
        id: 'item-battery',
        sort_order: 3,
        description: 'Batterilager',
        unit_price: 40000,
        line_total: 40000,
        vat_amount: 10000,
        deduction_amount: 25000,
        labor_hours: 8,
        work_type: 'INSTALLATION_LAGRING',
      }),
    ]
    const text = render(gronInvoice({ deduction_total: 40000 }), items)
    expect(text).toMatch(/Installation av solceller: 100\s000,00 SEK inkl\. moms/)
    expect(text).toMatch(/Installation av system för lagring av egenproducerad elenergi: 50\s000,00 SEK inkl\. moms/)
    // One installation type keeps the single sum.
    expect(render(gronInvoice(), gronItems())).not.toMatch(/Installation av solceller: 100/)
  })

  it('prints the förening orgnr with the lägenhetsnummer for a bostadsrätt', () => {
    const items = gronItems().map((i) =>
      i.deduction_type ? { ...i, housing_designation: null, apartment_number: '1201', brf_org_number: '799900-0040' } : i,
    )
    const text = render(gronInvoice(), items)
    expect(text).toContain('Lägenhetsnummer:')
    expect(text).toContain('1201')
    expect(text).toContain('Bostadsrättsföreningens org.nr:')
    expect(text).toContain('799900-0040')
  })

  it('translates the chrome on an English invoice', () => {
    const text = render(gronInvoice(), gronItems(), 'en')
    expect(text).toContain('Total incl. VAT:')
    expect(text).toContain('Green technology tax reduction:')
    expect(text).toContain('Labor and material:')
    expect(text).toContain('Green technology, Installation av solceller: Montage solceller')
  })

  it('leaves a ROT invoice as it was: no total incl. moms row, no bostadsrättsförening row', () => {
    const rotItems = [
      item({ deduction_type: 'rot', work_type: 'EL', deduction_amount: 7500, housing_designation: null, apartment_number: '1201', brf_org_number: '799900-0040' }),
    ]
    const text = render(gronInvoice({ deduction_total: 7500, subtotal: 20000, vat_amount: 5000, total: 25000 }), rotItems)
    expect(text).toContain('Skattereduktion ROT/RUT:')
    expect(text).not.toContain('Totalt inkl. moms:')
    expect(text).not.toContain('Bostadsrättsföreningens org.nr:')
    expect(text).not.toContain('Arbete och material:')
    expect(text).toContain('Endast arbetskostnad har inkluderats')
    expect(text).toContain('ROT, EL: Montage solceller')
  })

  it('a long grön teknik breakdown splits instead of running past the page edge', async () => {
    const many = Array.from({ length: 36 }, (_, i) =>
      item({ id: `row-${i}`, sort_order: i, description: `Solpanel ${i + 1}\nMontage på tak`, labor_hours: i === 0 ? 24 : null }),
    )
    const pages = await layOut(InvoicePDF({ invoice: gronInvoice(), customer, items: many, company }))
    expectNothingPastThePageEdge(pages)
    expect(pages.map(textOf).join('')).toContain('Solpanel 36')
  })
})
