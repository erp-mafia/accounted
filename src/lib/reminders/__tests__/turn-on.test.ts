import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { DEFAULT_REMINDER_DAYS } from '../policy'
import {
  checkReminderDays,
  isPickedSkipReason,
  mergeSendResults,
  PICKED_SEND_MAX,
  PICKED_SKIP_REASONS,
  reminderDaysChanged,
  reminderDaysInput,
  reminderSettingsBody,
  resultSentenceKey,
  sendBatches,
  summariseSendResults,
  TURN_ON_OFFER_NOTICE_ID,
  turnOnEntry,
  type PickedSendResult,
} from '../turn-on'

const OFF = { available: true, enabled: false, collectionsConnected: false, offerableCount: 3 }

describe('turnOnEntry', () => {
  it('offers turning on when reminders are off and an overdue invoice could be offered', () => {
    expect(turnOnEntry(OFF)).toBe('offer')
  })

  it('offers nothing while the product switch is off, whatever the company says', () => {
    expect(turnOnEntry({ ...OFF, available: false })).toBeNull()
    expect(turnOnEntry({ ...OFF, available: false, enabled: true })).toBeNull()
  })

  it('offers nothing before the overview has loaded', () => {
    expect(turnOnEntry(null)).toBeNull()
  })

  it('offers nothing when no overdue invoice could be offered (a migrated backlog)', () => {
    expect(turnOnEntry({ ...OFF, offerableCount: 0 })).toBeNull()
  })

  it('offers nothing when a collections provider reminds the customers', () => {
    expect(turnOnEntry({ ...OFF, collectionsConnected: true })).toBeNull()
  })

  it('shows the status control once reminders are on, also beside a collections connection', () => {
    expect(turnOnEntry({ ...OFF, enabled: true })).toBe('status')
    expect(turnOnEntry({ ...OFF, enabled: true, offerableCount: 0, collectionsConnected: true })).toBe('status')
  })
})

describe('checkReminderDays', () => {
  it('accepts the defaults', () => {
    expect(checkReminderDays(reminderDaysInput(DEFAULT_REMINDER_DAYS))).toEqual({ ok: true, days: [15, 30, 45] })
  })

  it('accepts the bounds and trims what was typed', () => {
    expect(checkReminderDays([' 1', '2 ', '365'])).toEqual({ ok: true, days: [1, 2, 365] })
  })

  it('refuses an empty field, a decimal and a sign, naming the field', () => {
    expect(checkReminderDays(['', '30', '45'])).toEqual({ ok: false, error: 'whole_number', level: 1 })
    expect(checkReminderDays(['15', '30.5', '45'])).toEqual({ ok: false, error: 'whole_number', level: 2 })
    expect(checkReminderDays(['15', '30', '-45'])).toEqual({ ok: false, error: 'whole_number', level: 3 })
  })

  it('refuses days outside 1 to 365', () => {
    expect(checkReminderDays(['0', '30', '45'])).toEqual({ ok: false, error: 'range', level: 1 })
    expect(checkReminderDays(['15', '30', '366'])).toEqual({ ok: false, error: 'range', level: 3 })
  })

  it('refuses a level that is not later than the one before', () => {
    expect(checkReminderDays(['15', '15', '45'])).toEqual({ ok: false, error: 'ascending', level: 2 })
    expect(checkReminderDays(['15', '30', '20'])).toEqual({ ok: false, error: 'ascending', level: 3 })
  })
})

describe('reminderDaysChanged', () => {
  it('is false for the saved days, also with leading zeros or spaces', () => {
    expect(reminderDaysChanged(['15', '30', '45'], [15, 30, 45])).toBe(false)
    expect(reminderDaysChanged(['015', ' 30', '45'], [15, 30, 45])).toBe(false)
  })

  it('is true for other days and for a field that does not read', () => {
    expect(reminderDaysChanged(['10', '30', '45'], [15, 30, 45])).toBe(true)
    expect(reminderDaysChanged(['', '30', '45'], [15, 30, 45])).toBe(true)
  })
})

describe('reminderSettingsBody', () => {
  it('turns on with the days', () => {
    expect(reminderSettingsBody({ on: true, days: [10, 20, 30] })).toEqual({
      send_invoice_reminders: true,
      reminder_days_level_1: 10,
      reminder_days_level_2: 20,
      reminder_days_level_3: 30,
    })
  })

  it('saves the days alone without touching the toggle (which would move reminders_enabled_at)', () => {
    expect(reminderSettingsBody({ days: [10, 20, 30] })).not.toHaveProperty('send_invoice_reminders')
  })

  it('turns off alone', () => {
    expect(reminderSettingsBody({ on: false })).toEqual({ send_invoice_reminders: false })
  })
})

describe('sendBatches', () => {
  it('drops repeats and splits at the route limit', () => {
    const ids = Array.from({ length: PICKED_SEND_MAX + 3 }, (_, i) => `id-${i}`)
    const batches = sendBatches([...ids, 'id-0'])
    expect(batches.map((b) => b.length)).toEqual([PICKED_SEND_MAX, 3])
    expect(batches.flat()).toEqual(ids)
  })

  it('answers no call for no pick', () => {
    expect(sendBatches([])).toEqual([])
  })
})

describe('resultSentenceKey', () => {
  it('names sent, failed and each skip reason', () => {
    expect(resultSentenceKey({ status: 'sent' })).toBe('result_sent')
    expect(resultSentenceKey({ status: 'failed' })).toBe('result_failed')
    expect(resultSentenceKey({ status: 'skipped', reason: 'bank_not_fresh' })).toBe('skip_bank_not_fresh')
    expect(resultSentenceKey({ status: 'skipped', reason: 'not_found' })).toBe('skip_not_found')
  })

  it('falls back to a general sentence for a reason it does not know', () => {
    expect(resultSentenceKey({ status: 'skipped', reason: 'something_new' })).toBe('skip_other')
    expect(resultSentenceKey({ status: 'skipped' })).toBe('skip_other')
    expect(isPickedSkipReason('toString')).toBe(false)
  })

  it('has a sentence in both languages for every key it can answer', () => {
    const keys = ['result_sent', 'result_failed', 'skip_other', ...PICKED_SKIP_REASONS.map((r) => `skip_${r}`)]
    for (const catalog of [sv, en] as unknown as Array<Record<string, Record<string, string>>>) {
      const missing = keys.filter((key) => typeof catalog.reminders_setup?.[key] !== 'string')
      expect(missing).toEqual([])
    }
  })
})

describe('summariseSendResults', () => {
  const results: PickedSendResult[] = [
    { invoice_id: 'a', status: 'sent', level: 1 },
    { invoice_id: 'b', status: 'skipped', reason: 'bank_not_fresh' },
    { invoice_id: 'c', status: 'skipped', reason: 'possible_payment' },
    { invoice_id: 'd', status: 'failed', code: 'SEND_ERROR' },
  ]

  it('counts each outcome and lists the invoices the bank held back', () => {
    expect(summariseSendResults(results)).toEqual({ sent: 1, skipped: 2, failed: 1, bankRetryIds: ['b'] })
  })

  it('lets an attested retry replace the first answer, in the first order', () => {
    const merged = mergeSendResults(results, [{ invoice_id: 'b', status: 'sent', level: 1 }])
    expect(merged.map((r) => `${r.invoice_id}:${r.status}`)).toEqual(['a:sent', 'b:sent', 'c:skipped', 'd:failed'])
    expect(summariseSendResults(merged).bankRetryIds).toEqual([])
  })

  it('keeps an answer for an invoice the first call did not have', () => {
    expect(mergeSendResults([], [{ invoice_id: 'x', status: 'sent' }])).toHaveLength(1)
  })
})

describe('TURN_ON_OFFER_NOTICE_ID', () => {
  it('has no category prefix, so the notices read never reaps the dismissal', () => {
    expect(TURN_ON_OFFER_NOTICE_ID).not.toContain(':')
  })
})
