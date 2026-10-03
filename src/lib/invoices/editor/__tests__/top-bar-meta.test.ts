import { describe, it, expect } from 'vitest'
import {
  numberingMoment,
  resolveTopBarMeta,
  type TopBarMetaInput,
} from '@/lib/invoices/editor/top-bar-meta'

function input(overrides: Partial<TopBarMetaInput> = {}): TopBarMetaInput {
  return {
    selfBilled: false,
    copyOf: null,
    savedAt: null,
    documentType: 'invoice',
    preliminaryNumber: null,
    ...overrides,
  }
}

describe('numberingMoment', () => {
  it('numbers a faktura and a proforma when they are issued', () => {
    expect(numberingMoment('invoice')).toBe('send')
    expect(numberingMoment('proforma')).toBe('send')
  })

  it('numbers a quote and a följesedel when they are saved', () => {
    expect(numberingMoment('quote')).toBe('save')
    expect(numberingMoment('delivery_note')).toBe('save')
  })
})

describe('resolveTopBarMeta', () => {
  it('says "Utkast" and the number a new faktura gets when sent', () => {
    expect(resolveTopBarMeta(input({ preliminaryNumber: '004' }))).toEqual([
      { key: 'meta_draft' },
      { key: 'meta_number_on_send', values: { number: '004' } },
    ])
  })

  it('says a new quote gets its number when it is saved', () => {
    expect(resolveTopBarMeta(input({ documentType: 'quote', preliminaryNumber: 'OF-001' }))).toEqual([
      { key: 'meta_draft' },
      { key: 'meta_number_on_save', values: { number: 'OF-001' } },
    ])
  })

  it('says just "Utkast" when no number is known', () => {
    expect(resolveTopBarMeta(input())).toEqual([{ key: 'meta_draft' }])
    expect(resolveTopBarMeta(input({ preliminaryNumber: '  ' }))).toEqual([{ key: 'meta_draft' }])
    expect(resolveTopBarMeta(input({ documentType: 'delivery_note' }))).toEqual([{ key: 'meta_draft' }])
  })

  it('keeps the saved time of a numbered draft in edit mode, with no number clause', () => {
    // A numbered draft passes no preliminary number: its own is on the PDF.
    expect(resolveTopBarMeta(input({ savedAt: '09:12' }))).toEqual([
      { key: 'meta_saved', values: { time: '09:12' } },
    ])
  })

  it('adds the number an unnumbered saved draft gets when sent', () => {
    expect(resolveTopBarMeta(input({ savedAt: '09:12', preliminaryNumber: '004' }))).toEqual([
      { key: 'meta_saved', values: { time: '09:12' } },
      { key: 'meta_number_on_send', values: { number: '004' } },
    ])
  })

  it('names the copied document first', () => {
    expect(resolveTopBarMeta(input({ copyOf: '003', preliminaryNumber: '004' }))).toEqual([
      { key: 'meta_copy', values: { number: '003' } },
      { key: 'meta_number_on_send', values: { number: '004' } },
    ])
  })

  it('shows nothing for a received självfaktura', () => {
    expect(resolveTopBarMeta(input({ selfBilled: true, preliminaryNumber: '004' }))).toEqual([])
  })
})
