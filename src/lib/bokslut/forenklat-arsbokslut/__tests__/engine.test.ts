import { describe, expect, it } from 'vitest'
import { computeForenklatArsbokslut, type K1EngineInput } from '../engine'
import type { K1StatementRow, K1TrialBalanceRow, K1YearBalances } from '../types'

/** Trial balance rows from signed balances: debit positive, credit negative. */
function tb(balances: Record<string, number>): K1TrialBalanceRow[] {
  return Object.entries(balances).map(([account_number, balance]) => ({
    account_number,
    account_name: `Konto ${account_number}`,
    closing_debit: balance > 0 ? balance : 0,
    closing_credit: balance < 0 ? -balance : 0,
  }))
}

// The current year: medlemsavgifter, a gift, sales, costs, one interest income.
// Årets över-/underskott 51 500.
const CURRENT_RESULT = {
  '3901': -100_000,
  '3993': -20_000,
  '3004': -15_000,
  '6710': 30_000,
  '5010': 40_000,
  '7210': 10_000,
  '8310': -500,
  '7832': 4_000,
}
const CURRENT_BALANCE = {
  '1930': 155_000,
  '1220': 20_000,
  '1229': -4_000,
  '2440': -5_000,
  '2710': -2_000,
  '2067': -112_500,
}

// The previous year: an underskott of 5 000, closed into 2069.
const PREVIOUS_RESULT = { '3901': -90_000, '6710': 60_000, '5010': 35_000 }
const PREVIOUS_BALANCE = { '1930': 120_000, '2440': -7_500, '2067': -117_500 }

/** A year closed by the wizard: P&L accounts zeroed against 2069. */
function closedYear(result: Record<string, number>, balance: Record<string, number>): K1YearBalances {
  const outcome = Object.values(result).reduce((sum, v) => sum + v, 0)
  return { full: tb({ ...balance, '2069': outcome }), preClosing: tb({ ...result, ...balance }) }
}

/** A year never closed in these books: the P&L accounts still carry the result. */
function openYear(result: Record<string, number>, balance: Record<string, number>): K1YearBalances {
  const rows = tb({ ...result, ...balance })
  return { full: rows, preClosing: rows }
}

function input(overrides: Partial<K1EngineInput> = {}): K1EngineInput {
  return {
    current: closedYear(CURRENT_RESULT, CURRENT_BALANCE),
    previous: closedYear(PREVIOUS_RESULT, PREVIOUS_BALANCE),
    isClosed: true,
    closingAccount: '2069',
    ...overrides,
  }
}

function row(rows: K1StatementRow[], label: string): K1StatementRow | undefined {
  return rows.find((r) => r.label === label)
}

function figures(rows: K1StatementRow[]): Array<[string, number | null, number | null]> {
  return rows.map((r) => [r.label, r.current, r.previous])
}

describe('computeForenklatArsbokslut: a closed year with comparatives', () => {
  const result = computeForenklatArsbokslut(input())

  it('builds the resultaträkning in the bilaga 2 layout, leaving out empty lines and keeping signs', () => {
    expect(figures(result.resultatrakning)).toEqual([
      ['Intäkter', null, null],
      ['Medlemsavgifter', 100_000, 90_000],
      ['Gåvor och bidrag', 20_000, 0],
      ['Försäljningsintäkter', 15_000, 0],
      ['Summa intäkter', 135_000, 90_000],
      ['Kostnader', null, null],
      ['Verksamhetskostnader', -30_000, -60_000],
      ['Övriga externa kostnader', -40_000, -35_000],
      ['Personalkostnader', -10_000, 0],
      ['Av- och nedskrivningar av materiella och immateriella anläggningstillgångar', -4_000, 0],
      ['Summa kostnader', -84_000, -95_000],
      ['Verksamhetens över-/underskott', 51_000, -5_000],
      ['Finansiella intäkter', 500, 0],
      ['Över-/underskott efter finansiella poster', 51_500, -5_000],
      ['Årets över-/underskott', 51_500, -5_000],
    ])
  })

  it('builds the balansräkning with årets över-/underskott from 2069', () => {
    expect(figures(result.balansrakning)).toEqual([
      ['Tillgångar', null, null],
      ['Inventarier', 16_000, 0],
      ['Kassa och bank', 155_000, 120_000],
      ['Summa tillgångar', 171_000, 120_000],
      ['Eget kapital', null, null],
      ['Balanserade över-/underskott', 112_500, 117_500],
      ['Årets över-/underskott', 51_500, -5_000],
      ['Summa eget kapital', 164_000, 112_500],
      ['Skulder', null, null],
      ['Leverantörsskulder', 5_000, 7_500],
      ['Skatteskulder', 2_000, 0],
      ['Summa skulder', 7_000, 7_500],
      ['Summa eget kapital och skulder', 171_000, 120_000],
    ])
  })

  it('names the accounts behind a post for the screen and the JSON, never netting one post into another', () => {
    expect(row(result.balansrakning, 'Inventarier')?.accounts).toEqual([
      { account_number: '1220', account_name: 'Konto 1220', current: 20_000, previous: 0 },
      { account_number: '1229', account_name: 'Konto 1229', current: -4_000, previous: 0 },
    ])
    expect(row(result.resultatrakning, 'Medlemsavgifter')?.accounts).toEqual([
      { account_number: '3901', account_name: 'Konto 3901', current: 100_000, previous: 90_000 },
    ])
  })

  it('has no blockers or warnings, and reports the totals', () => {
    expect(result.blockers).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.totals.aretsOverUnderskott).toEqual({ current: 51_500, previous: -5_000 })
    expect(result.totals.summaTillgangar).toEqual({ current: 171_000, previous: 120_000 })
    expect(result.totals.nettoomsattning).toEqual({ current: 135_000, previous: 90_000 })
  })
})

describe('computeForenklatArsbokslut: the first year', () => {
  it('prints no comparison column', () => {
    const result = computeForenklatArsbokslut(input({ previous: null }))
    expect(row(result.resultatrakning, 'Medlemsavgifter')).toMatchObject({ current: 100_000, previous: null })
    expect(row(result.balansrakning, 'Summa tillgångar')).toMatchObject({ current: 171_000, previous: null })
    expect(result.totals.aretsOverUnderskott.previous).toBeNull()
    expect(result.warnings).toEqual([])
  })

  it('warns when a previous year exists but could not be read', () => {
    const result = computeForenklatArsbokslut(input({ previous: null, previousUnavailable: true }))
    expect(result.warnings.map((w) => w.code)).toEqual(['COMPARATIVE_YEAR_UNAVAILABLE'])
  })
})

describe('computeForenklatArsbokslut: blockers', () => {
  it('refuses an open year, but still previews it with the result read off the result accounts', () => {
    const result = computeForenklatArsbokslut(
      input({ current: openYear(CURRENT_RESULT, CURRENT_BALANCE), isClosed: false }),
    )
    expect(result.blockers.map((b) => b.code)).toEqual(['YEAR_NOT_CLOSED'])
    expect(row(result.balansrakning, 'Årets över-/underskott')).toMatchObject({ current: 51_500 })
    expect(row(result.balansrakning, 'Summa eget kapital och skulder')).toMatchObject({ current: 171_000 })
  })

  it('refuses a year whose 2069 still carries last year\'s result', () => {
    const current = closedYear(CURRENT_RESULT, { ...CURRENT_BALANCE, '2067': -117_500 })
    // The carry from 2069 to 2068 never ran: 2069 holds both years.
    current.full = tb({ ...CURRENT_BALANCE, '2067': -117_500, '2069': -46_500 })
    const result = computeForenklatArsbokslut(input({ current }))
    expect(result.blockers.map((b) => b.code)).toEqual(['RESULT_DIFFERS_FROM_CLOSING_ACCOUNT'])
    expect(result.blockers[0].message).toMatch(/51\s500,00/)
    expect(result.blockers[0].message).toMatch(/46\s500,00/)
    expect(result.blockers[0].message).toContain('2069')
  })

  it('refuses a booked avsättning (BFNAR 2010:1 6.68), which also leaves the balansräkning short', () => {
    const current = closedYear(CURRENT_RESULT, { ...CURRENT_BALANCE, '1930': 158_000, '2290': -3_000 })
    const result = computeForenklatArsbokslut(input({ current }))
    expect(result.blockers.map((b) => b.code)).toEqual(['AVSATTNING_BOOKED', 'BALANCE_SHEET_UNBALANCED'])
    expect(result.blockers[0].message).toContain('2290')
    expect(result.blockers[0].message).toContain('6.68')
  })

  it('refuses another form\'s equity account and names it', () => {
    const current = closedYear(CURRENT_RESULT, { ...CURRENT_BALANCE, '2067': -100_000, '2091': -12_500 })
    const result = computeForenklatArsbokslut(input({ current }))
    expect(result.blockers.map((b) => b.code)).toEqual(['ACCOUNT_OUTSIDE_LAYOUT', 'BALANCE_SHEET_UNBALANCED'])
    expect(result.blockers[0].message).toContain('2091')
  })
})

describe('computeForenklatArsbokslut: warnings', () => {
  it('warns about förutbetalda medlemsavgifter on 2972 (6.73, 7.1)', () => {
    const current = closedYear(CURRENT_RESULT, { ...CURRENT_BALANCE, '1930': 160_000, '2972': -5_000 })
    const result = computeForenklatArsbokslut(input({ current }))
    expect(result.blockers).toEqual([])
    expect(result.warnings.map((w) => w.code)).toEqual(['PREPAID_MEMBER_FEES'])
    expect(row(result.balansrakning, 'Övriga skulder')).toMatchObject({ current: 5_000 })
  })

  it('warns when nettoomsättning with medlemsavgifter, gåvor and bidrag is above three million', () => {
    const big = { ...CURRENT_RESULT, '3901': -3_100_000 }
    const current = closedYear(big, { ...CURRENT_BALANCE, '1930': 3_155_000 })
    const once = computeForenklatArsbokslut(input({ current }))
    expect(once.warnings.map((w) => w.code)).toEqual(['NETTOOMSATTNING_ABOVE_LIMIT'])
    expect(once.warnings[0].message).toContain('ett enstaka år')

    const previous = closedYear({ ...PREVIOUS_RESULT, '3901': -3_200_000 }, { ...PREVIOUS_BALANCE, '1930': 3_230_000 })
    const twice = computeForenklatArsbokslut(input({ current, previous }))
    expect(twice.warnings[0].message).toContain('även föregående år')
    expect(twice.warnings[0].message).toContain('6 kap. 4 §')
  })

  it('derives the comparison year\'s result when that year was never closed in these books', () => {
    const result = computeForenklatArsbokslut(input({ previous: openYear(PREVIOUS_RESULT, PREVIOUS_BALANCE) }))
    expect(result.warnings.map((w) => w.code)).toEqual(['COMPARATIVE_YEAR_DERIVED'])
    expect(row(result.balansrakning, 'Årets över-/underskott')).toMatchObject({ previous: -5_000 })
    expect(row(result.balansrakning, 'Summa eget kapital och skulder')).toMatchObject({ previous: 120_000 })
  })

  it('warns when the comparison balansräkning does not balance', () => {
    const previous = closedYear(PREVIOUS_RESULT, { ...PREVIOUS_BALANCE, '1930': 121_000 })
    const result = computeForenklatArsbokslut(input({ previous }))
    expect(result.blockers).toEqual([])
    expect(result.warnings.map((w) => w.code)).toEqual(['COMPARATIVE_YEAR_UNBALANCED'])
  })
})

describe('computeForenklatArsbokslut: classification', () => {
  it('shows a net skattefordran under övriga fordringar (BFN example 5-1)', () => {
    const current = closedYear(CURRENT_RESULT, {
      ...CURRENT_BALANCE,
      '2710': 0,
      '2650': 3_000,
      '1930': 150_000,
    })
    const result = computeForenklatArsbokslut(input({ current }))
    expect(result.blockers).toEqual([])
    expect(row(result.balansrakning, 'Skatteskulder')).toBeUndefined()
    expect(row(result.balansrakning, 'Övriga fordringar')).toMatchObject({ current: 3_000 })
  })

  it('keeps financial income and cost apart and prints the line after financial posts only when it adds one', () => {
    const withCost = { ...CURRENT_RESULT, '8410': 1_000, '8220': -700 }
    const current = closedYear(withCost, { ...CURRENT_BALANCE, '1930': 154_700 })
    const result = computeForenklatArsbokslut(input({ current }))
    expect(row(result.resultatrakning, 'Finansiella intäkter')).toMatchObject({ current: 1_200 })
    expect(row(result.resultatrakning, 'Finansiella kostnader')).toMatchObject({ current: -1_000 })

    const noFinancial = Object.fromEntries(Object.entries(CURRENT_RESULT).filter(([k]) => k !== '8310'))
    const plain = computeForenklatArsbokslut(
      input({ current: closedYear(noFinancial, { ...CURRENT_BALANCE, '1930': 154_500 }), previous: null }),
    )
    expect(row(plain.resultatrakning, 'Över-/underskott efter finansiella poster')).toBeUndefined()
    expect(row(plain.resultatrakning, 'Årets över-/underskott')).toMatchObject({ current: 51_000 })
  })

  it('leaves 899x out of the posts', () => {
    const current = closedYear(CURRENT_RESULT, CURRENT_BALANCE)
    current.preClosing = [...current.preClosing, ...tb({ '8999': 1_000 })]
    const result = computeForenklatArsbokslut(input({ current }))
    expect(result.totals.aretsOverUnderskott.current).toBe(51_500)
    expect(result.blockers).toEqual([])
  })
})
