/**
 * buildCompanyGraph for a company with many matched payments.
 *
 * A matched obligation ties its agreement to the accounts that paid it,
 * through its bank transaction. The graph reads those transactions by id
 * with `.in()`, and supabase-js puts the ids in the GET query string: 205
 * uuids already pass a self-hosted Kong's 8 KB, so the read was refused and
 * the whole graph failed. The fake gateway (tests/gateway-supabase.ts)
 * refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { buildCompanyGraph } from '../build'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const CO = 'cccccccc-0000-4000-8000-000000000001'
const TODAY = '2026-10-01'
const AGREEMENTS = 25
const MONTHS = 10

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
/** The 28th of the month, MONTHS months up to September 2026. */
const dueOn = (month: number) => new Date(Date.UTC(2025, 11 + month, 28)).toISOString().slice(0, 10)

/** AGREEMENTS loans, each paid monthly for MONTHS months: one matched obligation, bank row and verifikat per payment. */
function books() {
  const agreements = []
  const obligations = []
  const transactions = []
  const lines = []
  for (let a = 1; a <= AGREEMENTS; a++) {
    agreements.push({ id: uuid(a, 'a0000000'), company_id: CO, title: `Lån ${a}`, kind: 'loan', status: 'active', ends_on: '2031-01-31', amount: null, period: 'monthly', principal: 500000, counterparty_party_id: null, counterparty_name: `Banken ${a}`, source_document_id: null })
    for (let m = 0; m < MONTHS; m++) {
      const n = a * 100 + m
      const date = dueOn(m)
      obligations.push({ id: uuid(n, 'b0000000'), company_id: CO, agreement_id: uuid(a, 'a0000000'), kind: 'amortisation', due_on: date, amount: 1000, status: 'matched', transaction_id: uuid(n, 'c0000000'), direction: 'out' })
      transactions.push({ id: uuid(n, 'c0000000'), company_id: CO, journal_entry_id: uuid(n, 'd0000000') })
      const entry = { entry_date: date, status: 'posted', source_type: 'bank_transaction', source_id: null, company_id: CO }
      lines.push(
        { id: uuid(n * 2, 'e0000000'), account_number: '2350', debit_amount: 1000, credit_amount: 0, journal_entry_id: uuid(n, 'd0000000'), journal_entries: entry },
        { id: uuid(n * 2 + 1, 'e0000000'), account_number: '1930', debit_amount: 0, credit_amount: 1000, journal_entry_id: uuid(n, 'd0000000'), journal_entries: entry },
      )
    }
  }
  return {
    companies: [{ id: CO, name: 'Exempelbolaget AB' }],
    agreements,
    agreement_obligations: obligations,
    transactions,
    journal_entry_lines: lines,
  }
}

describe('buildCompanyGraph: many matched payments', () => {
  it('ties every agreement to the accounts that paid it, in requests the gateway takes', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(books())

    const graph = await buildCompanyGraph(supabase, CO, TODAY)

    const matched = graph.links.filter((l) => l.kind === 'matched')
    expect(matched).toHaveLength(AGREEMENTS * 2)
    for (let a = 1; a <= AGREEMENTS; a++) {
      for (const account of ['2350', '1930']) {
        expect(matched).toContainEqual({ source: `agreement:${uuid(a, 'a0000000')}`, target: `account:${account}`, kind: 'matched', evidence: { kind: 'match', amount: 1000 * MONTHS, payments: MONTHS } })
      }
    }
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    // The 250 matched transactions by id, 100 at a time, then the booked rows of the period.
    expect(requestsTo('transactions').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 50, 0])
    expect(unmodelled).toEqual([])
  })

  it('fails the graph when a slice of the matched transactions cannot be read', async () => {
    const { supabase } = createGatewaySupabase(books(), {
      refuse: (request) => request.table === 'transactions' && inListOf(request, 'id').length === 50,
    })

    await expect(buildCompanyGraph(supabase, CO, TODAY)).rejects.toThrow('graph read failed: canceling statement due to statement timeout')
  })
})
