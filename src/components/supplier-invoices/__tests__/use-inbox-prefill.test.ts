import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { InvoiceExtractionResult } from '@/types'
import { useInboxPrefill, type InboxItemData } from '../use-inbox-prefill'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

type Apply = (item: InboxItemData) => boolean

/** The hook's applyInboxItem, handed out of one server render. */
function captureApply(onInvoiceTotal: (total: number) => void): Apply {
  const applies: Apply[] = []
  function Harness({ sink }: { sink: Apply[] }) {
    const { applyInboxItem } = useInboxPrefill({
      inboxItemId: null,
      suppliersLoaded: true,
      suppliers: [],
      setValue: vi.fn(),
      replace: vi.fn(),
      reset: vi.fn(),
      getValues: vi.fn(() => ({})) as never,
      toast: vi.fn() as never,
      t: ((key: string) => key) as never,
      onInvoiceTotal,
    })
    sink.push(applyInboxItem)
    return null
  }
  renderToStaticMarkup(createElement(Harness, { sink: applies }))
  if (!applies[0]) throw new Error('not rendered')
  return applies[0]
}

const item = (extracted: Partial<InvoiceExtractionResult>): InboxItemData => ({
  id: 'inbox-1',
  matched_supplier_id: null,
  document_id: 'doc-1',
  extracted_data: extracted as InvoiceExtractionResult,
})

describe('useInboxPrefill', () => {
  it('hands the billed total to Fakturabelopp, so an inbox arrival gets its öresavrundning (crm#1595)', () => {
    const onInvoiceTotal = vi.fn()
    const apply = captureApply(onInvoiceTotal)
    // The reading of the invoice in the report: 4 990 + 299,40 moms, billed 5 289 after rounding -0,40.
    apply(item({
      totals: { total: 5289, subtotal: 4990, vatAmount: 299.4, roundingAmount: -0.4 },
      lineItems: [{ description: 'E-bok', quantity: 1, unitPrice: 4990, lineTotal: 4990, vatRate: 6 }],
    } as unknown as Partial<InvoiceExtractionResult>))
    expect(onInvoiceTotal).toHaveBeenCalledWith(5289)
  })

  it('hands nothing on when the reading has no total', () => {
    const onInvoiceTotal = vi.fn()
    const apply = captureApply(onInvoiceTotal)
    apply(item({ totals: { total: null, subtotal: null, vatAmount: null } } as unknown as Partial<InvoiceExtractionResult>))
    expect(onInvoiceTotal).not.toHaveBeenCalled()
  })
})
