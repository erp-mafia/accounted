import { describe, it, expect } from 'vitest'
import { isImportedTransaction } from '@/lib/transactions/origin'

describe('isImportedTransaction', () => {
  describe('imported (ignore-only, never deletable)', () => {
    it('treats a row with a live bank connection as imported', () => {
      expect(isImportedTransaction({ bank_connection_id: 'bc-1', import_source: null })).toBe(true)
    })

    it('treats a row with a bank connection as imported even if import_source looks in-app', () => {
      // The bank link wins: a PSD2 row is imported regardless of the source tag.
      expect(isImportedTransaction({ bank_connection_id: 'bc-1', import_source: 'manual' })).toBe(true)
    })

    it('treats Enable Banking sync rows as imported', () => {
      expect(isImportedTransaction({ bank_connection_id: null, import_source: 'enable_banking' })).toBe(true)
    })

    it('treats CAMT053 bank-file imports as imported', () => {
      expect(isImportedTransaction({ bank_connection_id: null, import_source: 'camt053' })).toBe(true)
    })

    it.each(['csv_nordea', 'csv_lunar', 'csv_seb'])(
      'treats CSV bank-file import %s as imported',
      (source) => {
        expect(isImportedTransaction({ bank_connection_id: null, import_source: source })).toBe(true)
      },
    )

    it('treats an unknown future import source as imported (safe default)', () => {
      expect(isImportedTransaction({ bank_connection_id: null, import_source: 'some_new_feed' })).toBe(true)
    })
  })

  describe('user-created (deletable when unbooked)', () => {
    it('treats a null source with no bank link as user-created (manual add)', () => {
      expect(isImportedTransaction({ bank_connection_id: null, import_source: null })).toBe(false)
    })

    it('treats create-from-document (manual) as user-created', () => {
      expect(isImportedTransaction({ bank_connection_id: null, import_source: 'manual' })).toBe(false)
    })

    it('treats MCP/agent-created rows as user-created', () => {
      expect(isImportedTransaction({ bank_connection_id: null, import_source: 'mcp' })).toBe(false)
    })

    it('tolerates omitted (undefined) origin fields', () => {
      expect(isImportedTransaction({})).toBe(false)
    })
  })
})
