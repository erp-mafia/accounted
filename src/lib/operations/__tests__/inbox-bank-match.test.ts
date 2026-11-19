import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshInboxItemBankMatch = vi.fn()
const refreshInboxBankMatchesForTransactions = vi.fn()
vi.mock('@/lib/documents/bank-match/refresh', () => ({
  refreshInboxItemBankMatch: (...args: unknown[]) => refreshInboxItemBankMatch(...args),
  refreshInboxBankMatchesForTransactions: (...args: unknown[]) => refreshInboxBankMatchesForTransactions(...args),
}))

import { BANK_MATCH_RULES_VERSION, bankMatchCheckKey, bankMatchSourceKey } from '@/lib/documents/inbox-bank-match'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { peppolReader } from '@/lib/invoices/peppol-reading'
import { counterpartyGiroDigits, giroKey } from '@/lib/transactions/giro-counterparty'
import {
  checkNeverCheckedInboxItems,
  INBOX_BANK_MATCH_RULES,
  NEVER_CHECKED_COOLDOWN_MS,
  NEVER_CHECKED_PER_LIST_READ,
  neverChecked,
  neverCheckedToCheck,
  proposeBankMatchesForArrivedRows,
  proposeBankMatchForInboxItem,
} from '../inbox-bank-match'

const supabase = {} as never
const log = { warn: vi.fn() }

beforeEach(() => vi.clearAllMocks())

describe('INBOX_BANK_MATCH_RULES', () => {
  it('binds the bank feed\'s own matchers, not copies', () => {
    expect(INBOX_BANK_MATCH_RULES).toEqual({ matchSupplierInvoice: findSupplierInvoiceMatch, counterpartyGiroDigits, giroKey, peppolReader })
  })
})

describe('proposeBankMatchForInboxItem', () => {
  it('runs the refresh with the bound rules', async () => {
    refreshInboxItemBankMatch.mockResolvedValue({ status: 'updated', decision: null })
    await proposeBankMatchForInboxItem(supabase, 'company-1', 'item-1', log)
    expect(refreshInboxItemBankMatch).toHaveBeenCalledWith(supabase, 'company-1', 'item-1', INBOX_BANK_MATCH_RULES)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs the other items it could not look at again, and goes on', async () => {
    refreshInboxItemBankMatch.mockResolvedValue({ status: 'updated', decision: null, others: { checked: 2, failed: 1 } })
    await proposeBankMatchForInboxItem(supabase, 'company-1', 'item-1', log)
    expect(log.warn).toHaveBeenCalledWith('inbox bank match: other items not looked at again', { inboxItemId: 'item-1', failed: 1 })
  })

  it('never throws: a failure is logged and the door goes on', async () => {
    refreshInboxItemBankMatch.mockRejectedValue(new Error('statement timeout'))
    await expect(proposeBankMatchForInboxItem(supabase, 'company-1', 'item-1', log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith('inbox bank match failed', { inboxItemId: 'item-1', reason: 'statement timeout' })
  })
})

describe('proposeBankMatchesForArrivedRows', () => {
  const rows = [{ id: 'tx-1', amount: -1250 }]

  it('logs the items it could not refresh', async () => {
    refreshInboxBankMatchesForTransactions.mockResolvedValue({ items_checked: 3, failed: 1 })
    await proposeBankMatchesForArrivedRows(supabase, 'company-1', rows, log)
    expect(refreshInboxBankMatchesForTransactions).toHaveBeenCalledWith(supabase, 'company-1', rows, INBOX_BANK_MATCH_RULES)
    expect(log.warn).toHaveBeenCalledWith('inbox bank match: items not refreshed', { companyId: 'company-1', failed: 1 })
  })

  it('a failed pass throws to its caller, the event bus, instead of a warning nobody reads', async () => {
    refreshInboxBankMatchesForTransactions.mockRejectedValue(new Error('down'))
    await expect(proposeBankMatchesForArrivedRows(supabase, 'company-1', rows, log)).rejects.toThrow('down')
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('never-checked items', () => {
  const NOW = new Date('2026-10-19T10:00:00Z')
  const open = (id: string, created_at: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: 'received',
    document_id: `doc-${id}`,
    created_at,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    routed_to_arkiv_at: null,
    bank_match_checked_at: null,
    ...overrides,
  })

  describe('neverChecked', () => {
    it('is an open, read item with a document the bank was never checked for', () => {
      expect(neverChecked(open('a', '2026-09-01T00:00:00Z'))).toBe(true)
    })

    it('is an item checked only under older rules: its answer was written before the rules in force', () => {
      const item = { extracted_data: { totals: { total: 1250 } } }
      const olderRules = open('a', '2026-09-01T00:00:00Z', { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: bankMatchSourceKey({ id: 'a', ...item }) })
      expect(neverChecked(olderRules)).toBe(true)
      const current = { ...olderRules, bank_match_source_key: bankMatchCheckKey({ id: 'a', ...item }) }
      expect(neverChecked(current)).toBe(false)
    })

    it.each([
      ['checked once, nothing found', { bank_match_checked_at: '2026-10-01T00:00:00Z' }],
      ['checked under the rules in force', { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd-r2' }],
      ['claimed, its check not written (a failed check is not picked again)', { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: null }],
      ['checked under older rules, but not open', { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd', created_journal_entry_id: 'je-1' }],
      ['read without the column', { bank_match_checked_at: undefined }],
      ['still being read', { status: 'processing' }],
      ['unreadable', { status: 'error' }],
      ['without a document', { document_id: null }],
      ['paired with a bank row', { matched_transaction_id: 'tx-1' }],
      ['registered', { created_supplier_invoice_id: 'si-1' }],
      ['booked', { created_journal_entry_id: 'je-1' }],
      ['in Arkiv', { routed_to_arkiv_at: '2026-10-01T00:00:00Z' }],
    ])('is not an item %s', (_label, overrides) => {
      expect(neverChecked(open('a', '2026-09-01T00:00:00Z', overrides))).toBe(false)
    })
  })

  describe('neverCheckedToCheck', () => {
    it('takes at most the bound, newest first', () => {
      const rows = Array.from({ length: 12 }, (_, i) => open(`i${String(i).padStart(2, '0')}`, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`))
      expect(NEVER_CHECKED_PER_LIST_READ).toBe(5)
      expect(neverCheckedToCheck(rows, NOW)).toEqual(['i11', 'i10', 'i09', 'i08', 'i07'])
      expect(neverCheckedToCheck(rows, NOW, 2)).toEqual(['i11', 'i10'])
    })

    it('starts no batch while a check of the company landed within the cooldown', () => {
      const justChecked = open('done', '2026-10-01T00:00:00Z', { bank_match_checked_at: new Date(NOW.getTime() - 5_000).toISOString() })
      expect(neverCheckedToCheck([justChecked, open('a', '2026-09-01T00:00:00Z')], NOW)).toEqual([])
      const longAgo = { ...justChecked, bank_match_checked_at: new Date(NOW.getTime() - NEVER_CHECKED_COOLDOWN_MS - 1).toISOString() }
      expect(neverCheckedToCheck([longAgo, open('a', '2026-09-01T00:00:00Z')], NOW)).toEqual(['a'])
    })

    it('has nothing to do when every item was checked', () => {
      expect(neverCheckedToCheck([open('a', '2026-09-01T00:00:00Z', { bank_match_checked_at: '2026-10-01T00:00:00Z' })], NOW)).toEqual([])
    })

    it('the backlog: items checked under older rules are picked as never-checked ones are, newest first, in the same bound', () => {
      const older = (id: string, day: number) =>
        open(id, `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd' })
      const current = (id: string, day: number) =>
        open(id, `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, { bank_match_checked_at: '2026-10-01T00:00:00Z', bank_match_source_key: 'v1:0000abcd-r2' })
      const rows = [older('o1', 1), current('c1', 2), older('o2', 3), open('n1', '2026-09-04T00:00:00Z'), current('c2', 5), older('o3', 6), older('o4', 7), older('o5', 8), older('o6', 9)]
      expect(neverCheckedToCheck(rows, NOW)).toEqual(['o6', 'o5', 'o4', 'o3', 'n1'])
      // The cooldown holds for them too.
      const justChecked = open('done', '2026-09-10T00:00:00Z', {
        bank_match_checked_at: new Date(NOW.getTime() - 5_000).toISOString(),
        bank_match_source_key: 'v1:0000abcd-r2',
      })
      expect(neverCheckedToCheck([...rows, justChecked], NOW)).toEqual([])
    })
  })

  describe('checkNeverCheckedInboxItems', () => {
    function claiming(claimed: string[] | null, error: { message: string } | null = null) {
      const calls: Array<{ method: string; args: unknown[] }> = []
      const chain: Record<string, unknown> = {}
      for (const method of ['update', 'eq', 'in', 'is', 'or']) {
        chain[method] = (...args: unknown[]) => {
          calls.push({ method, args })
          return chain
        }
      }
      chain.select = (...args: unknown[]) => {
        calls.push({ method: 'select', args })
        return Promise.resolve({ data: claimed?.map((id) => ({ id })) ?? null, error })
      }
      return { client: { from: (table: string) => (calls.push({ method: 'from', args: [table] }), chain) } as never, calls }
    }

    it('claims the items in one write, then checks only the ones it claimed', async () => {
      refreshInboxItemBankMatch.mockResolvedValue({ status: 'updated', decision: null })
      const { client, calls } = claiming(['a'])
      expect(await checkNeverCheckedInboxItems(client, 'company-1', ['a', 'b', 'a'], log)).toEqual(['a'])
      expect(calls.filter((c) => c.method === 'update')).toHaveLength(1)
      // Never checked, or checked under older rules than the ones in force (the
      // filter spells the version out: raising it means raising the filter too).
      expect(calls).toContainEqual({ method: 'or', args: [`bank_match_checked_at.is.null,bank_match_source_key.not.like.*-r${BANK_MATCH_RULES_VERSION}`] })
      expect(calls).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
      expect(calls).toContainEqual({ method: 'in', args: ['id', ['a', 'b']] })
      const [payload] = calls.find((c) => c.method === 'update')!.args as [Record<string, unknown>]
      // The claim clears the key: the item is then neither never checked nor checked under older rules.
      expect(Object.keys(payload)).toEqual(['bank_match_checked_at', 'bank_match_source_key'])
      expect(payload.bank_match_source_key).toBeNull()
      // b was claimed by someone else (another read, or checked meanwhile): not checked twice.
      expect(refreshInboxItemBankMatch).toHaveBeenCalledTimes(1)
      expect(refreshInboxItemBankMatch).toHaveBeenCalledWith(client, 'company-1', 'a', INBOX_BANK_MATCH_RULES)
    })

    it('a check that fails keeps its claim: the next read does not pick it again', async () => {
      refreshInboxItemBankMatch.mockRejectedValue(new Error('statement timeout'))
      const { client } = claiming(['a', 'b'])
      expect(await checkNeverCheckedInboxItems(client, 'company-1', ['a', 'b'], log)).toEqual(['a', 'b'])
      expect(refreshInboxItemBankMatch).toHaveBeenCalledTimes(2)
      expect(log.warn).toHaveBeenCalledTimes(2)
    })

    it('never throws, and checks nothing when the claim fails', async () => {
      const { client } = claiming(null, { message: 'down' })
      await expect(checkNeverCheckedInboxItems(client, 'company-1', ['a'], log)).resolves.toEqual([])
      expect(refreshInboxItemBankMatch).not.toHaveBeenCalled()
      expect(log.warn).toHaveBeenCalledWith('inbox bank match: never-checked claim failed', { companyId: 'company-1', reason: 'down' })
    })

    it('writes nothing for no ids', async () => {
      const { client, calls } = claiming([])
      expect(await checkNeverCheckedInboxItems(client, 'company-1', [], log)).toEqual([])
      expect(calls).toEqual([])
    })
  })
})
