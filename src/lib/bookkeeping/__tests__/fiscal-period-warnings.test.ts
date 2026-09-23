import { describe, it, expect } from 'vitest'
import {
  extractFiscalPeriodWarnings,
  fiscalPeriodAdvisoryText,
} from '../fiscal-period-warnings'

/** The exact 200 body the route returns when a prior räkenskapsår is open. */
const PRIOR_OPEN_MESSAGE =
  'Räkenskapsåret är skapat och du kan bokföra i det direkt. FY2025 är fortfarande öppet, ' +
  'vilket är normalt medan bokslutet pågår: du får bokföra i båda åren samtidigt. ' +
  'Ingående balanser bokförs automatiskt när bokslutet för föregående år körs.'

const successWithAdvisory = {
  data: { id: 'p1', name: 'FY2026' },
  warnings: [{ code: 'PRIOR_FISCAL_YEAR_STILL_OPEN', message: PRIOR_OPEN_MESSAGE }],
}

/** The plain 200 body: the route omits `warnings` entirely. */
const successWithoutAdvisory = { data: { id: 'p1', name: 'FY2026' } }

describe('extractFiscalPeriodWarnings', () => {
  it('reads the PRIOR_FISCAL_YEAR_STILL_OPEN advisory off a success response', () => {
    expect(extractFiscalPeriodWarnings(successWithAdvisory)).toEqual([
      { code: 'PRIOR_FISCAL_YEAR_STILL_OPEN', message: PRIOR_OPEN_MESSAGE },
    ])
  })

  it('returns nothing when the route omits the warnings key', () => {
    expect(extractFiscalPeriodWarnings(successWithoutAdvisory)).toEqual([])
  })

  it('returns nothing for an empty warnings array', () => {
    expect(extractFiscalPeriodWarnings({ data: {}, warnings: [] })).toEqual([])
  })

  it('returns nothing for null, non-objects and a non-array warnings value', () => {
    expect(extractFiscalPeriodWarnings(null)).toEqual([])
    expect(extractFiscalPeriodWarnings(undefined)).toEqual([])
    expect(extractFiscalPeriodWarnings('boom')).toEqual([])
    expect(extractFiscalPeriodWarnings({ warnings: 'nope' })).toEqual([])
    expect(extractFiscalPeriodWarnings({ warnings: { code: 'X', message: 'Y' } })).toEqual([])
  })

  it('drops malformed entries instead of rendering a blank advisory', () => {
    const payload = {
      data: {},
      warnings: [
        null,
        'string entry',
        { code: 'NO_MESSAGE' },
        { message: 'no code' },
        { code: '', message: 'empty code' },
        { code: 'BLANK', message: '   ' },
        { code: 'OK', message: 'Detta visas.' },
      ],
    }
    expect(extractFiscalPeriodWarnings(payload)).toEqual([{ code: 'OK', message: 'Detta visas.' }])
  })

  it('keeps multiple well-formed warnings in order', () => {
    const payload = {
      warnings: [
        { code: 'A', message: 'Första.' },
        { code: 'B', message: 'Andra.' },
      ],
    }
    expect(extractFiscalPeriodWarnings(payload).map((w) => w.code)).toEqual(['A', 'B'])
  })

  // The old behaviour: creation was REFUSED with 409
  // PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS and the blocking periods rode in
  // `error.details`. That payload carries no advisory, so the new UI shows
  // none and falls through to its error toast, as it should.
  it('returns nothing for the retired 409 error envelope', () => {
    const legacy409 = {
      error: {
        code: 'PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS',
        message: 'Du måste låsa föregående räkenskapsår innan du kan skapa ett nytt.',
        details: { blockingPeriods: [{ id: 'p0', name: 'FY2025' }] },
      },
    }
    expect(extractFiscalPeriodWarnings(legacy409)).toEqual([])
  })
})

describe('fiscalPeriodAdvisoryText', () => {
  it('is the message itself for the single advisory the route emits', () => {
    expect(fiscalPeriodAdvisoryText(successWithAdvisory)).toBe(PRIOR_OPEN_MESSAGE)
  })

  it('is empty on a clean success, so the UI renders no attn line', () => {
    expect(fiscalPeriodAdvisoryText(successWithoutAdvisory)).toBe('')
    expect(fiscalPeriodAdvisoryText({ data: {}, warnings: [] })).toBe('')
  })

  it('joins several advisories into one ochre sentence run', () => {
    const payload = {
      warnings: [
        { code: 'A', message: 'Första.' },
        { code: 'B', message: 'Andra.' },
      ],
    }
    expect(fiscalPeriodAdvisoryText(payload)).toBe('Första. Andra.')
  })
})
