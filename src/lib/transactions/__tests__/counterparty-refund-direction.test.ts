/**
 * Money in from a counterpart the company has booked as a cost (crm#1598):
 * a supplier's refund or credit. The booking already mirrored such a match
 * (buildMappingResultFromCounterpartyTemplate); the row's proposal still
 * showed the learned expense legs, as a habit that could book with one
 * click, and the assistant's slate and the MCP tool read it that way. One
 * decision (contradictsLearnedDirection) now drives all of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'
import type { SupabaseClient } from '@supabase/supabase-js'

const { counterparts } = vi.hoisted(() => ({ counterparts: vi.fn() }))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))

import { buildCounterpartySuggestion } from '../category-suggestions'
import { booksWithoutReview, reviewReason, DIRECT_BOOKING_ON } from '../direct-booking'
import { proposeForTransactions } from '../propose'
import {
  buildMappingResultFromCounterpartyTemplate,
  contradictsLearnedDirection,
} from '@/lib/bookkeeping/counterparty-templates'
import { categorizeBodyFor, whyKeyFor, whyTextSv } from '@/lib/bookkeeping/proposal'
import { candidateFromProposal } from '@/lib/agent/categorize/candidates'

/** A software subscription learned as a reverse-charge cost, booked often enough to be a habit. */
const software = makeCategorizationTemplate({
  counterparty_name: 'anthropic',
  debit_account: '5420',
  credit_account: '1930',
  vat_treatment: 'reverse_charge',
  occurrence_count: 9,
  mode: 'propose',
  source: 'user_approved',
})

const refundRow = makeTransaction({ id: 'tx-refund', amount: 766.7, description: 'ANTHROPIC* CLA' })
const purchaseRow = makeTransaction({ id: 'tx-purchase', amount: -766.7, description: 'ANTHROPIC* CLA' })

describe('contradictsLearnedDirection', () => {
  it('flags money in on an expense-learned template and money out on an income-learned one', () => {
    expect(contradictsLearnedDirection(software, 766.7)).toBe(true)
    expect(contradictsLearnedDirection(software, -766.7)).toBe(false)
    const sale = { debit_account: '1930', credit_account: '3041', line_pattern: null }
    expect(contradictsLearnedDirection(sale, -200)).toBe(true)
    expect(contradictsLearnedDirection(sale, 200)).toBe(false)
  })

  it('never flags a template of unknown direction (a transfer between two cash ledgers)', () => {
    const transfer = { debit_account: '1930', credit_account: '1940', line_pattern: null }
    expect(contradictsLearnedDirection(transfer, 500)).toBe(false)
    expect(contradictsLearnedDirection(transfer, -500)).toBe(false)
  })

  it('reads a multi-line pattern off its business lines', () => {
    const pattern = {
      debit_account: '5420',
      credit_account: '1930',
      line_pattern: [
        { account: '5420', side: 'debit' as const, type: 'business' as const, ratio: 0.6 },
        { account: '5410', side: 'debit' as const, type: 'business' as const, ratio: 0.4 },
        { account: '2641', side: 'debit' as const, type: 'vat' as const, vat_rate: 0.25 },
      ],
    }
    expect(contradictsLearnedDirection(pattern, 100)).toBe(true)
    expect(contradictsLearnedDirection(pattern, -100)).toBe(false)
  })
})

describe('buildCounterpartySuggestion on a refund (crm#1598)', () => {
  const refund = buildCounterpartySuggestion(software, 0.95, { directionMismatch: true })

  it('shows the legs the booking posts: the bank debited, the cost account reduced', () => {
    const booked = buildMappingResultFromCounterpartyTemplate(
      { template: software, confidence: 0.95, matchMethod: 'exact_normalized' } as CounterpartyTemplateMatch,
      refundRow,
      'aktiebolag',
    )
    expect(booked.direction_mismatch).toBe(true)
    expect([refund.debit_account, refund.credit_account]).toEqual([booked.debit_account, booked.credit_account])
    expect([refund.debit_account, refund.credit_account]).toEqual(['1930', '5420'])
  })

  it('is marked a likely refund, still books through the learned counterpart, and never without a review', () => {
    expect(refund.direction_mismatch).toBe(true)
    expect(refund.requires_review).toBe(true)
    expect(categorizeBodyFor(refund).counterparty_template_id).toBe(software.id)
    // Nine bookings the other way settle nothing about money coming in.
    expect(booksWithoutReview(refund)).toBe(false)
    expect(reviewReason(refund, DIRECT_BOOKING_ON)).toBe('evidence')
  })

  it('says why, to a person, an agent and the assistant\'s slate', () => {
    expect(whyKeyFor(refund)).toEqual({ key: 'rec_why_counterparty_refund', values: { count: 9 } })
    expect(whyTextSv(refund)).toMatch(/troligen en återbetalning eller kreditering/)
    expect(candidateFromProposal(refund).matchReason).toMatch(/trolig återbetalning/)
    // The account the slate reasons over is still the cost account the refund reduces.
    expect(candidateFromProposal(refund).account).toBe('5420')
  })

  it('leaves a purchase from the same counterpart exactly as before', () => {
    const purchase = buildCounterpartySuggestion(software, 0.95)
    expect(purchase.direction_mismatch).toBeUndefined()
    expect(purchase.requires_review).toBe(false)
    expect([purchase.debit_account, purchase.credit_account]).toEqual(['5420', '1930'])
    expect(booksWithoutReview(purchase)).toBe(true)
    expect(whyTextSv(purchase)).toBe('Bokförd så 9 gånger tidigare')
  })
})

describe('proposeForTransactions: the row decides against the stored template', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mirrors and flags the counterpart on the refund row only', async () => {
    counterparts.mockResolvedValue(
      new Map<string, CounterpartyTemplateMatch>([
        ['tx-refund', { template: software, confidence: 0.95, matchMethod: 'exact_normalized' } as CounterpartyTemplateMatch],
        ['tx-purchase', { template: software, confidence: 0.95, matchMethod: 'exact_normalized' } as CounterpartyTemplateMatch],
      ]),
    )
    const { supabase } = createTableMockSupabase({
      mapping_rules: { data: [], error: null },
      company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
      transaction_assistant_reads: { data: [], error: null },
    })
    const { proposals } = await proposeForTransactions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [refundRow, purchaseRow],
      { withReads: false },
    )
    const refund = proposals['tx-refund'].find((p) => p.source === 'counterparty')!
    const purchase = proposals['tx-purchase'].find((p) => p.source === 'counterparty')!
    expect(refund).toMatchObject({ direction_mismatch: true, requires_review: true, debit_account: '1930', credit_account: '5420' })
    expect(purchase.direction_mismatch).toBeUndefined()
    expect([purchase.debit_account, purchase.credit_account]).toEqual(['5420', '1930'])
  })
})
