import { describe, expect, it } from 'vitest'
import { costBasisFromRegister, type CostBasisContribution } from '../cost-basis'
import type { ShareEvent } from '../../types'

const ANNA = 'party-anna'
const BO = 'party-bo'
const CLASS_A = 'class-a'

let number = 0
function event(over: Partial<ShareEvent>): ShareEvent {
  number += 1
  return {
    id: `ev-${number}`,
    event_number: number,
    event_date: '2020-01-10',
    kind: 'bildande',
    share_class_id: CLASS_A,
    to_share_class_id: null,
    from_party_id: null,
    to_party_id: ANNA,
    range_start: 1,
    range_end: 1_000,
    transfer_reason: null,
    price_total: 25_000,
    ratio: null,
    aktiebrev_number: null,
    aktiebrev_action: null,
    counterparty_party_id: null,
    note_status: null,
    corrects_event_id: null,
    registered_on: null,
    decision_id: null,
    document_id: null,
    journal_entry_id: null,
    note: null,
    created_at: '2020-01-10T00:00:00Z',
    ...over,
  }
}

function contribution(over: Partial<CostBasisContribution> = {}): CostBasisContribution {
  return { party_id: ANNA, kind: 'contribution', conditional: false, status: 'booked', promised_on: '2025-03-01', amount: 40_000, ...over }
}

const AS_OF = '2025-12-31'

describe('costBasisFromRegister', () => {
  it('spreads the bildande price over the shares still held, after a sale of some', () => {
    const events = [
      event({}),
      event({ event_date: '2024-06-01', kind: 'overlatelse', from_party_id: ANNA, to_party_id: BO, range_start: 801, range_end: 1_000, transfer_reason: 'kop', price_total: 100_000 }),
    ]
    const anna = costBasisFromRegister({ partyId: ANNA, held: [{ range_start: 1, range_end: 800 }], events, asOf: AS_OF, contributions: [] })
    expect(anna).toMatchObject({ register_amount: 20_000, amount: 20_000, complete: true, gaps: [] })
    const bo = costBasisFromRegister({ partyId: BO, held: [{ range_start: 801, range_end: 1_000 }], events, asOf: AS_OF, contributions: [] })
    expect(bo).toMatchObject({ register_amount: 100_000, complete: true })
  })

  it('adds ovillkorade tillskott made before the start of the year, never villkorade ones or later ones', () => {
    const result = costBasisFromRegister({
      partyId: ANNA,
      held: [{ range_start: 1, range_end: 1_000 }],
      events: [event({})],
      asOf: AS_OF,
      contributions: [
        contribution(),
        contribution({ conditional: true, amount: 99_000 }),
        contribution({ promised_on: '2026-02-01', amount: 77_000 }),
        contribution({ status: 'cancelled', amount: 55_000 }),
        contribution({ party_id: BO, amount: 11_000 }),
      ],
    })
    expect(result).toMatchObject({ register_amount: 25_000, contributions_amount: 40_000, amount: 65_000, complete: true })
  })

  it('a share received as a gift keeps the giver\'s omkostnadsbelopp: incomplete', () => {
    const events = [
      event({}),
      event({ event_date: '2024-06-01', kind: 'overlatelse', from_party_id: ANNA, to_party_id: BO, range_start: 1, range_end: 500, transfer_reason: 'gava', price_total: null }),
    ]
    const bo = costBasisFromRegister({ partyId: BO, held: [{ range_start: 1, range_end: 500 }], events, asOf: AS_OF, contributions: [] })
    expect(bo.complete).toBe(false)
    expect(bo.gaps).toEqual(['continuity'])
  })

  it('fondemission shares cost nothing and keep the figure complete', () => {
    const events = [event({}), event({ event_date: '2023-05-01', kind: 'fondemission', range_start: 1_001, range_end: 2_000, price_total: null })]
    const r = costBasisFromRegister({ partyId: ANNA, held: [{ range_start: 1, range_end: 2_000 }], events, asOf: AS_OF, contributions: [] })
    expect(r).toMatchObject({ register_amount: 25_000, complete: true })
  })

  it('an entry without a price, a split, or a share no entry traces: incomplete', () => {
    const noPrice = costBasisFromRegister({ partyId: ANNA, held: [{ range_start: 1, range_end: 1_000 }], events: [event({ price_total: null })], asOf: AS_OF, contributions: [] })
    expect(noPrice.gaps).toEqual(['price_missing'])
    const split = costBasisFromRegister({
      partyId: ANNA,
      held: [{ range_start: 1, range_end: 1_000 }],
      events: [event({}), event({ event_date: '2022-01-01', kind: 'split', to_party_id: null, ratio: 2, range_start: null, range_end: null })],
      asOf: AS_OF,
      contributions: [],
    })
    expect(split.gaps).toContain('renumbered')
    const untraced = costBasisFromRegister({ partyId: ANNA, held: [{ range_start: 1, range_end: 1_200 }], events: [event({})], asOf: AS_OF, contributions: [] })
    expect(untraced.gaps).toEqual(['untraced'])
  })

  it('ignores a voided entry and entries after the start of the year', () => {
    const wrong = event({ price_total: 999_999 })
    const events = [
      wrong,
      event({ kind: 'rattelse', corrects_event_id: wrong.id, to_party_id: null, range_start: null, range_end: null, price_total: null }),
      event({ event_date: '2020-01-11' }),
      event({ event_date: '2026-03-01', kind: 'overlatelse', from_party_id: BO, to_party_id: ANNA, range_start: 1, range_end: 1_000, transfer_reason: 'kop', price_total: 5_000_000 }),
    ]
    const r = costBasisFromRegister({ partyId: ANNA, held: [{ range_start: 1, range_end: 1_000 }], events, asOf: AS_OF, contributions: [] })
    expect(r).toMatchObject({ register_amount: 25_000, complete: true })
  })
})
