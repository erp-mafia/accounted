/**
 * The Kontoplan "Att granska" predicate (crm#104): an account is to be
 * reviewed when its name points at another momsruta than the one its amounts
 * land in. resolveAccountVatBox must agree with fetchDynamicVatAccounts, the
 * declaration's own classifier, or the predicate would flag against a box
 * the declaration never uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const fetchAllRowsMock = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...args: unknown[]) => fetchAllRowsMock(...args),
}))

import { accountNeedsVatReview, accountVatReviewFinding } from '../account-vat-review'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import {
  fetchDynamicVatAccounts,
  resolveAccountVatBox,
} from '@/lib/reports/vat-revenue-accounts'

function row(
  account_number: string,
  account_name: string,
  default_vat_treatment: string | null = null,
  default_vat_rate: number | null = null,
) {
  return {
    account_number,
    account_name,
    account_class: Number(account_number.charAt(0)),
    default_vat_rate,
    default_vat_treatment,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('accountVatReviewFinding', () => {
  it('stays quiet when the BAS fallback already lands where the name says', () => {
    expect(accountVatReviewFinding(row('3001', 'Försäljning inom Sverige, 25 % moms'))).toBeNull()
    expect(accountVatReviewFinding(row('3308', 'Försäljning tjänster till annat EU-land'))).toBeNull()
    expect(accountVatReviewFinding(row('4515', 'Inköp av varor från annat EU-land, 25 %'))).toBeNull()
  })

  it('stays quiet when the name says nothing about moms', () => {
    expect(accountVatReviewFinding(row('3010', 'Försäljning'))).toBeNull()
    expect(accountVatReviewFinding(row('5010', 'Lokalhyra'))).toBeNull()
  })

  it('never flags classes 1-2 and 7-8', () => {
    expect(accountVatReviewFinding(row('2611', 'Utgående moms på försäljning inom Sverige, 25 %'))).toBeNull()
    expect(accountVatReviewFinding(row('7010', 'Löner till kollektivanställda EU tjänster'))).toBeNull()
  })

  it('flags an account without a momskod whose name points at a ruta the fallback misses', () => {
    const finding = accountVatReviewFinding(row('3045', 'Försäljning tjänster EU'))
    expect(finding).toEqual({
      suggestedTreatment: 'reverse_charge_eu_services',
      suggestedBox: '39',
      effectiveBox: null,
      hasOwnTreatment: false,
    })
  })

  it('flags a BAS purchase account whose reverse-charge basis would miss ruta 23 without a code', () => {
    const finding = accountVatReviewFinding(
      row('4065', 'Inköp av handelsvaror i Sverige, omvänd betalningsskyldighet, 25 % moms'),
    )
    expect(finding?.suggestedBox).toBe('23')
    expect(finding?.effectiveBox).toBeNull()
  })

  it('flags a momskod that sends the amounts to another ruta than the name says', () => {
    const finding = accountVatReviewFinding(row('3045', 'Försäljning tjänster EU', 'standard_25'))
    expect(finding).toEqual({
      suggestedTreatment: 'reverse_charge_eu_services',
      suggestedBox: '39',
      effectiveBox: '05',
      hasOwnTreatment: true,
    })
  })

  it('clears once the momskod agrees with the name', () => {
    expect(accountNeedsVatReview(row('3045', 'Försäljning tjänster EU', 'reverse_charge_eu_services'))).toBe(false)
  })

  it('compares rutor, not treatments: a sats-only difference inside ruta 05 is not flagged', () => {
    expect(accountNeedsVatReview(row('3045', 'Försäljning 12 %', 'standard_25'))).toBe(false)
  })

  it('treats OSS as outside the declaration on both sides', () => {
    expect(accountNeedsVatReview(row('3045', 'Försäljning OSS', null))).toBe(false)
    expect(accountNeedsVatReview(row('3045', 'Försäljning OSS', 'standard_25'))).toBe(true)
  })

  it('flags nothing in the seeded BAS starter chart numbers', () => {
    // The seed (seed_chart_of_accounts) holds no class 3-6 account; the
    // accounts a new company activates most, the 30xx sales accounts, must
    // stay quiet so the Att göra row is not a chore for everyone.
    for (const number of ['3001', '3002', '3003', '3004', '3740', '4010', '5010', '6110']) {
      const ref = BAS_REFERENCE.find((a) => a.account_number === number)
      if (!ref) continue
      expect(accountNeedsVatReview(row(ref.account_number, ref.account_name))).toBe(false)
    }
  })
})

describe('resolveAccountVatBox agrees with fetchDynamicVatAccounts', () => {
  it('lands every sample account in the same ruta the declaration uses', async () => {
    const rows = [
      row('3001', 'Försäljning inom Sverige, 25 % moms'),
      row('3011', 'Försäljning 25 % moms'),
      row('3045', 'Försäljning tjänster EU', 'reverse_charge_eu_services'),
      row('3046', 'Försäljning OSS', 'oss'),
      row('3050', 'Försäljning övrigt', null, 0.25),
      row('3211', 'Försäljning positiv VMB 25 %'),
      row('3740', 'Öres- och kronutjämning'),
      row('4065', 'Inköp handelsvaror omvänd betalningsskyldighet', 'reverse_charge_domestic'),
      row('4515', 'Inköp av varor från annat EU-land, 25 %'),
      row('4010', 'Inköp material och varor'),
    ]
    fetchAllRowsMock.mockResolvedValueOnce(rows)
    const dynamic = await fetchDynamicVatAccounts({} as SupabaseClient, 'company-1')

    for (const r of rows) {
      const box = resolveAccountVatBox(r)
      const mapped = dynamic.mappingByAccount.get(r.account_number)?.box.replace(/^ruta/, '') ?? null
      // Static BAS accounts reach the declaration through ACCOUNT_RUTA, not
      // the dynamic map, so only a dynamic hit or a miss is compared there.
      if (mapped !== null || r.default_vat_treatment) {
        expect([r.account_number, box]).toEqual([r.account_number, mapped])
      }
    }
  })
})
