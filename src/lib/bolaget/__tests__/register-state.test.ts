import { describe, expect, it } from 'vitest'
import {
  checkCorrection,
  mergeRanges,
  nextFreeShareNumber,
  replayShareRegister,
  ShareRegisterError,
  summarizeHoldings,
} from '../register-state'
import type { ShareClass, ShareEvent } from '../types'

const A = 'class-a'
const B = 'class-b'
const classes: ShareClass[] = [
  { id: A, code: 'A', name: null, votes_per_share: 10, forbehall_samtycke: false, forbehall_forkop: false, forbehall_hembud: true, forbehall_omvandling: false, forbehall_inlosen: false, forbehall_text: null, bolagsordning_reference: null },
  { id: B, code: 'B', name: null, votes_per_share: 1, forbehall_samtycke: false, forbehall_forkop: false, forbehall_hembud: false, forbehall_omvandling: false, forbehall_inlosen: false, forbehall_text: null, bolagsordning_reference: null },
]

let n = 0
function ev(partial: Partial<ShareEvent> & Pick<ShareEvent, 'kind' | 'event_date'>): ShareEvent {
  n += 1
  return {
    id: partial.id ?? `e${n}`,
    event_number: partial.event_number ?? n,
    share_class_id: null,
    to_share_class_id: null,
    from_party_id: null,
    to_party_id: null,
    range_start: null,
    range_end: null,
    transfer_reason: null,
    price_total: null,
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
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

function founding(): ShareEvent[] {
  n = 0
  return [
    ev({ kind: 'bildande', event_date: '2020-01-10', to_party_id: 'anna', share_class_id: A, range_start: 1, range_end: 600 }),
    ev({ kind: 'bildande', event_date: '2020-01-10', to_party_id: 'bo', share_class_id: B, range_start: 601, range_end: 1000 }),
  ]
}

describe('replayShareRegister', () => {
  it('holds the founding shares in numerical order', () => {
    const r = replayShareRegister(founding())
    expect(r.totalShares).toBe(1000)
    expect(r.ranges).toEqual([
      { share_class_id: A, party_id: 'anna', range_start: 1, range_end: 600 },
      { share_class_id: B, party_id: 'bo', range_start: 601, range_end: 1000 },
    ])
  })

  it('splits a holding on a partial transfer and joins adjacent ranges back', () => {
    const events = [
      ...founding(),
      ev({ kind: 'overlatelse', event_date: '2021-03-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: A, range_start: 101, range_end: 200, transfer_reason: 'kop', price_total: 5000 }),
      ev({ kind: 'overlatelse', event_date: '2022-03-01', from_party_id: 'cia', to_party_id: 'anna', share_class_id: A, range_start: 101, range_end: 200, transfer_reason: 'gava' }),
    ]
    expect(replayShareRegister(events, '2021-12-31').ranges.map((r) => [r.party_id, r.range_start, r.range_end])).toEqual([
      ['anna', 1, 100],
      ['cia', 101, 200],
      ['anna', 201, 600],
      ['bo', 601, 1000],
    ])
    expect(replayShareRegister(events).ranges.map((r) => [r.party_id, r.range_start, r.range_end])).toEqual([
      ['anna', 1, 600],
      ['bo', 601, 1000],
    ])
  })

  it('answers the register as of a date: later entries do not count', () => {
    const events = [...founding(), ev({ kind: 'nyemission', event_date: '2023-05-01', to_party_id: 'cia', share_class_id: B, range_start: 1001, range_end: 1100 })]
    expect(replayShareRegister(events, '2023-04-30').totalShares).toBe(1000)
    expect(replayShareRegister(events, '2023-05-01').totalShares).toBe(1100)
  })

  it('refuses an issue on numbers already held', () => {
    const events = [...founding(), ev({ kind: 'nyemission', event_date: '2023-05-01', to_party_id: 'cia', share_class_id: B, range_start: 990, range_end: 1100 })]
    expect(() => replayShareRegister(events)).toThrow(ShareRegisterError)
    try {
      replayShareRegister(events)
    } catch (e) {
      expect((e as ShareRegisterError).code).toBe('SHARE_REGISTER_RANGE_TAKEN')
    }
  })

  it('refuses a transfer of shares the transferor does not hold on that date', () => {
    const events = [...founding(), ev({ kind: 'overlatelse', event_date: '2021-01-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: A, range_start: 550, range_end: 650, transfer_reason: 'kop' })]
    expect(() => replayShareRegister(events)).toThrow(/ägs inte/)
  })

  it('refuses a transfer dated before the shares existed', () => {
    const events = [...founding(), ev({ kind: 'overlatelse', event_date: '2019-01-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: A, range_start: 1, range_end: 10, transfer_reason: 'kop' })]
    expect(() => replayShareRegister(events)).toThrow(ShareRegisterError)
  })

  it('cancels shares and converts a class', () => {
    const events = [
      ...founding(),
      ev({ kind: 'indragning', event_date: '2024-01-01', from_party_id: 'bo', share_class_id: B, range_start: 901, range_end: 1000 }),
      ev({ kind: 'omvandling', event_date: '2024-02-01', from_party_id: 'anna', share_class_id: A, to_share_class_id: B, range_start: 1, range_end: 100 }),
    ]
    const r = replayShareRegister(events)
    expect(r.totalShares).toBe(900)
    expect(r.ranges[0]).toEqual({ share_class_id: B, party_id: 'anna', range_start: 1, range_end: 100 })
  })

  it('renumbers on a split and a sammanläggning', () => {
    const events = [...founding(), ev({ kind: 'split', event_date: '2024-01-01', ratio: 10 })]
    const split = replayShareRegister(events)
    expect(split.totalShares).toBe(10000)
    expect(split.ranges[1]).toEqual({ share_class_id: B, party_id: 'bo', range_start: 6001, range_end: 10000 })
    const back = replayShareRegister([...events, ev({ kind: 'sammanlaggning', event_date: '2024-06-01', ratio: 10 })])
    expect(back.ranges).toEqual(replayShareRegister(founding()).ranges)
  })

  it('refuses a sammanläggning a holding cannot be divided into', () => {
    const events = [...founding(), ev({ kind: 'sammanlaggning', event_date: '2024-01-01', ratio: 7 })]
    expect(() => replayShareRegister(events)).toThrow(/jämnt delbart/)
  })

  it('joins a holder\'s adjacent ranges before checking a sammanläggning', () => {
    const events = [
      ...founding(),
      ev({ kind: 'overlatelse', event_date: '2021-01-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: A, range_start: 1, range_end: 5, transfer_reason: 'kop' }),
      ev({ kind: 'overlatelse', event_date: '2021-02-01', from_party_id: 'cia', to_party_id: 'anna', share_class_id: A, range_start: 1, range_end: 5, transfer_reason: 'kop' }),
      ev({ kind: 'sammanlaggning', event_date: '2024-01-01', ratio: 2 }),
    ]
    expect(replayShareRegister(events).totalShares).toBe(500)
  })

  it('leaves out an entry a rattelse voids', () => {
    const events = founding()
    const wrong = ev({ kind: 'overlatelse', event_date: '2021-01-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: A, range_start: 1, range_end: 10, transfer_reason: 'kop' })
    const fix = ev({ kind: 'rattelse', event_date: '2021-02-01', corrects_event_id: wrong.id, note: 'Fel köpare' })
    const r = replayShareRegister([...events, wrong, fix])
    expect(r.ranges.find((x) => x.party_id === 'cia')).toBeUndefined()
  })

  it('tracks an aktiebrev, a pant and a nyttjanderätt through transfers and closes them', () => {
    const events = [
      ...founding(),
      ev({ kind: 'aktiebrev', event_date: '2020-02-01', range_start: 1, range_end: 600, aktiebrev_number: '1', aktiebrev_action: 'issued' }),
      ev({ kind: 'pant', event_date: '2020-03-01', range_start: 601, range_end: 700, counterparty_party_id: 'bank', note_status: 'open' }),
      ev({ kind: 'nyttjanderatt', event_date: '2020-03-02', range_start: 701, range_end: 750, counterparty_party_id: 'dana', note_status: 'open', note: 'Testamente' }),
    ]
    const r = replayShareRegister(events)
    expect(r.annotations.map((a) => [a.kind, a.range_start, a.range_end])).toEqual([
      ['aktiebrev', 1, 600],
      ['pant', 601, 700],
      ['nyttjanderatt', 701, 750],
    ])
    const closed = replayShareRegister([
      ...events,
      ev({ kind: 'pant', event_date: '2021-01-01', range_start: 601, range_end: 650, counterparty_party_id: 'bank', note_status: 'closed' }),
      ev({ kind: 'aktiebrev', event_date: '2021-01-02', range_start: 1, range_end: 600, aktiebrev_number: '1', aktiebrev_action: 'returned' }),
    ])
    expect(closed.annotations.map((a) => [a.kind, a.range_start, a.range_end])).toEqual([
      ['pant', 651, 700],
      ['nyttjanderatt', 701, 750],
    ])
  })

  it('refuses an aktiebrev over shares of two holders, and closing a note that is not open', () => {
    expect(() =>
      replayShareRegister([...founding(), ev({ kind: 'aktiebrev', event_date: '2020-02-01', range_start: 590, range_end: 610, aktiebrev_number: '1', aktiebrev_action: 'issued' })]),
    ).toThrow(/flera/)
    expect(() =>
      replayShareRegister([...founding(), ev({ kind: 'pant', event_date: '2020-02-01', range_start: 1, range_end: 10, counterparty_party_id: 'bank', note_status: 'closed' })]),
    ).toThrow(/ingen öppen/)
  })

  it('drops the notes of cancelled shares', () => {
    const r = replayShareRegister([
      ...founding(),
      ev({ kind: 'pant', event_date: '2020-03-01', range_start: 901, range_end: 1000, counterparty_party_id: 'bank', note_status: 'open' }),
      ev({ kind: 'indragning', event_date: '2021-01-01', from_party_id: 'bo', share_class_id: B, range_start: 951, range_end: 1000 }),
    ])
    expect(r.annotations).toEqual([expect.objectContaining({ range_start: 901, range_end: 950 })])
  })
})

describe('replayShareRegister: stored notes the history cannot hold', () => {
  const stored = () => [
    ev({ kind: 'bildande', event_date: '2020-01-10', share_class_id: A, to_party_id: 'anna', range_start: 1, range_end: 100 }),
    ev({ id: 'brev-1', kind: 'aktiebrev', event_date: '2020-02-01', range_start: 1, range_end: 100, aktiebrev_number: '1', aktiebrev_action: 'issued' }),
    ev({ id: 'brev-2', kind: 'aktiebrev', event_date: '2020-02-01', range_start: 1, range_end: 100, aktiebrev_number: '1', aktiebrev_action: 'issued' }),
  ]

  it('throws on the second of two colliding aktiebrev when an entry is checked', () => {
    expect(() => replayShareRegister(stored())).toThrow(ShareRegisterError)
  })

  it('answers the register with the colliding entry left out and named when the stored history is read', () => {
    const result = replayShareRegister(stored(), null, { notes: 'collect' })
    expect(result.totalShares).toBe(100)
    expect(result.annotations.map((n) => n.event_id)).toEqual(['brev-1'])
    expect(result.noteProblems).toEqual([expect.objectContaining({ event_id: 'brev-2', kind: 'aktiebrev', event_date: '2020-02-01' })])
    expect(result.noteProblems[0]!.message).toMatch(/Aktiebrev 1 gäller redan/)
  })

  it('has nothing to name once a rattelse voids the colliding entry', () => {
    const events = [...stored(), ev({ kind: 'rattelse', event_date: '2026-01-01', corrects_event_id: 'brev-2', note: 'Införd två gånger' })]
    expect(replayShareRegister(events, null, { notes: 'collect' }).noteProblems).toEqual([])
    expect(() => replayShareRegister(events)).not.toThrow()
  })

  it('still throws on holdings the history cannot hold, whatever the notes do', () => {
    const events = [
      ...stored(),
      ev({ kind: 'overlatelse', event_date: '2021-01-01', share_class_id: A, from_party_id: 'bo', to_party_id: 'cia', range_start: 1, range_end: 10, transfer_reason: 'kop' }),
    ]
    expect(() => replayShareRegister(events, null, { notes: 'collect' })).toThrow(/ägs inte/)
  })
})

describe('checkCorrection', () => {
  it('voids one earlier entry that is not a rattelse, once', () => {
    const events = founding()
    expect(() => checkCorrection(events, events[0]!.id)).not.toThrow()
    const fix = ev({ kind: 'rattelse', event_date: '2021-01-01', corrects_event_id: events[0]!.id, note: 'x' })
    expect(() => checkCorrection([...events, fix], fix.id)).toThrow(ShareRegisterError)
    expect(() => checkCorrection([...events, fix], events[0]!.id)).toThrow(/redan rättad/)
    expect(() => checkCorrection(events, 'nope')).toThrow(ShareRegisterError)
  })
})

describe('summarizeHoldings', () => {
  it('weighs votes per class and answers capital and votes in percent', () => {
    const s = summarizeHoldings(replayShareRegister(founding()).ranges, classes)
    expect(s.total_shares).toBe(1000)
    expect(s.total_votes).toBe(6400)
    expect(s.holders.map((h) => [h.party_id, h.capital_pct, h.votes_pct])).toEqual([
      ['anna', 60, 93.75],
      ['bo', 40, 6.25],
    ])
    expect(s.classes).toEqual([
      { share_class_id: A, code: 'A', shares: 600, votes: 6000 },
      { share_class_id: B, code: 'B', shares: 400, votes: 400 },
    ])
  })
})

describe('helpers', () => {
  it('merges adjacent ranges of one holder and class only', () => {
    expect(
      mergeRanges([
        { share_class_id: A, party_id: 'x', range_start: 6, range_end: 10 },
        { share_class_id: A, party_id: 'x', range_start: 1, range_end: 5 },
        { share_class_id: B, party_id: 'x', range_start: 11, range_end: 12 },
      ]),
    ).toEqual([
      { share_class_id: A, party_id: 'x', range_start: 1, range_end: 10 },
      { share_class_id: B, party_id: 'x', range_start: 11, range_end: 12 },
    ])
  })

  it('gives the next free share number after the highest held', () => {
    expect(nextFreeShareNumber([])).toBe(1)
    expect(nextFreeShareNumber(replayShareRegister(founding()).ranges)).toBe(1001)
  })
})
