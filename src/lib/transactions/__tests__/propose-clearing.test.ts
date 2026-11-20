/**
 * proposeForTransactions and the clearing proposers: a clearing proposal
 * leads the row's list above the catalog and a learned counterpart, never
 * books from the row, and a failing proposer leaves the list as it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeTransaction } from '@/tests/helpers'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'
import { accountProposal, proposalFromTemplate, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { booksWithoutReview } from '../direct-booking'
import { rowProposal } from '../category-suggestions'

const { counterparts, suggested, clearingPropose } = vi.hoisted(() => ({
  counterparts: vi.fn(),
  suggested: vi.fn(),
  clearingPropose: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))
vi.mock('@/lib/transactions/category-suggestions', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/category-suggestions')>()),
  getSuggestedTemplates: suggested,
}))
vi.mock('@/lib/composition/clearing-proposals', () => ({
  CLEARING_PROPOSERS: [{ id: 'fake', module: 'pos', propose: clearingPropose }],
}))

import { leadWithClearing, proposeForTransactions } from '../propose'

const COMPANY_ID = 'company-1'

const swish = makeTransaction({ id: 'tx-swish', amount: 145.5, description: 'REF 1834', merchant_name: null })
const purchase = makeTransaction({ id: 'tx-purchase', amount: -200, description: 'Kontorsbolaget' })

const sale = () => proposalFromTemplate(getTemplateById('financial_tax_account')!, 'catalog', 0.3)
const clearing = (): BookingProposal => ({
  ...accountProposal({
    id: 'clearing:pos:swish',
    source: 'clearing',
    account: '1686',
    label: 'Swish från kassan',
    category: 'income_other',
    vat_treatment: 'exempt',
    amount: 145.5,
    confidence: 0.9,
  }),
  requires_review: true,
})

const ledger = () =>
  createTableMockSupabase({
    mapping_rules: { data: [], error: null },
    company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
    transaction_assistant_reads: { data: [], error: null },
  })

beforeEach(() => {
  vi.clearAllMocks()
  counterparts.mockResolvedValue(new Map<string, CounterpartyTemplateMatch>())
  suggested.mockImplementation(async () => [sale()])
})

describe('proposeForTransactions: clearing proposals', () => {
  it('puts a clearing proposal first on its row, which then opens a review', async () => {
    clearingPropose.mockResolvedValue(new Map([['tx-swish', clearing()]]))
    const { supabase } = ledger()
    const { proposals } = await proposeForTransactions(supabase as never, COMPANY_ID, [swish, purchase])
    expect(proposals['tx-swish'].map((p) => p.source)).toEqual(['clearing', 'catalog'])
    expect(proposals['tx-purchase'].map((p) => p.source)).toEqual(['catalog'])
    const chip = rowProposal(proposals['tx-swish'])!
    expect(chip.source).toBe('clearing')
    expect(booksWithoutReview(chip)).toBe(false)
    // Only the candidate row is asked about.
    expect(clearingPropose.mock.calls[0][2].map((r: { id: string }) => r.id)).toEqual(['tx-swish'])
  })

  it('keeps the list as it was when a proposer fails', async () => {
    clearingPropose.mockRejectedValue(new Error('pos tables down'))
    const { supabase } = ledger()
    const { proposals } = await proposeForTransactions(supabase as never, COMPANY_ID, [swish])
    expect(proposals['tx-swish'].map((p) => p.source)).toEqual(['catalog'])
  })
})

describe('leadWithClearing', () => {
  it('leads with the clearing and drops an older copy of it', () => {
    const c = clearing()
    expect(leadWithClearing([sale(), { ...c, confidence: 0.1 }], c)).toEqual([c, sale()])
  })
})
