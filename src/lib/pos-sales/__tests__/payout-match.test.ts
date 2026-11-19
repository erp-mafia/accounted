import { describe, expect, it } from 'vitest'
import {
  CARD_BALANCE_FIT,
  CARD_RUN_FIT,
  SWISH_MAX_LAG_DAYS,
  matchPosPayouts,
  type PayoutBankRow,
  type PayoutCardDay,
  type PayoutSwishReceipt,
} from '../payout-match'

/**
 * The matcher on neutral fixtures (Café Exempel): the Swish rule (exact to
 * the öre, the lag window, one receipt per row, the weekend, booked rows
 * first) and the card rule (one day, Friday and Saturday on Monday, the
 * larger payout the running balance catches, a day paid once).
 */

const CONN = 'conn-cafe-exempel'

const receipt = (over: Partial<PayoutSwishReceipt> & Pick<PayoutSwishReceipt, 'number' | 'amount' | 'paid_on'>): PayoutSwishReceipt => ({
  day_id: `day-${over.paid_on}`,
  connection_id: CONN,
  business_date: over.paid_on,
  ...over,
})

const swishRow = (id: string, date: string, amount: number, booked = false): PayoutBankRow => ({
  id,
  date,
  amount,
  booked,
  swish: true,
  card: booked,
})

const cardRow = (id: string, date: string, amount: number, booked = false): PayoutBankRow => ({
  id,
  date,
  amount,
  booked,
  swish: booked,
  card: true,
})

const day = (business_date: string, card: number, connection_id = CONN): PayoutCardDay => ({
  day_id: `day-${connection_id}-${business_date}`,
  connection_id,
  business_date,
  card,
})

describe('matchPosPayouts: Swish', () => {
  it('matches a row to the receipt of exactly its amount, gross plus tips', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [receipt({ number: '1834', amount: 145.5, paid_on: '2026-10-06' })],
      rows: [swishRow('tx-1', '2026-10-06', 145.5)],
    })
    expect(matches.get('tx-1')).toEqual({
      kind: 'swish',
      fit: 'receipt',
      connection_id: CONN,
      day_id: 'day-2026-10-06',
      business_date: '2026-10-06',
      receipt_number: '1834',
      expected: 145.5,
    })
  })

  it('wants the öre: one öre off is no match', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [receipt({ number: '1834', amount: 145.5, paid_on: '2026-10-06' })],
      rows: [swishRow('tx-1', '2026-10-06', 145.49)],
    })
    expect(matches.size).toBe(0)
  })

  it(`takes receipts paid 0 to ${SWISH_MAX_LAG_DAYS} days before the row, never after it`, () => {
    const receipts = [receipt({ number: '7', amount: 80, paid_on: '2026-10-01' })]
    expect(matchPosPayouts({ cardDays: [], receipts, rows: [swishRow('tx-5', '2026-10-06', 80)] }).has('tx-5')).toBe(true)
    expect(matchPosPayouts({ cardDays: [], receipts, rows: [swishRow('tx-6', '2026-10-07', 80)] }).size).toBe(0)
    expect(matchPosPayouts({ cardDays: [], receipts, rows: [swishRow('tx-early', '2026-09-30', 80)] }).size).toBe(0)
  })

  it('lets one receipt explain one row only', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [receipt({ number: '1834', amount: 145.5, paid_on: '2026-10-06' })],
      rows: [swishRow('tx-a', '2026-10-06', 145.5), swishRow('tx-b', '2026-10-06', 145.5)],
    })
    expect([...matches.keys()]).toEqual(['tx-a'])
  })

  it('puts a weekend on Monday: two Monday rows take the Saturday and the Sunday receipt', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [
        receipt({ number: '201', amount: 200, paid_on: '2026-10-03' }),
        receipt({ number: '305', amount: 200, paid_on: '2026-10-04' }),
      ],
      rows: [swishRow('tx-mon-1', '2026-10-05', 200), swishRow('tx-mon-2', '2026-10-05', 200)],
    })
    const numbers = [...matches.values()].map((m) => (m.kind === 'swish' ? m.receipt_number : null)).sort()
    expect(numbers).toEqual(['201', '305'])
  })

  it('takes the closest receipt of the amount', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [
        receipt({ number: '11', amount: 95, paid_on: '2026-10-02' }),
        receipt({ number: '58', amount: 95, paid_on: '2026-10-05' }),
      ],
      rows: [swishRow('tx-1', '2026-10-05', 95)],
    })
    const m = matches.get('tx-1')
    expect(m?.kind === 'swish' && m.receipt_number).toBe('58')
  })

  it('lets a row already booked against the tender account keep its receipt, even a later one', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [receipt({ number: '1834', amount: 145.5, paid_on: '2026-10-05' })],
      rows: [swishRow('tx-open', '2026-10-05', 145.5), swishRow('tx-booked', '2026-10-06', 145.5, true)],
    })
    expect(matches.size).toBe(0)
  })

  it('never returns a booked row, and never matches a row not on a Swish rail', () => {
    const matches = matchPosPayouts({
      cardDays: [],
      receipts: [
        receipt({ number: '1', amount: 50, paid_on: '2026-10-05' }),
        receipt({ number: '2', amount: 60, paid_on: '2026-10-05' }),
      ],
      rows: [swishRow('tx-booked', '2026-10-05', 50, true), { ...swishRow('tx-bg', '2026-10-05', 60), swish: false }],
    })
    expect(matches.size).toBe(0)
  })
})

describe('matchPosPayouts: card', () => {
  it('fits a payout a little under one day, the next banking day', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-06', 10_000)],
      receipts: [],
      rows: [cardRow('tx-1', '2026-10-07', 9_910)],
    })
    expect(matches.get('tx-1')).toEqual({
      kind: 'card',
      fit: 'days',
      connection_id: CONN,
      day_ids: [`day-${CONN}-2026-10-06`],
      business_dates: ['2026-10-06'],
      expected: 10_000,
    })
  })

  it('fits Friday and Saturday paid together on Monday', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-01', 9_000), day('2026-10-02', 12_000), day('2026-10-03', 15_000)],
      receipts: [],
      rows: [cardRow('tx-thu', '2026-10-02', 8_930, true), cardRow('tx-mon', '2026-10-05', 26_730)],
    })
    const m = matches.get('tx-mon')
    expect(m?.kind === 'card' && m.fit).toBe('days')
    expect(m?.kind === 'card' && m.business_dates).toEqual(['2026-10-02', '2026-10-03'])
    expect(m?.expected).toBe(27_000)
  })

  it('catches the larger payout that pays the open tails off through the running balance', () => {
    // Four payouts at 99.1 % leave 90 kr of each day open; Friday's payout
    // on Monday is 4.6 % above Friday and pays the tails off.
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((d) => day(d, 10_000))
    const friday = day('2026-10-09', 6_000)
    const rows = [
      cardRow('tx-tue', '2026-10-06', 9_910, true),
      cardRow('tx-wed', '2026-10-07', 9_910, true),
      cardRow('tx-thu', '2026-10-08', 9_910, true),
      cardRow('tx-fri', '2026-10-09', 9_910, true),
      cardRow('tx-mon', '2026-10-12', 6_276),
    ]
    expect(6_276 / 6_000).toBeGreaterThan(CARD_RUN_FIT.max)
    const matches = matchPosPayouts({ cardDays: [...days, friday], receipts: [], rows })
    const m = matches.get('tx-mon')
    expect(m?.kind === 'card' && m.fit).toBe('balance')
    expect(m?.expected).toBe(6_360)
    expect(6_276 / 6_360).toBeGreaterThanOrEqual(CARD_BALANCE_FIT.min)
    expect(m?.kind === 'card' && m.business_dates.at(-1)).toBe('2026-10-09')
  })

  it('works the same when the earlier payouts are still open rows of the same batch', () => {
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((d) => day(d, 10_000))
    const rows = [
      cardRow('tx-tue', '2026-10-06', 9_910),
      cardRow('tx-wed', '2026-10-07', 9_910),
      cardRow('tx-thu', '2026-10-08', 9_910),
      cardRow('tx-fri', '2026-10-09', 9_910),
      cardRow('tx-mon', '2026-10-12', 6_276),
    ]
    const matches = matchPosPayouts({ cardDays: [...days, day('2026-10-09', 6_000)], receipts: [], rows })
    expect([...matches.keys()].sort()).toEqual(['tx-fri', 'tx-mon', 'tx-thu', 'tx-tue', 'tx-wed'])
    expect(matches.get('tx-tue')?.kind === 'card' && (matches.get('tx-tue') as { fit: string }).fit).toBe('days')
    expect((matches.get('tx-mon') as { fit: string }).fit).toBe('balance')
  })

  it('pays a day once: a second payout of the same day fits nothing', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-06', 10_000)],
      receipts: [],
      rows: [cardRow('tx-1', '2026-10-07', 9_910), cardRow('tx-2', '2026-10-08', 9_910)],
    })
    expect([...matches.keys()]).toEqual(['tx-1'])
  })

  it('lets a booked payout pay its day off, so an open row of the same amount fits nothing', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-06', 10_000)],
      receipts: [],
      rows: [cardRow('tx-booked', '2026-10-07', 9_910, true), cardRow('tx-open', '2026-10-08', 9_910)],
    })
    expect(matches.size).toBe(0)
  })

  it('pays nothing off for a row that fits nothing', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-06', 10_000)],
      receipts: [],
      rows: [cardRow('tx-odd', '2026-10-07', 5_000), cardRow('tx-1', '2026-10-08', 9_910)],
    })
    expect([...matches.keys()]).toEqual(['tx-1'])
  })

  it('needs one to five days between the business day and the payout', () => {
    const cardDays = [day('2026-10-06', 10_000)]
    expect(matchPosPayouts({ cardDays, receipts: [], rows: [cardRow('tx-same-day', '2026-10-06', 9_910)] }).size).toBe(0)
    expect(matchPosPayouts({ cardDays, receipts: [], rows: [cardRow('tx-late', '2026-10-12', 9_910)] }).size).toBe(0)
    expect(matchPosPayouts({ cardDays, receipts: [], rows: [cardRow('tx-5', '2026-10-11', 9_910)] }).size).toBe(1)
  })

  it('stays out of the band it was not shaped for: far under the day, or the row not card-shaped', () => {
    const cardDays = [day('2026-10-06', 10_000)]
    expect(matchPosPayouts({ cardDays, receipts: [], rows: [cardRow('tx-low', '2026-10-07', 9_700)] }).size).toBe(0)
    expect(
      matchPosPayouts({ cardDays, receipts: [], rows: [{ ...cardRow('tx-named', '2026-10-07', 9_910), card: false }] }).size,
    ).toBe(0)
  })

  it('keeps venues apart: a payout fits the days of one connection', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-06', 10_000, 'conn-a'), day('2026-10-06', 4_000, 'conn-b')],
      receipts: [],
      rows: [cardRow('tx-b', '2026-10-07', 3_970)],
    })
    expect(matches.get('tx-b')?.connection_id).toBe('conn-b')
  })

  it('leaves a Swish row to the Swish rule', () => {
    const matches = matchPosPayouts({
      cardDays: [day('2026-10-06', 145.5)],
      receipts: [receipt({ number: '9', amount: 145.5, paid_on: '2026-10-07' })],
      rows: [{ ...swishRow('tx-1', '2026-10-07', 145.5), card: true }],
    })
    expect(matches.get('tx-1')?.kind).toBe('swish')
  })
})
