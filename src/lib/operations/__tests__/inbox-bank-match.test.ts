import { beforeEach, describe, expect, it, vi } from 'vitest'

const refreshInboxItemBankMatch = vi.fn()
const refreshInboxBankMatchesForTransactions = vi.fn()
vi.mock('@/lib/documents/bank-match/refresh', () => ({
  refreshInboxItemBankMatch: (...args: unknown[]) => refreshInboxItemBankMatch(...args),
  refreshInboxBankMatchesForTransactions: (...args: unknown[]) => refreshInboxBankMatchesForTransactions(...args),
}))

import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { peppolReader } from '@/lib/invoices/peppol-reading'
import { counterpartyGiroDigits, giroKey } from '@/lib/transactions/giro-counterparty'
import { INBOX_BANK_MATCH_RULES, proposeBankMatchesForArrivedRows, proposeBankMatchForInboxItem } from '../inbox-bank-match'

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

  it('never throws', async () => {
    refreshInboxBankMatchesForTransactions.mockRejectedValue(new Error('down'))
    await expect(proposeBankMatchesForArrivedRows(supabase, 'company-1', rows, log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
  })
})
