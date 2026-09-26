import { describe, it, expect } from 'vitest'
import { FOLDER_ORDER, folderFor, folderQuery, foldersFromCounts, openByDefault } from '../folders'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'

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

describe('openByDefault', () => {
  it('opens every folder only while small: a large untyped one is history still being read', () => {
    expect(openByDefault('untyped', 200)).toBe(false)
    expect(openByDefault('untyped', 3)).toBe(true)
    expect(openByDefault('agreements', 7)).toBe(true)
    expect(openByDefault('receipts', 174)).toBe(false)
  })
})

describe('folderQuery', () => {
  it('asks every folder for exactly its own types, the other folder for everything no folder names, the untyped for no type', () => {
    expect(folderQuery('receipts')).toEqual({ mode: 'in', types: ['receipt'] })
    expect(folderQuery('supplier_invoices').types).toEqual(expect.arrayContaining(['supplier_invoice', 'credit_note']))
    expect(folderQuery('untyped')).toEqual({ mode: 'untyped', types: null })
    const other = folderQuery('other')
    expect(other.mode).toBe('not_in')
    // Every known type lands in exactly one folder: the other folder excludes all the rest and nothing of its own.
    for (const t of DOC_TYPES) expect(other.types?.includes(t)).toBe(folderFor(t) !== 'other')
  })
})

describe('foldersFromCounts', () => {
  it('sums the database counts into folders in order, the mix most common first, empty folders left out', () => {
    const folders = foldersFromCounts([
      { doc_type: 'credit_note', n: 2 },
      { doc_type: 'supplier_invoice', n: 30 },
      { doc_type: null, n: 5 },
      { doc_type: 'receipt', n: 0 },
    ])
    expect(folders.map((f) => [f.key, f.count])).toEqual([
      ['supplier_invoices', 32],
      ['untyped', 5],
    ])
    expect(folders[0].types).toEqual([
      { doc_type: 'supplier_invoice', count: 30 },
      { doc_type: 'credit_note', count: 2 },
    ])
    expect(folders[1].types).toEqual([])
  })
})

