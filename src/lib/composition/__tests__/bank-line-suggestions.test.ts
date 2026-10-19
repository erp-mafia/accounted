/**
 * The bank-line suggestions plug-in (../bank-line-suggestions.ts) against
 * the decision log's contract (lib/suggestion-log/bank-line-suggestions.ts):
 * owned by the module of the leaves it calls, importing only those leaves,
 * and answering exactly as the leaves do. The leaves are pinned by
 * lib/transactions/__tests__/direct-booking.test.ts and the propose tests.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Transaction } from '@/types'

const leaves = vi.hoisted(() => ({ proposeForTransactions: vi.fn() }))
vi.mock('@/lib/transactions/propose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/propose')>()),
  proposeForTransactions: leaves.proposeForTransactions,
}))

import { BANK_LINE_SUGGESTIONS } from '../bank-line-suggestions'
import { BANK_PROPOSAL_RULES_REVISION } from '@/lib/transactions/propose'
import { confidenceBand, DIRECT_BOOKING_POLICY_VERSION } from '@/lib/transactions/direct-booking'
import { accountProposal } from '@/lib/bookkeeping/proposal'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAVES = ['transactions/direct-booking', 'transactions/propose']
const supabase = { sentinel: 'client' } as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BANK_LINE_SUGGESTIONS', () => {
  it('is frozen, owned by the module of its leaves, and imports only those leaves', () => {
    expect(Object.isFrozen(BANK_LINE_SUGGESTIONS)).toBe(true)
    for (const leaf of LEAVES) expect(BANK_LINE_SUGGESTIONS.module, leaf).toBe(moduleForLibPath(leaf))
    const imported = scanLibImports(LIB_ROOT)
      .filter((edge) => edge.from === 'composition/bank-line-suggestions.ts')
      .map((edge) => edge.to)
      .sort()
    expect(imported).toEqual(LEAVES)
  })

  it('rulesRevision and policyVersion: the constants the log recorded before', () => {
    expect(BANK_LINE_SUGGESTIONS.rulesRevision()).toBe(BANK_PROPOSAL_RULES_REVISION)
    expect(BANK_LINE_SUGGESTIONS.policyVersion()).toBe(DIRECT_BOOKING_POLICY_VERSION)
  })

  it('propose: proposeForTransactions(supabase, companyId, transactions), its result and failure untouched', async () => {
    const offers = { proposals: {}, assistant_reads: {} }
    leaves.proposeForTransactions.mockResolvedValueOnce(offers)
    const transactions = [{ id: 'tx-1' }] as unknown as Transaction[]
    await expect(BANK_LINE_SUGGESTIONS.propose(supabase, 'company-1', transactions)).resolves.toBe(offers)
    expect(leaves.proposeForTransactions.mock.calls[0]).toEqual([supabase, 'company-1', transactions])

    const failure = new Error('rules read failed')
    leaves.proposeForTransactions.mockRejectedValueOnce(failure)
    await expect(BANK_LINE_SUGGESTIONS.propose(supabase, 'company-1', transactions)).rejects.toBe(failure)
  })

  it('confidenceBand: the direct-booking policy band of the offer', () => {
    const offer = accountProposal({
      id: 'rule:r1',
      source: 'rule',
      account: '5410',
      label: 'Förbrukningsinventarier',
      category: 'expense_equipment',
      vat_treatment: 'standard_25',
      amount: -500,
      confidence: 0.92,
    })
    for (const proposal of [offer, { ...offer, rule_own: true }, { ...offer, rule_own: true, rule_requires_review: true }]) {
      expect(BANK_LINE_SUGGESTIONS.confidenceBand(proposal)).toBe(confidenceBand(proposal))
    }
    expect(BANK_LINE_SUGGESTIONS.confidenceBand({ ...offer, rule_own: true })).toBe('direct')
  })
})
