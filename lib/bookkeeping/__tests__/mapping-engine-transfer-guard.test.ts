/**
 * Issue #1643 problem 4: an own-account "transfer" whose counter leg IS the
 * settlement account is not a transfer. It happens when the bank stamps the
 * account's own IBAN as counterparty (interest, fees) and a sibling
 * cash_accounts row still carries that IBAN. The engine must fall through to
 * normal categorization instead of proposing debit == credit on one ledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'

const detectOwnAccountTransferMock = vi.fn()
vi.mock('../own-account-detector', () => ({
  detectOwnAccountTransfer: (...args: unknown[]) => detectOwnAccountTransferMock(...args),
}))

vi.mock('../booking-templates', () => ({
  findMatchingTemplates: vi.fn().mockReturnValue([]),
  buildMappingResultFromTemplate: vi.fn(),
}))

vi.mock('../counterparty-templates', () => ({
  findCounterpartyTemplate: vi.fn().mockResolvedValue(null),
  buildMappingResultFromCounterpartyTemplate: vi.fn(),
}))

import { evaluateMappingRules } from '../mapping-engine'

describe('evaluateMappingRules own-account transfer guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('books a genuine transfer when the counter differs from the settlement account', async () => {
    const { supabase } = createQueuedMockSupabase()
    detectOwnAccountTransferMock.mockResolvedValue({
      counterCashAccountId: 'ca-eur',
      counterLedgerAccount: '1932',
      counterCurrency: 'SEK',
      pairTransactionId: null,
    })

    const result = await evaluateMappingRules(
      supabase as never,
      'company-1',
      makeTransaction({ amount: -1000, currency: 'SEK' }),
      undefined,
      '1930',
    )

    expect(result.debit_account).toBe('1932')
    expect(result.credit_account).toBe('1930')
  })

  it('falls through to normal categorization when the counter equals the settlement account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    detectOwnAccountTransferMock.mockResolvedValue({
      counterCashAccountId: 'ca-self',
      counterLedgerAccount: '1940',
      counterCurrency: 'SEK',
      pairTransactionId: null,
    })
    enqueue({ data: [] }) // mapping_rules lookup: none

    const result = await evaluateMappingRules(
      supabase as never,
      'company-1',
      makeTransaction({ amount: 217.04, currency: 'SEK' }),
      undefined,
      '1940',
    )

    // Not a transfer result: neither leg may be the 1940 counter proposal.
    // The default fallback books bank vs the uncategorized suspense account.
    expect(result.debit_account).toBe('1940')
    expect(result.credit_account).not.toBe('1940')
  })
})
