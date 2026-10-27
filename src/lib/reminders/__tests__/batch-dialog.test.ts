import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toggleUnticked } from '@/lib/collections/batch-dialog'
import { REMINDER_BATCH_EXCLUDED_REASONS, REMINDER_BATCH_SKIP_REASONS, type ReminderBatchExcluded, type ReminderBatchItem } from '../batch'
import {
  REMINDER_BATCH_REVIEW_HREF,
  REMINDER_EXCLUDED_REASON_KEY,
  REMINDER_SKIP_REASON_KEY,
  bankWarnings,
  parseReminderBatchResult,
  reminderBatchCanSend,
  reminderLevelKey,
  reminderRemovalIds,
  reminderRunItems,
  reminderSkipLines,
  sortReminderExcluded,
  sortReminderItems,
  tickedReminderItems,
  tickedReminderTotals,
  wantsReminderBatchReview,
} from '../batch-dialog'

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function item(n: number, overrides: Partial<ReminderBatchItem> = {}): ReminderBatchItem {
  return {
    kind: 'reminder',
    invoice_id: ID(n),
    invoice_number: String(1000 + n),
    customer_name: `Kund ${n}`,
    recipient: `kund${n}@example.se`,
    due_date: '2026-10-01',
    level: 1,
    remaining_amount: 100,
    currency: 'SEK',
    bank: 'fresh',
    ...overrides,
  }
}

function excluded(n: number, reason: ReminderBatchExcluded['reason'], due = '2026-10-01'): ReminderBatchExcluded {
  return { invoice_id: ID(n), invoice_number: String(1000 + n), customer_name: `Kund ${n}`, due_date: due, reason }
}

const messages = (lang: 'sv' | 'en') =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../messages/${lang}.json`, import.meta.url)), 'utf8')) as {
    reminders: Record<string, string>
  }

describe('the sentences the review reads', () => {
  it('has a sentence for every excluded reason, skip reason and level, in both languages and without dashes', () => {
    const keys = [
      ...REMINDER_BATCH_EXCLUDED_REASONS.map((reason) => REMINDER_EXCLUDED_REASON_KEY[reason]),
      ...REMINDER_BATCH_SKIP_REASONS.map((reason) => REMINDER_SKIP_REASON_KEY[reason]),
      reminderLevelKey(1),
      reminderLevelKey(2),
      reminderLevelKey(3),
      'batch_bank_stale',
      'batch_bank_none',
      'batch_bank_stale_all',
      'batch_bank_none_all',
    ]
    for (const lang of ['sv', 'en'] as const) {
      const reminders = messages(lang).reminders
      for (const key of keys) {
        expect(reminders[key], `${lang} reminders.${key}`).toBeTruthy()
        expect(reminders[key], `${lang} reminders.${key}`).not.toMatch(/[–—]/)
      }
    }
  })
})

describe('bankWarnings', () => {
  it('warns on the rows the bank could not check, and on nothing else', () => {
    const warnings = bankWarnings([item(1), item(2, { bank: 'stale' }), item(3, { bank: 'no_bank' })])
    expect(warnings.allKey).toBeNull()
    expect([...warnings.rowKeys]).toEqual([
      [ID(2), 'batch_bank_stale'],
      [ID(3), 'batch_bank_none'],
    ])
  })

  it('says a warning every row shares once, above the table, instead of on every row', () => {
    expect(bankWarnings([item(1, { bank: 'no_bank' }), item(2, { bank: 'no_bank' })])).toEqual({ allKey: 'batch_bank_none_all', rowKeys: new Map() })
    expect(bankWarnings([item(1, { bank: 'stale' })])).toEqual({ allKey: 'batch_bank_stale_all', rowKeys: new Map() })
  })

  it('says nothing when the bank checked every invoice, or there are none', () => {
    expect(bankWarnings([item(1), item(2)])).toEqual({ allKey: null, rowKeys: new Map() })
    expect(bankWarnings([])).toEqual({ allKey: null, rowKeys: new Map() })
  })
})

describe('ticking', () => {
  const items = [item(1), item(2, { remaining_amount: 250.5 }), item(3, { currency: 'EUR', remaining_amount: 40.1 }), item(4, { currency: 'EUR', remaining_amount: 0.2 })]

  it('keeps everything ticked until the person unticks it, and toggles back', () => {
    expect(tickedReminderItems(items, [])).toEqual(items)
    const unticked = toggleUnticked([], ID(2))
    expect(tickedReminderItems(items, unticked).map((i) => i.invoice_id)).toEqual([ID(1), ID(3), ID(4)])
    expect(tickedReminderItems(items, toggleUnticked(unticked, ID(2)))).toEqual(items)
  })

  it('takes out only unticked invoices still in the batch, each once', () => {
    expect(reminderRemovalIds(items, [])).toEqual([])
    expect(reminderRemovalIds(items, [ID(3), ID(3), ID(9)])).toEqual([ID(3)])
  })

  it('totals what is left per currency, the ledger currency first, to the öre', () => {
    expect(tickedReminderTotals(items, [])).toEqual([
      { currency: 'SEK', amount: 350.5 },
      { currency: 'EUR', amount: 40.3 },
    ])
    expect(tickedReminderTotals(items, [ID(1), ID(2)])).toEqual([{ currency: 'EUR', amount: 40.3 }])
    expect(tickedReminderTotals(items, items.map((i) => i.invoice_id))).toEqual([])
  })

  it('sorts other currencies by code after the ledger currency', () => {
    const mixed = [item(1, { currency: 'USD' }), item(2, { currency: 'EUR' }), item(3)]
    expect(tickedReminderTotals(mixed, []).map((t) => t.currency)).toEqual(['SEK', 'EUR', 'USD'])
  })

  it('sends only a pending batch with something ticked, without a typed word', () => {
    expect(reminderBatchCanSend({ status: 'pending', ticked: 1 })).toBe(true)
    expect(reminderBatchCanSend({ status: 'pending', ticked: 0 })).toBe(false)
    expect(reminderBatchCanSend({ status: 'committed', ticked: 3 })).toBe(false)
  })
})

describe('order', () => {
  it('lists the longest overdue first, then by invoice number as numbers', () => {
    const sorted = sortReminderItems([
      item(1, { due_date: '2026-10-05', invoice_number: '10' }),
      item(2, { due_date: '2026-09-30', invoice_number: '9' }),
      item(3, { due_date: '2026-10-05', invoice_number: '9' }),
    ])
    expect(sorted.map((i) => i.invoice_id)).toEqual([ID(2), ID(3), ID(1)])
  })

  it('lists the left-out invoices by reason, then the longest overdue first', () => {
    const sorted = sortReminderExcluded([
      excluded(1, 'complete'),
      excluded(2, 'no_email', '2026-10-02'),
      excluded(3, 'possible_payment'),
      excluded(4, 'no_email', '2026-09-01'),
    ])
    expect(sorted.map((r) => r.invoice_id)).toEqual([ID(3), ID(4), ID(2), ID(1)])
  })
})

describe('the result', () => {
  const shown = [item(1), item(2), item(3)]

  it('reads the commit answer', () => {
    const json = {
      data: {
        batch_date: '2026-10-26',
        sent: [{ invoice_id: ID(1), level: 1, reminder_id: 'r1' }],
        skipped: [{ invoice_id: ID(2), reason: 'paid', code: 'paid' }],
        sent_count: 1,
        skipped_count: 1,
      },
    }
    expect(parseReminderBatchResult(json)).toEqual(json.data)
  })

  it('reads an odd answer as nothing sent, and an unknown skip reason as our own error', () => {
    expect(parseReminderBatchResult(null)).toBeNull()
    expect(parseReminderBatchResult({ data: 'x' })).toBeNull()
    expect(parseReminderBatchResult({ data: { sent: 'x', skipped: [{ invoice_id: ID(2), reason: 'gone' }, null, { reason: 'paid' }] } })).toEqual({
      batch_date: '',
      sent: [],
      skipped: [{ invoice_id: ID(2), reason: 'error', code: '' }],
      sent_count: 0,
      skipped_count: 1,
    })
  })

  it('names each skipped invoice as the dialog showed it, in the dialog order', () => {
    const lines = reminderSkipLines(
      {
        skipped: [
          { invoice_id: ID(3), reason: 'failed', code: 'smtp' },
          { invoice_id: ID(9), reason: 'error', code: 'x' },
          { invoice_id: ID(1), reason: 'bank', code: 'bank_stale' },
        ],
      },
      shown,
    )
    expect(lines).toEqual([
      { invoice_id: ID(1), invoice_number: '1001', customer_name: 'Kund 1', reasonKey: 'batch_skip_bank' },
      { invoice_id: ID(3), invoice_number: '1003', customer_name: 'Kund 3', reasonKey: 'batch_skip_failed' },
      { invoice_id: ID(9), invoice_number: null, customer_name: null, reasonKey: 'batch_skip_error' },
    ])
  })
})

describe('the deep link and the run items', () => {
  it('opens the reminder batch, not the collections one', () => {
    expect(REMINDER_BATCH_REVIEW_HREF).toBe('/pending?review=reminder_daily_batch')
    expect(wantsReminderBatchReview('?review=reminder_daily_batch')).toBe(true)
    expect(wantsReminderBatchReview('?review=collections_daily_batch')).toBe(false)
    expect(wantsReminderBatchReview('')).toBe(false)
  })

  it('reads the staged items less the removed ones, and nothing from odd params', () => {
    const params = { batch_date: '2026-10-26', items: [item(1), item(2), null, 'x', { kind: 'reminder' }], excluded: [] }
    expect(reminderRunItems(params).map((i) => i.invoice_id)).toEqual([ID(1), ID(2)])
    expect(reminderRunItems(params, [ID(1)]).map((i) => i.invoice_id)).toEqual([ID(2)])
    expect(reminderRunItems(null)).toEqual([])
    expect(reminderRunItems({ items: 'x' })).toEqual([])
  })
})
