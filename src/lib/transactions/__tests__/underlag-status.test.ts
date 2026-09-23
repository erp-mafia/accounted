import { describe, it, expect } from 'vitest'
import { computeJeUnderlagStatus } from '../underlag-status'

describe('computeJeUnderlagStatus', () => {
  it('marks entries with a current-version document as has', () => {
    const result = computeJeUnderlagStatus(
      [{ id: 'je-1', source_type: 'bank_transaction' }],
      new Set(['je-1']),
      new Set(),
    )
    expect(result['je-1']).toBe('has')
  })

  it('marks doc-requiring entries without documents as missing', () => {
    const result = computeJeUnderlagStatus(
      [
        { id: 'je-1', source_type: 'bank_transaction' },
        { id: 'je-2', source_type: 'manual' },
        { id: 'je-3', source_type: 'import' },
      ],
      new Set(),
      new Set(),
    )
    expect(result).toEqual({ 'je-1': 'missing', 'je-2': 'missing', 'je-3': 'missing' })
  })

  it('flags an inbox booking without a document (#1317)', () => {
    const result = computeJeUnderlagStatus(
      [
        { id: 'je-1', source_type: 'inbox_item' },
        { id: 'je-2', source_type: 'inbox_item' },
      ],
      new Set(['je-2']),
      new Set(),
    )
    expect(result).toEqual({ 'je-1': 'missing', 'je-2': 'has' })
  })

  it('respects journal_entry_no_doc_required exemptions', () => {
    const result = computeJeUnderlagStatus(
      [{ id: 'je-1', source_type: 'manual' }],
      new Set(),
      new Set(['je-1']),
    )
    expect(result['je-1']).toBe('none')
  })

  it('never flags system-generated source types (exempt by omission)', () => {
    const result = computeJeUnderlagStatus(
      [
        { id: 'je-1', source_type: 'vat_settlement' },
        { id: 'je-2', source_type: 'invoice_payment' },
        { id: 'je-3', source_type: 'year_end' },
      ],
      new Set(),
      new Set(),
    )
    expect(result).toEqual({ 'je-1': 'none', 'je-2': 'none', 'je-3': 'none' })
  })

  it('treats null source_type as no statement', () => {
    const result = computeJeUnderlagStatus(
      [{ id: 'je-1', source_type: null }],
      new Set(),
      new Set(),
    )
    expect(result['je-1']).toBe('none')
  })

  it('has wins over missing when both a doc and a needs-doc source type are present', () => {
    const result = computeJeUnderlagStatus(
      [{ id: 'je-1', source_type: 'manual' }],
      new Set(['je-1']),
      new Set(['je-1']),
    )
    expect(result['je-1']).toBe('has')
  })
})
