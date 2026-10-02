import { describe, it, expect } from 'vitest'
import {
  isFullBleedEditorPath,
  legacyListEditorHref,
  newEditorHref,
  parseNewEditorParams,
} from '@/lib/invoices/editor/new-editor-params'

describe('parseNewEditorParams', () => {
  it('reads the document type', () => {
    for (const type of ['invoice', 'proforma', 'quote', 'delivery_note'] as const) {
      expect(parseNewEditorParams({ type })).toEqual({ documentType: type, selfBilled: false, copyFromId: null })
    }
  })

  it('reads a received självfaktura', () => {
    expect(parseNewEditorParams({ type: 'self_billed' })).toEqual({
      documentType: null,
      selfBilled: true,
      copyFromId: null,
    })
  })

  it('keeps the legacy list flags working', () => {
    expect(parseNewEditorParams(new URLSearchParams('new=1&quote=1')).documentType).toBe('quote')
    expect(parseNewEditorParams(new URLSearchParams('new=1&proforma=1')).documentType).toBe('proforma')
    expect(parseNewEditorParams(new URLSearchParams('new=1&self=1')).selfBilled).toBe(true)
  })

  it('a copy is a plain new invoice from the source', () => {
    expect(parseNewEditorParams({ copy: 'inv-1', type: 'quote' })).toEqual({
      documentType: null,
      selfBilled: false,
      copyFromId: 'inv-1',
    })
  })

  it('ignores an unknown type and repeated params', () => {
    expect(parseNewEditorParams({ type: 'receipt' }).documentType).toBeNull()
    expect(parseNewEditorParams({ type: ['quote', 'proforma'] }).documentType).toBe('quote')
  })
})

describe('newEditorHref', () => {
  it('builds the editor URL', () => {
    expect(newEditorHref()).toBe('/invoices/new')
    expect(newEditorHref({ type: 'invoice' })).toBe('/invoices/new')
    expect(newEditorHref({ type: 'quote' })).toBe('/invoices/new?type=quote')
    expect(newEditorHref({ type: 'self_billed' })).toBe('/invoices/new?type=self_billed')
    expect(newEditorHref({ copyFromId: 'inv-1' })).toBe('/invoices/new?copy=inv-1')
  })
})

describe('legacyListEditorHref', () => {
  it('rewrites the old list-dialog links', () => {
    expect(legacyListEditorHref(new URLSearchParams('new=1'))).toBe('/invoices/new')
    expect(legacyListEditorHref(new URLSearchParams('status=draft&new=1&quote=1'))).toBe('/invoices/new?type=quote')
    expect(legacyListEditorHref(new URLSearchParams('new=1&self=1'))).toBe('/invoices/new?type=self_billed')
    expect(legacyListEditorHref(new URLSearchParams('copy=inv-1'))).toBe('/invoices/new?copy=inv-1')
  })

  it('leaves a plain list URL alone', () => {
    expect(legacyListEditorHref(new URLSearchParams('status=draft'))).toBeNull()
  })
})

describe('isFullBleedEditorPath', () => {
  it('matches the new, edit and credit editor routes', () => {
    expect(isFullBleedEditorPath('/invoices/new')).toBe(true)
    expect(isFullBleedEditorPath('/invoices/8a1c/edit')).toBe(true)
    expect(isFullBleedEditorPath('/invoices/8a1c/credit')).toBe(true)
  })

  it('leaves the list and the detail page padded', () => {
    expect(isFullBleedEditorPath('/invoices')).toBe(false)
    expect(isFullBleedEditorPath('/invoices/8a1c')).toBe(false)
    expect(isFullBleedEditorPath('/invoices/recurring/new')).toBe(false)
  })
})
