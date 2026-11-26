/**
 * gatherDailyBatch with a backlog of cases awaiting a decision.
 *
 * The ladder cron gathers every open case waiting for approval of its next
 * step and reads their invoices by id with `.in()`. supabase-js puts the ids
 * in the GET query string, about 39 characters a uuid, so a backlog of a few
 * hundred cases passed a self-hosted Kong's 8 KB, the read was refused and the
 * company's whole daily batch failed. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { gatherDailyBatch } from '../autopilot'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const CONNECTION = '9a8b7c6d-0000-4000-8000-000000000001'
const CASES = 250
const NOW = new Date('2026-10-06T06:00:00Z')

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const invoiceId = (n: number) => uuid(n, '11111111')

describe('gatherDailyBatch: a backlog of decisions', () => {
  it('lists every case awaiting a decision with its invoice, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase({
      collection_cases: range(CASES).map((n) => ({
        id: uuid(n, 'cccccccc'),
        company_id: COMPANY,
        invoice_id: invoiceId(n),
        connection_id: CONNECTION,
        is_open: true,
        stage: 'awaiting_decision',
        submission_status: 'registered',
        decision_kind: n % 2 === 0 ? 'approve_collection_notice' : 'approve_reminder',
        actions: ['approve_step'],
        claim_amount: 1250,
      })),
      invoices: range(CASES).map((n) => ({
        id: invoiceId(n),
        company_id: COMPANY,
        invoice_number: String(40000 + n),
        status: 'overdue',
        document_type: 'invoice',
        credited_invoice_id: null,
        total: 1250,
        remaining_amount: 1250,
        // Handed over by hand before the ladder's days: its scan of overdue
        // invoices passes them by, and only the decisions read them.
        due_date: '2026-10-01',
        // "Skicka aldrig till inkasso": each case is listed as excluded on
        // what the invoice read says, with no escalation check behind it.
        customer: { name: `Kund ${n}`, collections_excluded: true },
      })),
    })

    const batch = await gatherDailyBatch(supabase, {
      companyId: COMPANY,
      connection: {
        id: CONNECTION,
        minimum_amount: 100,
        reminder_fee_terms_since: '2026-01-01',
        default_start_step: 'reminder',
        ladder_days_after_due: 10,
      },
      features: null,
      now: NOW,
    })

    expect(batch.items).toEqual([])
    expect(batch.excluded).toEqual(
      range(CASES).map((n) => ({
        kind: 'approve_step',
        invoice_id: invoiceId(n),
        invoice_number: String(40000 + n),
        customer_name: `Kund ${n}`,
        due_date: '2026-10-01',
        reason: 'customer_excluded',
        block: null,
      })),
    )
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    // The ladder's scan names no ids; the decisions' invoices come 100 at a time.
    expect(requestsTo('invoices').map((r) => inListOf(r, 'id').length)).toEqual([0, 100, 100, 50])
    expect(unmodelled).toEqual([])
  })
})
