import { describe, expect, it } from 'vitest'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'
import { BATCH_EXCLUDED_REASONS, BATCH_SKIP_REASONS, type BatchCommitResult, type BatchExcluded, type BatchItem } from '../batch'
import {
  BATCH_REVIEW_HREF,
  BLOCK_SENTENCES,
  EXCLUDED_REASON_KEY,
  SKIP_REASON_KEY,
  batchCanSend,
  batchItemKey,
  excludedLine,
  groupBatchItems,
  parseBatchResult,
  removalInvoiceIds,
  skipLines,
  sortExcluded,
  tickedItems,
  tickedTotal,
  toggleUnticked,
  wantsBatchReview,
} from '../batch-dialog'

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`

function item(n: number, kind: BatchItem['kind'] = 'open', overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    kind,
    invoice_id: id(n),
    case_id: kind === 'open' ? null : id(900 + n),
    invoice_number: String(1000 + n),
    customer_name: `Kund ${n} AB`,
    due_date: '2026-09-01',
    remaining_amount: 1250,
    start_step: kind === 'approve_step' ? null : 'reminder',
    decision_kind: kind === 'approve_step' ? 'approve_collection_notice' : null,
    reminder_fee_agreed: kind === 'approve_step' ? null : false,
    bank_check: 'pass',
    ...overrides,
  }
}

function excluded(n: number, reason: BatchExcluded['reason'], overrides: Partial<BatchExcluded> = {}): BatchExcluded {
  return {
    kind: 'open',
    invoice_id: id(n),
    invoice_number: String(1000 + n),
    customer_name: `Kund ${n} AB`,
    due_date: '2026-09-01',
    reason,
    block: null,
    ...overrides,
  }
}

describe('groupBatchItems', () => {
  it('groups per kind in the order new handovers, reminders on delivered invoices, next steps; empty kinds left out', () => {
    const groups = groupBatchItems([item(1, 'approve_step'), item(2, 'open'), item(3, 'approve_step')])
    expect(groups.map((g) => [g.kind, g.labelKey, g.items.map((i) => i.invoice_number)])).toEqual([
      ['open', 'batch_kind_open', ['1002']],
      ['approve_step', 'batch_kind_approve', ['1001', '1003']],
    ])
  })

  it('lists the longest overdue first, then by invoice number', () => {
    const groups = groupBatchItems([
      item(1, 'start', { due_date: '2026-09-10', invoice_number: '20' }),
      item(2, 'start', { due_date: '2026-08-01', invoice_number: '30' }),
      item(3, 'start', { due_date: '2026-09-10', invoice_number: '3' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.labelKey).toBe('batch_kind_start')
    expect(groups[0]!.items.map((i) => i.invoice_number)).toEqual(['30', '3', '20'])
  })
})

describe('ticking ("Bocka ur dem du inte vill skicka")', () => {
  const items = [item(1), item(2, 'start', { remaining_amount: 100.1 }), item(3, 'approve_step', { remaining_amount: 0.2 })]

  it('starts with everything ticked and sends nothing to remove', () => {
    expect(tickedItems(items, [])).toEqual(items)
    expect(removalInvoiceIds(items, [])).toEqual([])
    expect(tickedTotal(items, [])).toBe(1350.3)
  })

  it('unticks and ticks again by kind and invoice', () => {
    const once = toggleUnticked([], batchItemKey(items[1]!))
    expect(once).toEqual([`start:${id(2)}`])
    expect(tickedItems(items, once).map((i) => i.invoice_id)).toEqual([id(1), id(3)])
    expect(removalInvoiceIds(items, once)).toEqual([id(2)])
    expect(tickedTotal(items, once)).toBe(1250.2)
    expect(toggleUnticked(once, batchItemKey(items[1]!))).toEqual([])
  })

  it('ignores an unticked key the batch no longer holds (taken out meanwhile)', () => {
    expect(removalInvoiceIds(items, [`open:${id(7)}`, `open:${id(1)}`])).toEqual([id(1)])
  })
})

describe('batchCanSend', () => {
  it('needs a pending batch, at least one ticked item and the typed word', () => {
    expect(batchCanSend({ status: 'pending', ticked: 2, typed: 'skicka' })).toBe(true)
    expect(batchCanSend({ status: 'pending', ticked: 2, typed: '  Skicka ' })).toBe(true)
    expect(batchCanSend({ status: 'pending', ticked: 2, typed: '' })).toBe(false)
    expect(batchCanSend({ status: 'pending', ticked: 2, typed: 'skick' })).toBe(false)
    expect(batchCanSend({ status: 'pending', ticked: 2, typed: 'send' })).toBe(false)
    expect(batchCanSend({ status: 'pending', ticked: 0, typed: 'skicka' })).toBe(false)
    expect(batchCanSend({ status: 'committed', ticked: 2, typed: 'skicka' })).toBe(false)
    expect(batchCanSend({ status: 'rejected', ticked: 2, typed: 'skicka' })).toBe(false)
  })
})

describe('excluded rows', () => {
  it('reads every reason with its own sentence', () => {
    for (const reason of BATCH_EXCLUDED_REASONS) {
      expect(excludedLine({ reason, block: null })).toEqual({ reasonKey: EXCLUDED_REASON_KEY[reason], detailKey: null })
    }
  })

  it('names the failed requirement of an ineligible invoice when its sentence reads on its own', () => {
    expect(excludedLine({ reason: 'ineligible', block: 'elig_credited' })).toEqual({ reasonKey: 'batch_excluded_ineligible', detailKey: 'elig_credited' })
    expect(excludedLine({ reason: 'ineligible', block: 'debtor_missing_address' }).detailKey).toBe('debtor_missing_address')
    expect(excludedLine({ reason: 'ineligible', block: 'payment_not_reported' }).detailKey).toBe('batch_excluded_payment_not_reported')
    // Needs an amount it does not have, or unknown: the general sentence only.
    expect(excludedLine({ reason: 'ineligible', block: 'elig_below_minimum' }).detailKey).toBeNull()
    expect(excludedLine({ reason: 'ineligible', block: 'something_new' }).detailKey).toBeNull()
    // A block on another reason is not shown.
    expect(excludedLine({ reason: 'response', block: 'elig_paid' }).detailKey).toBeNull()
  })

  it('has a Swedish and an English sentence for every requirement it names', () => {
    expect(BLOCK_SENTENCES.has('debtor_excluded')).toBe(true)
    for (const block of [...BLOCK_SENTENCES, 'payment_not_reported']) {
      const key = excludedLine({ reason: 'ineligible', block }).detailKey!
      for (const messages of [sv, en]) expect((messages.collections as Record<string, string>)[key], key).toBeTruthy()
    }
  })

  it('sorts by reason as listed, then the longest overdue first', () => {
    const rows = sortExcluded([
      excluded(1, 'ineligible', { block: 'elig_paid' }),
      excluded(2, 'bank_stale', { due_date: '2026-09-20' }),
      excluded(3, 'bank_stale', { due_date: '2026-09-02' }),
      excluded(4, 'customer_excluded'),
    ])
    expect(rows.map((r) => r.invoice_number)).toEqual(['1003', '1002', '1004', '1001'])
  })
})

describe('the commit answer', () => {
  const items = [item(1), item(2, 'start'), item(3, 'approve_step')]

  it('reads the result and words each skip with the invoice the dialog showed, in the dialog order', () => {
    const result = parseBatchResult({
      data: {
        batch_date: '2026-10-07',
        done: [{ invoice_id: id(2), kind: 'start', case_id: id(902) }],
        skipped: [
          { invoice_id: id(3), kind: 'approve_step', reason: 'bank', code: 'COLLECTION_BANK_STALE' },
          { invoice_id: id(1), kind: 'open', reason: 'changed', code: 'COLLECTION_REMAINING_CHANGED' },
        ],
        done_count: 1,
        skipped_count: 2,
      },
    })
    expect(result).toMatchObject({ batch_date: '2026-10-07', done_count: 1, skipped_count: 2 })
    expect(skipLines(result!, items)).toEqual([
      { invoice_id: id(1), invoice_number: '1001', customer_name: 'Kund 1 AB', reasonKey: 'batch_skip_changed' },
      { invoice_id: id(3), invoice_number: '1003', customer_name: 'Kund 3 AB', reasonKey: 'batch_skip_bank' },
    ])
  })

  it('reads an unknown skip reason as our own error and fills missing counts', () => {
    const result = parseBatchResult({ data: { skipped: [{ invoice_id: id(1), kind: 'open', reason: 'mystery', code: 'X' }] } })
    expect(result).toEqual({
      batch_date: '',
      done: [],
      skipped: [{ invoice_id: id(1), kind: 'open', reason: 'error', code: 'X' }],
      done_count: 0,
      skipped_count: 1,
    })
    expect(skipLines(result!, [])).toEqual([{ invoice_id: id(1), invoice_number: null, customer_name: null, reasonKey: 'batch_skip_error' }])
  })

  it('answers null for a body without data', () => {
    expect(parseBatchResult(null)).toBeNull()
    expect(parseBatchResult({ error: 'x' })).toBeNull()
  })

  it('words every skip reason', () => {
    const lines = skipLines(
      { skipped: BATCH_SKIP_REASONS.map((reason, n) => ({ invoice_id: id(n), kind: 'open' as const, reason, code: 'X' })) } as Pick<BatchCommitResult, 'skipped'>,
      [],
    )
    expect(lines.map((l) => l.reasonKey)).toEqual(BATCH_SKIP_REASONS.map((r) => SKIP_REASON_KEY[r]))
  })
})

describe('the Att göra deep link', () => {
  it('asks /pending for the batch dialog', () => {
    expect(BATCH_REVIEW_HREF).toBe('/pending?review=collections_daily_batch')
    expect(wantsBatchReview(new URL(`http://x${BATCH_REVIEW_HREF}`).search)).toBe(true)
    expect(wantsBatchReview('?conversation=abc&review=collections_daily_batch')).toBe(true)
    expect(wantsBatchReview('?review=other')).toBe(false)
    expect(wantsBatchReview('')).toBe(false)
  })
})

describe('strings', () => {
  const keys = [
    'batch_title',
    'batch_intro',
    'batch_kind_open',
    'batch_kind_start',
    'batch_kind_approve',
    'batch_col_invoice',
    'batch_col_customer',
    'batch_col_due',
    'batch_col_amount',
    'batch_col_start',
    'batch_col_fee',
    'batch_step_reminder',
    'batch_step_collection',
    'batch_step_approve_reminder',
    'batch_step_approve_collection_notice',
    'batch_fee_yes',
    'batch_fee_no',
    'batch_excluded_heading',
    'batch_excluded_payment_not_reported',
    'batch_confirm',
    'batch_confirm_label',
    'batch_result',
    'batch_skip_heading',
    ...Object.values(EXCLUDED_REASON_KEY),
    ...Object.values(SKIP_REASON_KEY),
    'elig_credited',
    'debtor_missing_address',
  ]

  it('exist in Swedish and English', () => {
    for (const messages of [sv, en]) {
      const collections = messages.collections as Record<string, string>
      for (const key of keys) expect(collections[key], key).toBeTruthy()
    }
  })

  it('keep the spec wording in Swedish', () => {
    const c = sv.collections as Record<string, string>
    expect(c.batch_kind_open).toBe('Ny påminnelse')
    expect(c.batch_excluded_heading).toBe('Inte med i omgången')
    expect(c.batch_skip_connector).toBe('{provider} svarade inte; försök igen från fakturan')
    expect((sv.customers as Record<string, string>).collections_excluded_label).toBe('Skicka aldrig till inkasso')
  })
})
