import { describe, it, expect } from 'vitest'
import { FOLDER_ORDER, folderFor, groupByFolder, openByDefault } from '../folders'

describe('folderFor', () => {
  it('puts every type on one shelf and the untyped last', () => {
    expect(folderFor('agreement.loan')).toBe('agreements')
    expect(folderFor('registration.bolagsverket')).toBe('authority')
    expect(folderFor('filing.bolagsverket')).toBe('authority')
    expect(folderFor('decision.skatteverket')).toBe('authority')
    expect(folderFor('minutes.agm')).toBe('corporate')
    expect(folderFor('share_subscription_list')).toBe('corporate')
    expect(folderFor('annual_report')).toBe('corporate')
    expect(folderFor('receipt')).toBe('receipts')
    expect(folderFor('supplier_invoice')).toBe('supplier_invoices')
    expect(folderFor('credit_note')).toBe('supplier_invoices')
    expect(folderFor('customer_invoice')).toBe('customer_invoices')
    expect(folderFor('bank_statement')).toBe('bank_statements')
    expect(folderFor('tax_account_statement')).toBe('bank_statements')
    expect(folderFor('other')).toBe('other')
    expect(folderFor(null)).toBe('untyped')
    expect(folderFor('')).toBe('untyped')
  })
})

describe('groupByFolder', () => {
  it('keeps the folder order, leaves empty folders out, and counts the types inside a folder', () => {
    const rows = [
      { id: 1, doc_type: 'receipt' },
      { id: 2, doc_type: null },
      { id: 3, doc_type: 'filing.bolagsverket' },
      { id: 4, doc_type: 'agreement.loan' },
      { id: 5, doc_type: 'filing.bolagsverket' },
      { id: 6, doc_type: 'decision.skatteverket' },
    ]
    const folders = groupByFolder(rows)
    expect(folders.map((f) => f.key)).toEqual(['agreements', 'authority', 'receipts', 'untyped'])
    expect(folders[1].rows.map((r) => r.id)).toEqual([3, 5, 6])
    expect(folders[1].types).toEqual([
      { doc_type: 'filing.bolagsverket', count: 2 },
      { doc_type: 'decision.skatteverket', count: 1 },
    ])
    expect(folders[3].types).toEqual([])
    expect(FOLDER_ORDER.indexOf('untyped')).toBe(FOLDER_ORDER.length - 1)
  })
})

describe('openByDefault', () => {
  it('opens every folder only while small: a large untyped one is history still being read', () => {
    expect(openByDefault('untyped', 200)).toBe(false)
    expect(openByDefault('untyped', 3)).toBe(true)
    expect(openByDefault('agreements', 7)).toBe(true)
    expect(openByDefault('receipts', 174)).toBe(false)
  })
})
