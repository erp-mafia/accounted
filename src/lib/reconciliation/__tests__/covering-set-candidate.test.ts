/**
 * Tests for the covering-set candidate source of the bridge table (#2293):
 * the adapter between the batch set detector and the proposal shape the
 * reconciliation surface renders and confirms.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExplainingVoucherSet } from '@/lib/invoices/duplicate-payment-detection'

const detectMock = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSets: (...args: unknown[]) => detectMock(...args),
}))

import {
  coveringSetProposal,
  proposeCoveringSets,
  COVERING_SET_SAME_DATE_CONFIDENCE,
  COVERING_SET_WINDOW_CONFIDENCE,
} from '../covering-set-candidate'

const supabase = {} as never
const COMPANY = 'company-1'
const SEK_ACCOUNT = { ledger_account: '1930', currency: 'SEK' }

function voucher(id: string, amount: number, date: string, description: string | null = `Voucher ${id}`) {
  return {
    journal_entry_id: id,
    voucher_label: id,
    voucher_series: id[0],
    voucher_number: parseInt(id.slice(1), 10),
    entry_date: date,
    description,
    source_type: 'invoice_paid',
    amount,
    bank_account_number: '1930',
  }
}

function set(vouchers: ReturnType<typeof voucher>[], sameDate: boolean): ExplainingVoucherSet {
  return {
    vouchers,
    total: vouchers.reduce((s, v) => s + v.amount, 0),
    bank_account_number: '1930',
    same_date: sameDate,
  }
}

describe('coveringSetProposal', () => {
  it('renders a same-date set as strong as an exact 1:1 match, with every voucher listed', () => {
    const proposal = coveringSetProposal(
      set([voucher('A57', 62500, '2026-07-31', 'Inbetalning 063'), voucher('A58', 25750, '2026-07-31', 'Inbetalning 064')], true),
    )

    expect(proposal).toEqual({
      journal_entry_id: 'A57',
      voucher_number: 57,
      voucher_series: 'A',
      entry_date: '2026-07-31',
      description: 'Inbetalning 063 + Inbetalning 064',
      entry_status: 'posted',
      confidence: COVERING_SET_SAME_DATE_CONFIDENCE,
      reasons: ['exact_sum_same_date'],
      vouchers: [
        { journal_entry_id: 'A57', voucher_number: 57, voucher_series: 'A', entry_date: '2026-07-31', description: 'Inbetalning 063', amount: 62500 },
        { journal_entry_id: 'A58', voucher_number: 58, voucher_series: 'A', entry_date: '2026-07-31', description: 'Inbetalning 064', amount: 25750 },
      ],
    })
    expect(COVERING_SET_SAME_DATE_CONFIDENCE).toBe(0.95)
  })

  it('keeps a within-window set below the unattended auto-apply floor', () => {
    const proposal = coveringSetProposal(set([voucher('A3', 1000, '2026-07-28', null)], false))

    expect(proposal.confidence).toBe(COVERING_SET_WINDOW_CONFIDENCE)
    expect(COVERING_SET_WINDOW_CONFIDENCE).toBeLessThan(0.9)
    expect(proposal.reasons).toEqual(['exact_sum_within_window'])
    expect(proposal.description).toBe('')
    expect(proposal.vouchers).toEqual([
      { journal_entry_id: 'A3', voucher_number: 3, voucher_series: 'A', entry_date: '2026-07-28', description: '', amount: 1000 },
    ])
  })
})

describe('proposeCoveringSets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    detectMock.mockResolvedValue(new Map())
  })

  it('runs the batch detector on the account and maps every set to a proposal', async () => {
    detectMock.mockResolvedValue(
      new Map([['tx-bg', set([voucher('A57', 62500, '2026-07-31'), voucher('A58', 25750, '2026-07-31')], true)]]),
    )

    const proposals = await proposeCoveringSets(supabase, COMPANY, SEK_ACCOUNT, [
      { id: 'tx-bg', date: '2026-07-31', amount: 88250, currency: 'SEK' },
      { id: 'tx-other', date: '2026-07-30', amount: -120, currency: 'SEK' },
    ])

    expect(detectMock).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY,
      bankAccountNumber: '1930',
      transactions: [
        { id: 'tx-bg', date: '2026-07-31', amount: 88250, currency: 'SEK' },
        { id: 'tx-other', date: '2026-07-30', amount: -120, currency: 'SEK' },
      ],
    })
    expect([...proposals.keys()]).toEqual(['tx-bg'])
    expect(proposals.get('tx-bg')).toMatchObject({
      journal_entry_id: 'A57',
      confidence: 0.95,
      vouchers: [{ journal_entry_id: 'A57' }, { journal_entry_id: 'A58' }],
    })
  })

  it('never searches a non-SEK account: the 1:N link compares in the account currency', async () => {
    const proposals = await proposeCoveringSets(supabase, COMPANY, { ledger_account: '1932', currency: 'EUR' }, [
      { id: 'tx-eur', date: '2026-07-31', amount: 100, currency: 'EUR' },
    ])

    expect(proposals.size).toBe(0)
    expect(detectMock).not.toHaveBeenCalled()
  })

  it('does nothing for an empty row list', async () => {
    const proposals = await proposeCoveringSets(supabase, COMPANY, SEK_ACCOUNT, [])

    expect(proposals.size).toBe(0)
    expect(detectMock).not.toHaveBeenCalled()
  })

  it('fails open when the detector throws: the row stays unmatched, the table stays up', async () => {
    detectMock.mockRejectedValue(new Error('db down'))

    const proposals = await proposeCoveringSets(supabase, COMPANY, SEK_ACCOUNT, [
      { id: 'tx', date: '2026-07-31', amount: 100, currency: 'SEK' },
    ])

    expect(proposals.size).toBe(0)
  })
})
