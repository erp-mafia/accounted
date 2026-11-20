import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createTableMockSupabase } from '@/tests/helpers'

/**
 * The public endpoint that records a customer's answer to a reminder, posted
 * by /invoice-action/[token]. The link token is the only credential. What the
 * page shows (amounts, the old sender's SEK fee kept apart) is tested with
 * src/lib/reminders/answer.ts.
 */

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => db.current }))

import { POST } from '../route'

function reminderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'reminder-1',
    company_id: 'company-1',
    reminder_level: 1,
    response_type: null,
    action_token_used: false,
    interest_amount: 10,
    interest_rate: 0.105,
    interest_days: 30,
    reminder_fee: 60,
    invoice: {
      status: 'overdue',
      invoice_number: 'F2026011',
      invoice_date: '2026-04-15',
      due_date: '2026-05-01',
      total: 1000,
      vat_amount: 200,
      currency: 'EUR',
      paid_amount: null,
      deduction_total: null,
      remaining_amount: 1000,
      credited_invoice_id: null,
      ore_rounding: false,
      customer: { name: 'Erik Andersson', language: 'sv' },
    },
    ...overrides,
  }
}

function useDb(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase({ company_settings: { data: { company_name: 'Säljaren AB', ore_rounding: false } }, ...tables })
  db.current = mock.supabase
  return mock
}

// The route's rate limits are module-level state shared across this file:
// each test uses its own tokens and client addresses.
const post = (body: unknown, headers?: Record<string, string>) =>
  POST(createMockRequest('/api/invoices/reminders/action', { method: 'POST', body, headers }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/invoices/reminders/action', () => {
  it('validates the token, the action and the note', async () => {
    useDb({ invoice_reminders: { data: reminderRow() } })
    expect((await post({ action: 'marked_paid' })).status).toBe(400)
    expect((await post({ token: 'tok', action: 'paid_twice' })).status).toBe(400)
    expect((await post({ token: 'tok', action: 'disputed', note: 42 })).status).toBe(400)
    expect((await post({ token: 'tok', action: 'disputed', note: 'x'.repeat(1001) })).status).toBe(400)
  })

  it('records an answer with its note', async () => {
    const mock = useDb({ invoice_reminders: [{ data: reminderRow() }, { data: [{ id: 'reminder-1' }] }] })
    const response = await post({ token: 'tok', action: 'disputed', note: '  Fel antal timmar  ' })
    expect(response.status).toBe(200)
    expect(mock.payloads('invoice_reminders', 'update')).toEqual([
      expect.objectContaining({ response_type: 'disputed', response_note: 'Fel antal timmar' }),
    ])
  })

  it('answers 404 for an unknown link and 409 for a used one', async () => {
    useDb({ invoice_reminders: { data: null } })
    expect((await post({ token: 'nope', action: 'marked_paid' })).status).toBe(404)
    useDb({ invoice_reminders: { data: reminderRow({ action_token_used: true }) } })
    expect((await post({ token: 'tok', action: 'marked_paid' })).status).toBe(409)
  })

  it('answers 429 once a link is over its budget, before reading the database', async () => {
    useDb({ invoice_reminders: { data: reminderRow({ action_token_used: true }) } })
    for (let i = 0; i < 10; i++) expect((await post({ token: 'tok-budget', action: 'marked_paid' })).status).toBe(409)
    const mock = useDb({ invoice_reminders: { data: reminderRow({ action_token_used: true }) } })
    const limited = await post({ token: 'tok-budget', action: 'marked_paid' })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'RATE_LIMITED' })
    expect(mock.tables()).toEqual([])
  })

  it('answers 429 to a client trying one made-up token after another', async () => {
    useDb({ invoice_reminders: { data: null } })
    const from = { 'x-forwarded-for': '203.0.113.7' }
    for (let i = 0; i < 60; i++) expect((await post({ token: `guess-${i}`, action: 'marked_paid' }, from)).status).toBe(404)
    expect((await post({ token: 'guess-60', action: 'marked_paid' }, from)).status).toBe(429)
    // Another network keeps its own budget.
    expect((await post({ token: 'guess-61', action: 'marked_paid' }, { 'x-forwarded-for': '198.51.100.7' })).status).toBe(404)
  })
})
