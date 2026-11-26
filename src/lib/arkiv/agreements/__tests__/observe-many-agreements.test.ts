/**
 * observeObligations for a company with many manual agreements.
 *
 * The nightly derive cron narrows the run to every manual agreement of the
 * company, ended ones too, and the obligations, their agreements and their
 * counterparties are read by id with `.in()`. supabase-js puts the ids in the
 * GET query string, so past about 200 agreements the read was refused and the
 * company's payments were never observed. The fake gateway
 * (tests/gateway-supabase.ts) refuses a URL past a self-hosted Kong's 8 KB.
 */
import { describe, expect, it } from 'vitest'
import { observeObligations } from '../observe'
import { createGatewaySupabase, GATEWAY_URL_LIMIT, inListOf, type GatewayRequest } from '@/tests/gateway-supabase'

const COMPANY = '5b0c3c1e-0000-4000-8000-000000000001'
const TODAY = '2026-09-15'

const uuid = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const agreementIds = (count: number) => Array.from({ length: count }, (_, i) => uuid(i + 1, 'a0000000'))
/** The obligations' reads by agreement id, as the sizes of their id lists. */
const obligationSlices = (requests: GatewayRequest[]) =>
  requests.filter((r) => r.table === 'agreement_obligations' && r.method === 'GET').map((r) => inListOf(r, 'agreement_id').length)
/** The obligation each status write names, in the order the writes were made. */
const writes = (requests: GatewayRequest[]) =>
  requests.filter((r) => r.table === 'agreement_obligations' && r.method === 'PATCH').map((r) => ({ id: new URL(r.url).searchParams.get('id'), body: r.body }))

describe('observeObligations: many manual agreements', () => {
  /** Due in the first ten days of September; the later the agreement, the earlier its payment. */
  const due = (n: number) => `2026-09-${String(1 + ((250 - n) % 10)).padStart(2, '0')}`

  function books(count: number) {
    const range = Array.from({ length: count }, (_, i) => i + 1)
    return {
      agreements: range.map((n) => ({ id: uuid(n, 'a0000000'), company_id: COMPANY, counterparty_party_id: uuid(n, 'b0000000'), counterparty_name: null })),
      parties: range.map((n) => ({ id: uuid(n, 'b0000000'), company_id: COMPANY, display_name: `Leverantör ${n} AB`, legal_name: null, alias_keys: [] })),
      agreement_obligations: range.map((n) => ({ id: uuid(n, 'c0000000'), company_id: COMPANY, agreement_id: uuid(n, 'a0000000'), due_on: due(n), amount: 1000 + n, currency: 'SEK', amount_is_estimate: false, status: 'expected', direction: 'out' })),
      transactions: range.map((n) => ({ id: uuid(n, 'd0000000'), company_id: COMPANY, is_ignored: false, date: due(n), amount: -(1000 + n), currency: 'SEK', description: `Leverantör ${n} AB`, original_description: null, merchant_name: null })),
    }
  }

  it('matches every payment of 250 agreements, in due order, in requests the gateway takes', async () => {
    const { supabase, requests, unmodelled } = createGatewaySupabase(books(250))

    await expect(observeObligations(supabase, COMPANY, TODAY, { agreementIds: agreementIds(250) })).resolves.toEqual({ checked: 250, matched: 250, missed: 0 })

    const byDue = Array.from({ length: 250 }, (_, i) => i + 1).sort((a, b) => due(a).localeCompare(due(b)) || a - b)
    expect(writes(requests)).toEqual(
      byDue.map((n) => ({ id: `eq.${uuid(n, 'c0000000')}`, body: expect.objectContaining({ status: 'matched', transaction_id: uuid(n, 'd0000000'), matched_basis: 'proven' }) })),
    )
    expect(requests.every((r) => r.url.length <= GATEWAY_URL_LIMIT)).toBe(true)
    expect(obligationSlices(requests)).toEqual([100, 100, 50])
    expect(requests.filter((r) => r.table === 'agreements').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 50])
    expect(requests.filter((r) => r.table === 'parties').map((r) => inListOf(r, 'id').length)).toEqual([100, 100, 50])
    expect(unmodelled).toEqual([])
  })
})

describe('observeObligations: the slice boundary', () => {
  /**
   * The first and the last of `count` agreements are rents to the same
   * landlord, and one bank payment fits both: the obligation due first takes
   * it. The last agreement's is due first.
   */
  function books(count: number) {
    const first = uuid(1, 'a0000000')
    const last = uuid(count, 'a0000000')
    const obligation = (n: number, agreementId: string, dueOn: string) => ({ id: uuid(n, 'c0000000'), company_id: COMPANY, agreement_id: agreementId, due_on: dueOn, amount: 12500, currency: 'SEK', amount_is_estimate: false, status: 'expected', direction: 'out' })
    return {
      agreements: [first, last].map((id) => ({ id, company_id: COMPANY, counterparty_party_id: null, counterparty_name: 'Fastighets AB Kvarnen' })),
      agreement_obligations: [obligation(1, first, '2026-09-05'), obligation(2, last, '2026-09-01')],
      transactions: [{ id: uuid(1, 'd0000000'), company_id: COMPANY, is_ignored: false, date: '2026-09-03', amount: -12500, currency: 'SEK', description: 'Fastighets AB Kvarnen', original_description: null, merchant_name: null }],
    }
  }

  it.each([
    [100, [100]],
    [101, [100, 1]],
  ])('reads the obligations of %i agreements in slices of %j and lets the one due first take the payment', async (count, slices) => {
    const { supabase, requests, unmodelled } = createGatewaySupabase(books(count))

    await expect(observeObligations(supabase, COMPANY, TODAY, { agreementIds: agreementIds(count) })).resolves.toEqual({ checked: 2, matched: 1, missed: 0 })

    expect(writes(requests)).toEqual([{ id: `eq.${uuid(2, 'c0000000')}`, body: expect.objectContaining({ status: 'matched', transaction_id: uuid(1, 'd0000000') }) }])
    expect(obligationSlices(requests)).toEqual(slices)
    expect(unmodelled).toEqual([])
  })
})
