import { describe, expect, it } from 'vitest'
import {
  EMPTY_EVENT,
  NEW_PARTY,
  buildEventBody,
  parseWholeNumber,
  shareNumbersLabel,
  voteSharesAfter,
  withField,
  type FormState,
} from '../share-event-form'

const TODAY = '2026-11-18'
const HOLDER = '11111111-1111-4111-8111-111111111111'
const RECEIVER = '22222222-2222-4222-8222-222222222222'

const form = (over: Partial<FormState>): FormState => ({ ...EMPTY_EVENT, event_date: '2026-11-01', ...over }) as FormState
const build = (over: Partial<FormState>) => buildEventBody(form(over), { today: TODAY })
const bodyOf = (over: Partial<FormState>) => {
  const result = build(over)
  if (!result.ok) throw new Error(`expected a body, got errors ${JSON.stringify(result.errors)}`)
  return result.body
}
const errorsOf = (over: Partial<FormState>) => {
  const result = build(over)
  if (result.ok) throw new Error(`expected errors, got a body ${JSON.stringify(result.body)}`)
  return result.errors
}

describe('parseWholeNumber', () => {
  it('reads digits, with spaces between the groups', () => {
    expect(parseWholeNumber('25000')).toEqual({ ok: true, value: 25000 })
    expect(parseWholeNumber('25 000')).toEqual({ ok: true, value: 25000 })
    expect(parseWholeNumber(' 1 000 000 ')).toEqual({ ok: true, value: 1000000 })
    // The no-break and narrow no-break spaces a pasted sv-SE figure carries.
    expect(parseWholeNumber('25 000')).toEqual({ ok: true, value: 25000 })
    expect(parseWholeNumber('25 000')).toEqual({ ok: true, value: 25000 })
  })

  it('reads a blank field as nothing typed', () => {
    expect(parseWholeNumber('')).toEqual({ ok: true, value: null })
    expect(parseWholeNumber('   ')).toEqual({ ok: true, value: null })
  })

  it('refuses everything else instead of guessing', () => {
    // parseInt read the first two as 25.
    for (const text of ['25.000', '25,000', '25,5', '25k', '-5', '+5', '1e3', '0', '000', 'tio', '12a', '9007199254740993']) {
      expect(parseWholeNumber(text), text).toEqual({ ok: false })
    }
  })
})

describe('buildEventBody: share numbers', () => {
  const issue = { kind: 'nyemission', to_party: RECEIVER }

  it('sends a count alone as a count', () => {
    expect(bodyOf({ ...issue, share_count: '25 000' })).toEqual({ kind: 'nyemission', event_date: '2026-11-01', to_party_id: RECEIVER, share_count: 25000 })
  })

  it('sends a first number with a count as the block, and leaves the last number to the server', () => {
    const body = bodyOf({ ...issue, range_start: '501', share_count: '500' })
    expect(body).toMatchObject({ range_start: 501, share_count: 500 })
    expect(body).not.toHaveProperty('range_end')
  })

  it('sends a first and a last number as they are', () => {
    const body = bodyOf({ ...issue, range_start: '501', range_end: '1 000' })
    expect(body).toMatchObject({ range_start: 501, range_end: 1000 })
    expect(body).not.toHaveProperty('share_count')
    // A count that agrees with the numbers adds nothing.
    expect(bodyOf({ ...issue, range_start: '501', range_end: '1000', share_count: '500' })).not.toHaveProperty('share_count')
  })

  it('sends a first number alone as that one share', () => {
    const body = bodyOf({ ...issue, range_start: '7' })
    expect(body).toMatchObject({ range_start: 7 })
    expect(body).not.toHaveProperty('range_end')
    expect(body).not.toHaveProperty('share_count')
  })

  it('never turns "25.000" or "25,000" into 25', () => {
    expect(errorsOf({ ...issue, share_count: '25.000' })).toEqual({ share_count: 'whole_number' })
    expect(errorsOf({ ...issue, share_count: '25,000' })).toEqual({ share_count: 'whole_number' })
    expect(errorsOf({ ...issue, range_start: '1.000', range_end: '2,000' })).toEqual({ range_start: 'whole_number', range_end: 'whole_number' })
  })

  it('refuses a count that contradicts the numbers, a last number below the first, and a last number without a first', () => {
    expect(errorsOf({ ...issue, range_start: '1', range_end: '500', share_count: '400' })).toEqual({ share_count: 'count_mismatch' })
    expect(errorsOf({ ...issue, range_start: '500', range_end: '1' })).toEqual({ range_end: 'range_order' })
    expect(errorsOf({ ...issue, range_end: '500', share_count: '500' })).toEqual({ range_start: 'range_start_required' })
  })

  it('asks for a count or numbers when neither is given', () => {
    expect(errorsOf(issue)).toEqual({ share_count: 'count_required' })
  })

  it('gives a note on shares by its numbers only', () => {
    const aktiebrev = { kind: 'aktiebrev', aktiebrev_number: '3' }
    // A count typed before the kind was changed is not sent.
    const body = bodyOf({ ...aktiebrev, range_start: '1', range_end: '100', share_count: '999' })
    expect(body).toEqual({ kind: 'aktiebrev', event_date: '2026-11-01', range_start: 1, range_end: 100, aktiebrev_number: '3', aktiebrev_action: 'issued' })
    expect(errorsOf({ ...aktiebrev, share_count: '100' })).toEqual({ range_start: 'range_start_required' })
    expect(errorsOf({ kind: 'aktiebrev', range_start: '1' })).toEqual({ aktiebrev_number: 'text_required' })
  })
})

describe('buildEventBody: who', () => {
  const issue = { kind: 'bildande', share_count: '500' }

  it('never sends an entry while nobody is chosen', () => {
    expect(errorsOf(issue)).toEqual({ to_party: 'choose' })
    expect(errorsOf({ kind: 'pant', range_start: '1' })).toEqual({ counter_party: 'choose' })
    expect(errorsOf({ kind: 'overlatelse', to_party: RECEIVER, share_count: '10' })).toEqual({ from_party_id: 'choose' })
  })

  it('sends somebody from the registers by id', () => {
    expect(bodyOf({ ...issue, to_party: RECEIVER, to_name: 'left over' })).toEqual({ kind: 'bildande', event_date: '2026-11-01', to_party_id: RECEIVER, share_count: 500 })
  })

  it('sends somebody new by name and kind, and needs the name', () => {
    expect(errorsOf({ ...issue, to_party: NEW_PARTY, to_name: '  ' })).toEqual({ to_name: 'text_required' })
    expect(bodyOf({ ...issue, to_party: NEW_PARTY, to_name: ' Anna Ek ' })).toMatchObject({ to_name: 'Anna Ek', to_kind: 'person' })
    const company = bodyOf({ ...issue, to_party: NEW_PARTY, to_name: 'Holding AB', to_kind: 'company', to_org_number: ' 556677-8899 ' })
    expect(company).toMatchObject({ to_name: 'Holding AB', to_kind: 'company', to_org_number: '556677-8899' })
    // A person never carries an org number.
    expect(bodyOf({ ...issue, to_party: NEW_PARTY, to_name: 'Anna Ek', to_org_number: '556677-8899' })).not.toHaveProperty('to_org_number')
  })

  it('says a typed name is somebody new only when the person said so', () => {
    expect(bodyOf({ ...issue, to_party: NEW_PARTY, to_name: 'Anna Ek' })).not.toHaveProperty('to_is_new')
    expect(bodyOf({ ...issue, to_party: NEW_PARTY, to_name: 'Anna Ek', to_is_new: 'true' })).toMatchObject({ to_is_new: true })
    // Never for somebody picked from the registers.
    expect(bodyOf({ ...issue, to_party: RECEIVER, to_is_new: 'true' })).not.toHaveProperty('to_is_new')
  })

  it('sends a pledge with its pledgee, its numbers and whether it starts or ends', () => {
    expect(bodyOf({ kind: 'pant', counter_party: NEW_PARTY, counterparty_name: 'Banken AB', counterparty_org_number: '5560001111', counterparty_is_new: 'true', range_start: '1', range_end: '50', note_status: 'closed' })).toEqual({
      kind: 'pant',
      event_date: '2026-11-01',
      counterparty_name: 'Banken AB',
      counterparty_kind: 'company',
      counterparty_org_number: '5560001111',
      counterparty_is_new: true,
      note_status: 'closed',
      range_start: 1,
      range_end: 50,
    })
  })

  it('sends a transfer with its holder, receiver, reason and the cleared clause', () => {
    expect(bodyOf({ kind: 'overlatelse', from_party_id: HOLDER, to_party: RECEIVER, share_count: '100', transfer_reason: 'gava', forbehall_cleared: 'true', share_class_code: 'B' })).toEqual({
      kind: 'overlatelse',
      event_date: '2026-11-01',
      share_class_code: 'B',
      from_party_id: HOLDER,
      to_party_id: RECEIVER,
      share_count: 100,
      transfer_reason: 'gava',
      forbehall_cleared: true,
    })
  })
})

describe('buildEventBody: the rest', () => {
  it('needs a date, and none ahead of today', () => {
    expect(errorsOf({ kind: 'anteckning', note: 'x', event_date: '' })).toEqual({ event_date: 'date_required' })
    expect(errorsOf({ kind: 'anteckning', note: 'x', event_date: '2026-11-19' })).toEqual({ event_date: 'date_future' })
    expect(bodyOf({ kind: 'anteckning', note: 'x', event_date: TODAY })).toEqual({ kind: 'anteckning', event_date: TODAY, note: 'x' })
  })

  it('reads a ratio as a whole number of at least 2', () => {
    expect(bodyOf({ kind: 'split', ratio: '10' })).toEqual({ kind: 'split', event_date: '2026-11-01', ratio: 10 })
    for (const ratio of ['', '1', '2,5', '2.0', 'tio']) {
      expect(errorsOf({ kind: 'sammanlaggning', ratio }), ratio).toEqual({ ratio: 'ratio_min' })
    }
  })

  it('refuses a price it cannot read instead of leaving it out', () => {
    const issue = { kind: 'nyemission', to_party: RECEIVER, share_count: '100' }
    expect(bodyOf({ ...issue, price_total: '25 000,50' })).toMatchObject({ price_total: 25000.5 })
    expect(bodyOf(issue)).not.toHaveProperty('price_total')
    expect(errorsOf({ ...issue, price_total: 'tjugo' })).toEqual({ price_total: 'amount_invalid' })
    expect(errorsOf({ ...issue, price_total: '1.2.3' })).toEqual({ price_total: 'amount_invalid' })
    expect(errorsOf({ ...issue, price_total: '-100' })).toEqual({ price_total: 'amount_invalid' })
  })

  it('needs a reason for a rättelse and names the entry it voids', () => {
    const entry = '33333333-3333-4333-8333-333333333333'
    expect(errorsOf({ kind: 'rattelse', corrects_event_id: entry })).toEqual({ note: 'text_required' })
    expect(bodyOf({ kind: 'rattelse', corrects_event_id: entry, note: ' fel antal ' })).toEqual({ kind: 'rattelse', event_date: '2026-11-01', corrects_event_id: entry, note: 'fel antal' })
  })

  it('sends only what the kind uses', () => {
    // Fields left over from another kind are not sent with a note.
    expect(bodyOf({ kind: 'anteckning', note: 'x', share_count: '25.000', ratio: 'abc', price_total: 'abc', from_party_id: HOLDER, to_party: RECEIVER })).toEqual({ kind: 'anteckning', event_date: '2026-11-01', note: 'x' })
    expect(bodyOf({ kind: 'omvandling', from_party_id: HOLDER, share_count: '10', share_class_code: 'A', to_share_class_code: 'B' })).toEqual({
      kind: 'omvandling',
      event_date: '2026-11-01',
      share_class_code: 'A',
      from_party_id: HOLDER,
      share_count: 10,
      to_share_class_code: 'B',
    })
    expect(errorsOf({ kind: 'omvandling', from_party_id: HOLDER, share_count: '10' })).toEqual({ to_share_class_code: 'choose' })
    expect(bodyOf({ kind: 'indragning', from_party_id: HOLDER, share_count: '10', registered_on: '2026-10-30' })).toMatchObject({ registered_on: '2026-10-30' })
  })

  it('reports every field that cannot be read at once', () => {
    expect(errorsOf({ kind: 'nyemission', event_date: '', share_count: '1,5', price_total: 'x' })).toEqual({
      event_date: 'date_required',
      to_party: 'choose',
      share_count: 'whole_number',
      price_total: 'amount_invalid',
    })
  })

  it('sends the entry number the preview saw with the real write, and never with errors', () => {
    const typed = form({ kind: 'anteckning', note: 'x' })
    expect(buildEventBody(typed, { today: TODAY, expectedLastEventNumber: 0 })).toEqual({ ok: true, body: { kind: 'anteckning', event_date: '2026-11-01', note: 'x', expected_last_event_number: 0 } })
    expect(buildEventBody(typed, { today: TODAY })).toEqual({ ok: true, body: { kind: 'anteckning', event_date: '2026-11-01', note: 'x' } })
  })
})

describe('withField', () => {
  it('drops "somebody else with that name" when the name, its kind or the pick changes', () => {
    const typed = form({ to_party: NEW_PARTY, to_name: 'Anna Ek', to_is_new: 'true', counterparty_name: 'Bo Ek', counterparty_is_new: 'true' })
    expect(withField(typed, 'to_name', 'Anna Eko')).toMatchObject({ to_name: 'Anna Eko', to_is_new: '', counterparty_is_new: 'true' })
    expect(withField(typed, 'to_kind', 'company').to_is_new).toBe('')
    expect(withField(typed, 'to_party', RECEIVER).to_is_new).toBe('')
    expect(withField(typed, 'counterparty_name', 'Bo Eko')).toMatchObject({ counterparty_is_new: '', to_is_new: 'true' })
    // Any other field leaves it.
    expect(withField(typed, 'share_count', '10')).toMatchObject({ share_count: '10', to_is_new: 'true', counterparty_is_new: 'true' })
  })
})

describe('shareNumbersLabel', () => {
  it('writes one share as its number and a block as first-last', () => {
    expect(shareNumbersLabel(7, 7)).toBe('7')
    expect(shareNumbersLabel(1, 500)).toBe('1-500')
    expect(shareNumbersLabel(null, null)).toBe('')
    expect(shareNumbersLabel(1, 25000, (n) => `#${n}`)).toBe('#1-#25000')
  })
})

describe('voteSharesAfter', () => {
  const classes = [
    { share_class_id: 'a', votes_per_share: 10 },
    { share_class_id: 'b', votes_per_share: 1 },
  ]
  const holders = [
    { party_id: 'p1', name: 'Anna', votes_pct: 90.91, by_class: [{ share_class_id: 'a', shares: 100 }] },
    { party_id: 'p2', name: 'Bo', votes_pct: 9.09, by_class: [{ share_class_id: 'b', shares: 100 }] },
  ]

  it('gives each holder the share of the votes after the change', () => {
    expect(voteSharesAfter(holders, classes, 'a', 1)).toEqual([
      { party_id: 'p1', name: 'Anna', before_pct: 90.91, after_pct: 50 },
      { party_id: 'p2', name: 'Bo', before_pct: 9.09, after_pct: 50 },
    ])
  })

  it('leaves the shares of the votes alone when every share is of the changed class', () => {
    const oneClass = [{ share_class_id: 'a', votes_per_share: 1 }]
    const owners = [
      { party_id: 'p1', name: 'Anna', votes_pct: 66.67, by_class: [{ share_class_id: 'a', shares: 200 }] },
      { party_id: 'p2', name: 'Bo', votes_pct: 33.33, by_class: [{ share_class_id: 'a', shares: 100 }] },
    ]
    expect(voteSharesAfter(owners, oneClass, 'a', 10).map((h) => h.after_pct)).toEqual([66.67, 33.33])
  })

  it('answers zero for a register without shares', () => {
    expect(voteSharesAfter([], classes, 'a', 2)).toEqual([])
  })
})
