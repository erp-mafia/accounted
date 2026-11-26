/**
 * listRotRutPayoutVoucherCandidates when many verifikat credit 1513 since the
 * begäran.
 *
 * Every posted verifikat since the begäran that credits 1513 is read in full
 * by id with `.in()`, together with the begäran already settled on them, and
 * only then cut to the newest CANDIDATE_LIMIT (50). supabase-js puts the ids
 * in the GET query string, about 39 characters a uuid, so a begäran from
 * before a few hundred such verifikat passed a self-hosted Kong's 8 KB, the
 * reads were refused and the picker offered nothing. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past that limit.
 */
import { describe, expect, it } from 'vitest'
import { listRotRutPayoutVoucherCandidates } from '../rot-rut-link-voucher'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const ENTRIES = 250

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
const entryId = (n: number) => uuid(n, 'eeeeeeee')

/** Verifikat n: a payout of 100 + n kr booked by hand, 1930 against 1513. */
function books(used: number[]) {
  return {
    journal_entries: range(ENTRIES).map((n) => ({
      id: entryId(n),
      company_id: COMPANY,
      status: 'posted',
      reversed_by_id: null,
      entry_date: '2026-09-30',
      voucher_series: 'A',
      voucher_number: n,
      description: `RUT utbetalning ${n}`,
      source_type: 'manual',
      lines: [
        { account_number: '1930', debit_amount: 100 + n, credit_amount: 0 },
        { account_number: '1513', debit_amount: 0, credit_amount: 100 + n },
      ],
    })),
    journal_entry_lines: range(ENTRIES).flatMap((n) => [
      { id: uuid(n, 'dddddddd'), journal_entry_id: entryId(n), account_number: '1513', debit_amount: 0, credit_amount: 100 + n },
      { id: uuid(n, 'ffffffff'), journal_entry_id: entryId(n), account_number: '1930', debit_amount: 100 + n, credit_amount: 0 },
    ]),
    rot_rut_payout_requests: used.map((n) => ({
      id: uuid(n, 'aaaaaaaa'),
      company_id: COMPANY,
      settlement_journal_entry_id: entryId(n),
    })),
  }
}

describe('listRotRutPayoutVoucherCandidates: many verifikat credit 1513', () => {
  it('offers the newest unsettled ones, in requests the gateway takes', async () => {
    // Settled on another begäran: two in the last slice of ids, one in the second.
    const { supabase, requests, requestsTo, unmodelled } = createGatewaySupabase(books([250, 240, 200]))

    const { data, error } = await listRotRutPayoutVoucherCandidates(supabase, COMPANY, '2026-08-25')

    expect(error).toBeNull()
    const offered = range(249).filter((n) => n >= 198 && n !== 240 && n !== 200).reverse()
    expect(offered).toHaveLength(50)
    expect(data.map((c) => c.voucher_number)).toEqual(offered)
    expect(data[0]).toEqual({
      journal_entry_id: entryId(249),
      entry_date: '2026-09-30',
      voucher_series: 'A',
      voucher_number: 249,
      description: 'RUT utbetalning 249',
      bank_amount: 349,
      receivable_credit: 349,
      share_credit: 0,
    })
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    // The entry-first line read names no ids; the full reads come 100 at a time.
    expect(requestsTo('journal_entries').map((r) => inListOf(r, 'id').length)).toEqual([0, 100, 100, 50])
    expect(requestsTo('rot_rut_payout_requests').map((r) => inListOf(r, 'settlement_journal_entry_id').length)).toEqual([
      100, 100, 50,
    ])
    expect(unmodelled).toEqual([])
  })

  it('reads every settled begäran of a slice past the 1000-row cap, so no used verifikat is offered again', async () => {
    // Verifikat 249 settled a thousand begäran; 248 settled one, read after them.
    const settled = [
      ...range(1000).map((n) => ({ id: uuid(n, '10000000'), company_id: COMPANY, settlement_journal_entry_id: entryId(249) })),
      { id: uuid(1, 'ffffffff'), company_id: COMPANY, settlement_journal_entry_id: entryId(248) },
    ]
    const { supabase, unmodelled } = createGatewaySupabase({ ...books([]), rot_rut_payout_requests: settled })

    const { data, error } = await listRotRutPayoutVoucherCandidates(supabase, COMPANY, '2026-08-25')

    expect(error).toBeNull()
    const offered = data.map((c) => c.voucher_number)
    expect(offered).toContain(250)
    expect(offered).not.toContain(249)
    expect(offered).not.toContain(248)
    expect(unmodelled).toEqual([])
  })
})
