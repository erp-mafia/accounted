import { describe, it, expect } from 'vitest'
import {
  BULK_CHUNK_SIZE,
  BULK_IDS_MAX,
  chunkIds,
  sharedAcknowledgmentGroup,
  summarizeSharedAcknowledgment,
} from '../shared-acknowledgment'
import type { PendingOperation } from '@/types'

type Op = Pick<PendingOperation, 'operation_type' | 'risk_level' | 'params' | 'preview_data'>

function bulkBook(overrides: Partial<Op> = {}): Op {
  return {
    operation_type: 'bulk_book_transactions',
    risk_level: 'high',
    params: { tx_ids: ['t1'], entry_description: 'Stripe 2026-06-29', manual_lines: [] },
    preview_data: { mode: 'create_new', tx_sum: 199, tx_date: '2026-06-29' },
    ...overrides,
  }
}

describe('sharedAcknowledgmentGroup', () => {
  it('groups a new samlingsverifikat from bank rows (crm#1489)', () => {
    expect(sharedAcknowledgmentGroup(bulkBook())).toBe('bulk_book_create_new')
  })

  it('keeps a link to an existing verifikat individual', () => {
    expect(
      sharedAcknowledgmentGroup(bulkBook({ params: { tx_ids: ['t1'], existing_journal_entry_id: 'je-1' } })),
    ).toBeNull()
  })

  it('keeps a reviewed duplicate override individual, under either name', () => {
    expect(sharedAcknowledgmentGroup(bulkBook({ params: { force: true } }))).toBeNull()
    expect(sharedAcknowledgmentGroup(bulkBook({ params: { allow_duplicate: true } }))).toBeNull()
  })

  it('keeps a proposal with a compliance or VAT warning individual', () => {
    expect(
      sharedAcknowledgmentGroup(bulkBook({ preview_data: { compliance_warning: 'Underlag saknas' } })),
    ).toBeNull()
    expect(
      sharedAcknowledgmentGroup(bulkBook({ preview_data: { vat_warnings: [{ message_sv: 'Momsen avviker' }] } })),
    ).toBeNull()
  })

  it('groups nothing else: other high-risk types and non-high operations', () => {
    expect(sharedAcknowledgmentGroup(bulkBook({ operation_type: 'create_voucher' }))).toBeNull()
    expect(sharedAcknowledgmentGroup(bulkBook({ operation_type: 'unapprove_salary_run' }))).toBeNull()
    expect(sharedAcknowledgmentGroup(bulkBook({ risk_level: 'medium' }))).toBeNull()
  })
})

describe('summarizeSharedAcknowledgment', () => {
  it('sums count, directions, date range and every account to öre', () => {
    const summary = summarizeSharedAcknowledgment([
      {
        preview_data: {
          tx_sum: 199,
          tx_date: '2026-06-29',
          lines: [
            { account_number: '1686', account_name: 'Stripe', debit_amount: 199, credit_amount: 0 },
            { account_number: '3001', account_name: 'Försäljning', debit_amount: 0, credit_amount: 159.2 },
            { account_number: '2611', account_name: 'Utgående moms', debit_amount: 0, credit_amount: 39.8 },
          ],
        },
      },
      {
        preview_data: {
          tx_sum: -4.79,
          tx_date: '2026-06-28',
          lines: [
            { account_number: '6570', account_name: 'Bankkostnader', debit_amount: 4.79, credit_amount: 0 },
            { account_number: '1686', account_name: 'Stripe', debit_amount: 0, credit_amount: 4.79 },
          ],
        },
      },
      {
        preview_data: {
          tx_sum: 0.1,
          tx_date: '2026-07-01',
          lines: [
            { account_number: '1686', account_name: 'Stripe', debit_amount: 0.1, credit_amount: 0 },
            { account_number: '3001', account_name: 'Försäljning', debit_amount: 0, credit_amount: 0.2 },
          ],
        },
      },
    ])

    expect(summary.count).toBe(3)
    expect(summary.date_from).toBe('2026-06-28')
    expect(summary.date_to).toBe('2026-07-01')
    expect(summary.incoming).toBe(199.1)
    expect(summary.outgoing).toBe(4.79)
    expect(summary.accounts).toEqual([
      { account_number: '1686', account_name: 'Stripe', debit: 199.1, credit: 4.79 },
      { account_number: '2611', account_name: 'Utgående moms', debit: 0, credit: 39.8 },
      { account_number: '3001', account_name: 'Försäljning', debit: 0, credit: 159.4 },
      { account_number: '6570', account_name: 'Bankkostnader', debit: 4.79, credit: 0 },
    ])
  })

  it('reads an account number given as a number as a string', () => {
    const summary = summarizeSharedAcknowledgment([
      { preview_data: { tx_sum: 1, lines: [{ account_number: 1930, debit_amount: 1, credit_amount: 0 }] } },
    ])
    expect(summary.accounts[0]).toEqual({ account_number: '1930', account_name: null, debit: 1, credit: 0 })
  })
})

describe('chunkIds', () => {
  it('splits a selection above the route cap into ordered request-sized chunks (crm#1488)', () => {
    const ids = Array.from({ length: 330 }, (_, i) => `id-${i}`)
    const chunks = chunkIds(ids)
    expect(BULK_CHUNK_SIZE).toBeLessThanOrEqual(BULK_IDS_MAX)
    expect(chunks.every((chunk) => chunk.length <= BULK_CHUNK_SIZE)).toBe(true)
    expect(chunks.flat()).toEqual(ids)
  })

  it('returns no chunks for no ids', () => {
    expect(chunkIds([])).toEqual([])
  })
})
