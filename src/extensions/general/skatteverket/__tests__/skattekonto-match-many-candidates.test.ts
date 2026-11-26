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
import { findGroupMatchCandidates, findMatchSuggestionsBulk } from '../lib/skattekonto-match'
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

describe('findGroupMatchCandidates: a verifikat whose links sit past the first 1000 rows', () => {
  it('reads every linked row, so a verifikat a link already settles is not offered', async () => {
    const free = uuid(1, 'eeeeeeee')
    const taken = uuid(2, 'eeeeeeee')
    const fillers = Array.from({ length: 20 }, (_, i) => uuid(100 + i, 'eeeeeeee'))
    const entry = (id: string, n: number) => ({
      id, company_id: COMPANY, voucher_number: n, voucher_series: 'A', entry_date: '2026-08-11', description: `Inbetalning ${n}`, status: 'posted',
    })
    const line = (id: string, n: number) => ({ id: uuid(n, 'dddddddd'), journal_entry_id: id, account_number: '1630', debit_amount: 500, credit_amount: 0 })
    const selected = (n: number, belopp: number) => ({
      id: uuid(n, 'cccccccc'), company_id: COMPANY, transaktionsdatum: '2026-08-12', transaktionstext: 'Inbetalning bokförd',
      belopp_skatteverket: belopp, journal_entry_id: null, is_ignored: false, status: 'booked',
    })
    // Twenty group-linked verifikat with 50 rows each fill the first 1000
    // linked rows; the row that settles `taken` sorts after them.
    const fillerLinks = fillers.flatMap((id, k) =>
      Array.from({ length: 50 }, (_, i) => ({ id: uuid(k * 50 + i + 1, '10000000'), company_id: COMPANY, journal_entry_id: id, belopp_skatteverket: 10 })),
    )
    const { supabase, unmodelled } = createGatewaySupabase({
      skattekonto_transactions: [
        selected(1, 300),
        selected(2, 200),
        ...fillerLinks,
        { id: uuid(1, 'ffffffff'), company_id: COMPANY, journal_entry_id: taken, belopp_skatteverket: 500 },
      ],
      journal_entries: [entry(free, 1), entry(taken, 2), ...fillers.map((id, i) => entry(id, 10 + i))],
      journal_entry_lines: [line(free, 1), line(taken, 2), ...fillers.map((id, i) => line(id, 10 + i))],
    })

    const { candidates } = await findGroupMatchCandidates(supabase, COMPANY, [uuid(1, 'cccccccc'), uuid(2, 'cccccccc')], '1630')

    expect(candidates.map((c) => c.journal_entry_id)).toEqual([free])
    expect(unmodelled).toEqual([])
  })
})
