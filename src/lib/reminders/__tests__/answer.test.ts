import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { loadReminderAnswer, recordReminderAnswer } from '../answer'

function reminderRow(overrides: Record<string, unknown> = {}, invoiceOverrides: Record<string, unknown> = {}) {
  return {
    id: 'rem-1',
    company_id: 'company-1',
    reminder_level: 1,
    response_type: null,
    action_token_used: false,
    interest_amount: 0,
    interest_rate: null,
    interest_days: null,
    reminder_fee: 0,
    invoice: {
      status: 'sent',
      invoice_number: 'F-1042',
      invoice_date: '2026-11-02',
      due_date: '2026-12-02',
      total: 12500,
      vat_amount: 2500,
      currency: 'SEK',
      paid_amount: null,
      deduction_total: null,
      remaining_amount: 12500,
      credited_invoice_id: null,
      ore_rounding: false,
      customer: { name: 'Kund AB', language: 'sv' },
      ...invoiceOverrides,
    },
    ...overrides,
  }
}

function db(reminder: unknown, settings: unknown = { company_name: 'Säljaren AB', ore_rounding: false }) {
  const mock = createTableMockSupabase({ invoice_reminders: { data: reminder }, company_settings: { data: settings } })
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

describe('loadReminderAnswer', () => {
  it('shows what is left to pay, in the customer language, for a sent reminder only', async () => {
    const { client, findCalls } = db(reminderRow({}, { paid_amount: 10000, remaining_amount: 2500, customer: { name: 'Kund AB', language: 'en' } }))

    const answer = await loadReminderAnswer(client, 'tok-1')

    expect(answer?.companyId).toBe('company-1')
    expect(answer?.view).toMatchObject({
      language: 'en',
      companyName: 'Säljaren AB',
      invoiceNumber: 'F-1042',
      amount: 12500,
      paid: 10000,
      remaining: 2500,
      totalDue: 2500,
      feeDueSeparately: 0,
      alreadyResponded: false,
    })
    expect(findCalls('invoice_reminders', 'eq')).toEqual([['action_token', 'tok-1']])
  })

  it('opens the link of a mail the provider took, even when the row never reached sent', async () => {
    const { client, findCalls } = db(reminderRow())
    await loadReminderAnswer(client, 'tok-1')
    // Sent, or reserved/failed with the provider's message id: the mail most likely
    // went out. A reservation the provider never took leads nowhere.
    expect(findCalls('invoice_reminders', 'or')).toEqual([['status.eq.sent,and(status.in.(reserved,failed),provider_message_id.not.is.null)']])
  })

  it("keeps the old sender's fee and interest on its reminders, the fee apart on a foreign invoice", async () => {
    const sek = await loadReminderAnswer(db(reminderRow({ interest_amount: 10, interest_rate: 0.105, interest_days: 30, reminder_fee: 60 })).client, 'tok')
    expect(sek?.view).toMatchObject({ remaining: 12500, totalDue: 12570, feeDueSeparately: 0 })

    const eur = await loadReminderAnswer(db(reminderRow({ reminder_fee: 60 }, { currency: 'EUR', total: 1000, vat_amount: 200, remaining_amount: 1000 })).client, 'tok')
    expect(eur?.view).toMatchObject({ currency: 'EUR', totalDue: 1000, feeDueSeparately: 60, reminderFeeCurrency: 'SEK' })
  })

  it('owes nothing once the books say the invoice is paid', async () => {
    const answer = await loadReminderAnswer(db(reminderRow({}, { remaining_amount: 0, paid_amount: 12500 })).client, 'tok')
    expect(answer?.view).toMatchObject({ remaining: 0, paid: 12500, closedAs: null })
  })

  it('owes nothing on a credited, cancelled or written-off invoice, without calling it paid', async () => {
    for (const status of ['credited', 'cancelled', 'written_off'] as const) {
      // Crediting changes the status, not remaining_amount.
      const answer = await loadReminderAnswer(
        db(reminderRow({ reminder_fee: 60, interest_amount: 10 }, { status, remaining_amount: 12500 })).client,
        'tok',
      )
      expect(answer?.view).toMatchObject({ closedAs: status, remaining: 0, paid: 0, totalDue: 0, feeDueSeparately: 0 })
    }
    const open = await loadReminderAnswer(db(reminderRow({}, { status: 'overdue' })).client, 'tok')
    expect(open?.view).toMatchObject({ closedAs: null, remaining: 12500 })
  })

  it('knows no other token', async () => {
    expect(await loadReminderAnswer(db(null).client, 'nope')).toBeNull()
  })
})

describe('recordReminderAnswer', () => {
  const NOW = new Date('2026-12-20T09:00:00Z')

  it('records the answer and the note once', async () => {
    const mock = createTableMockSupabase({
      invoice_reminders: [{ data: reminderRow() }, { data: [{ id: 'rem-1' }] }],
    })
    const result = await recordReminderAnswer(mock.supabase as unknown as SupabaseClient, {
      token: 'tok-1',
      action: 'disputed',
      note: 'Fel antal timmar',
      now: NOW,
    })
    expect(result).toBe('recorded')
    expect(mock.payloads('invoice_reminders', 'update')).toEqual([
      { response_type: 'disputed', response_at: NOW.toISOString(), action_token_used: true, response_note: 'Fel antal timmar' },
    ])
    // Only an unused link is written.
    expect(mock.findCalls('invoice_reminders', 'eq')).toContainEqual(['action_token_used', false])
  })

  it('refuses an unknown token and a used link', async () => {
    const unknown = createTableMockSupabase({ invoice_reminders: { data: null } })
    expect(await recordReminderAnswer(unknown.supabase as unknown as SupabaseClient, { token: 'x', action: 'marked_paid', note: null, now: NOW })).toBe(
      'not_found',
    )
    const used = createTableMockSupabase({ invoice_reminders: { data: reminderRow({ action_token_used: true }) } })
    expect(await recordReminderAnswer(used.supabase as unknown as SupabaseClient, { token: 'x', action: 'marked_paid', note: null, now: NOW })).toBe(
      'already_answered',
    )
    expect(used.payloads('invoice_reminders', 'update')).toEqual([])
  })

  it('answers already_answered when another answer won the race', async () => {
    const mock = createTableMockSupabase({ invoice_reminders: [{ data: reminderRow() }, { data: [] }] })
    expect(await recordReminderAnswer(mock.supabase as unknown as SupabaseClient, { token: 't', action: 'marked_paid', note: null, now: NOW })).toBe(
      'already_answered',
    )
  })

  it('keeps the answer without the note while the note column is not there yet', async () => {
    let updates = 0
    const answerOrMissingColumn: TableMockResolver = (calls) => {
      if (!calls.some((c) => c.method === 'update')) return { data: reminderRow() }
      updates++
      return updates === 1 ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'response_note' column" } } : { data: [{ id: 'rem-1' }] }
    }
    const mock = createTableMockSupabase({ invoice_reminders: answerOrMissingColumn })
    expect(await recordReminderAnswer(mock.supabase as unknown as SupabaseClient, { token: 't', action: 'marked_paid', note: 'Betalt 3/12', now: NOW })).toBe(
      'recorded',
    )
    expect(mock.payloads('invoice_reminders', 'update')).toEqual([
      expect.objectContaining({ response_note: 'Betalt 3/12' }),
      { response_type: 'marked_paid', response_at: NOW.toISOString(), action_token_used: true },
    ])
  })
})
