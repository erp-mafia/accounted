/**
 * findMatchSuggestionsBulk when the open rows' window holds many verifikat on
 * the skattekonto account.
 *
 * The matcher reads the SKV rows already linked to its candidates by
 * verifikat id with `.in()`, and supabase-js puts the ids in the GET query
 * string. With a few hundred candidates the gateway refused that read before
 * PostgREST saw it, and the matcher answered no suggestions at all (the
 * proposal refresh then cleared every stored one). The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past a self-hosted Kong's 8 KB,
 * the stricter of the two limits.
 */
import { describe, expect, it } from 'vitest'
import { findMatchSuggestionsBulk } from '../lib/skattekonto-match'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const CANDIDATES = 250

/** 250 inbetalningar of 5 000 kr on 1630 in the window; every one but the last is linked to its SKV row. */
function busyAccount() {
  const entry = (n: number) => uuid(n, 'eeeeeeee')
  return {
    journal_entries: Array.from({ length: CANDIDATES }, (_, i) => ({
      id: entry(i + 1), company_id: COMPANY, voucher_number: i + 1, voucher_series: 'A', entry_date: '2026-08-11',
      description: `Inbetalning skattekonto ${i + 1}`, status: 'posted',
    })),
    journal_entry_lines: Array.from({ length: CANDIDATES }, (_, i) => ({
      id: uuid(i + 1, 'dddddddd'), journal_entry_id: entry(i + 1), account_number: '1630', debit_amount: 5000, credit_amount: 0,
    })),
    skattekonto_transactions: Array.from({ length: CANDIDATES - 1 }, (_, i) => ({
      id: uuid(i + 1, 'aaaaaaaa'), company_id: COMPANY, journal_entry_id: entry(i + 1), belopp_skatteverket: 5000,
    })),
  }
}

const open = { id: 'row-open', transaktionsdatum: '2026-08-12', transaktionstext: 'Inbetalning bokförd', belopp_skatteverket: 5000, journal_entry_id: null }

describe('findMatchSuggestionsBulk: many verifikat on the account in the window', () => {
  it('reads the links of 250 candidates in requests the gateway takes, and proposes the one still free', async () => {
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(busyAccount())

    const suggestions = await findMatchSuggestionsBulk(supabase, COMPANY, [open], '1630')

    expect(suggestions.get('row-open')?.journal_entry_id).toBe(uuid(CANDIDATES, 'eeeeeeee'))
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    const linkedReads = requestsTo('skattekonto_transactions').filter((r) => inListOf(r, 'journal_entry_id').length > 0)
    expect(linkedReads.map((r) => inListOf(r, 'journal_entry_id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })

  it('answers no suggestions when a slice of the links cannot be read, as for any failed read', async () => {
    let linkedRead = 0
    const { supabase } = createGatewaySupabase(busyAccount(), {
      refuse: (request) =>
        request.table === 'skattekonto_transactions' && inListOf(request, 'journal_entry_id').length > 0 && ++linkedRead === 2,
    })

    const suggestions = await findMatchSuggestionsBulk(supabase, COMPANY, [open], '1630')

    expect(suggestions.size).toBe(0)
  })
})
