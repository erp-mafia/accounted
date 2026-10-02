import { describe, it, expect } from 'vitest'
import {
  pageSplitCause,
  resolveEditorStatusLine,
  type StatusLineInput,
} from '@/lib/invoices/editor/status-line'

type Step = { kind: 'ready' } | { kind: 'customer' } | { kind: 'rows_empty' }

function input(overrides: Partial<StatusLineInput<Step>> = {}): StatusLineInput<Step> {
  return {
    nextStep: { kind: 'ready' },
    missing: [],
    documentType: 'invoice',
    pageCount: 1,
    previewFailed: false,
    notes: '',
    productRowCount: 3,
    hasDeduction: false,
    ...overrides,
  }
}

describe('resolveEditorStatusLine', () => {
  it('shows nothing for a complete one-page invoice', () => {
    expect(resolveEditorStatusLine(input())).toEqual({ kind: 'none' })
  })

  it('names the first missing field before anything else', () => {
    expect(
      resolveEditorStatusLine(input({ nextStep: { kind: 'customer' }, missing: ['customer', 'payee'], pageCount: 2 })),
    ).toEqual({ kind: 'step', step: { kind: 'customer' } })
  })

  it('then a faktura without payment details', () => {
    expect(resolveEditorStatusLine(input({ missing: ['payee'] }))).toEqual({ kind: 'payee_missing' })
  })

  it('does not ask a quote, proforma or följesedel for payment details', () => {
    for (const documentType of ['quote', 'proforma', 'delivery_note'] as const) {
      expect(resolveEditorStatusLine(input({ documentType, missing: ['payee'] }))).toEqual({ kind: 'none' })
    }
  })

  it('reports a failed preview refresh', () => {
    expect(resolveEditorStatusLine(input({ previewFailed: true }))).toEqual({ kind: 'preview_failed' })
  })

  it('explains a page split', () => {
    expect(resolveEditorStatusLine(input({ pageCount: 2, notes: 'x'.repeat(800) }))).toEqual({
      kind: 'split',
      pages: 2,
      cause: 'note',
    })
    expect(resolveEditorStatusLine(input({ pageCount: 3, productRowCount: 40 }))).toEqual({
      kind: 'split',
      pages: 3,
      cause: 'rows',
    })
  })

  it('is quiet before the first render', () => {
    expect(resolveEditorStatusLine(input({ pageCount: null }))).toEqual({ kind: 'none' })
  })
})

describe('pageSplitCause', () => {
  it('blames a long note first (by length or by line count)', () => {
    expect(pageSplitCause({ notes: 'x'.repeat(501), productRowCount: 30, hasDeduction: true })).toBe('note')
    expect(pageSplitCause({ notes: 'a\nb\nc\nd\ne\nf\ng', productRowCount: 1, hasDeduction: false })).toBe('note')
  })

  it('then many rows, then the deduction box', () => {
    expect(pageSplitCause({ notes: 'Tack!', productRowCount: 13, hasDeduction: true })).toBe('rows')
    expect(pageSplitCause({ notes: '', productRowCount: 4, hasDeduction: true })).toBe('deduction')
  })

  it('names no cause it cannot see', () => {
    expect(pageSplitCause({ notes: '', productRowCount: 4, hasDeduction: false })).toBeNull()
  })
})
