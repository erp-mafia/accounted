/**
 * accounted#180: a 0 kr bolagsskatt preview names the proposals that zero it,
 * the tax without them and whether skipping one is a way to pay tax this
 * year. The wizard renders the same explanation from the sv/en catalogues.
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { explainZeroedTax } from '../zeroed-tax'
import type { BolagsskattBasis } from '../types'

const overavskrivning = { kind: 'overavskrivningar' as const, label: 'Förändring av överavskrivningar', resultEffect: -60_000 }
const avsattning = { kind: 'periodiseringsfond_avsattning' as const, label: 'Avsättning till periodiseringsfond', resultEffect: -2 }
const slp = { kind: 'sarskild_loneskatt' as const, label: 'Särskild löneskatt', resultEffect: -500 }
const ateforing = { kind: 'periodiseringsfond_ateforing' as const, label: 'Återföring periodiseringsfond 2020', resultEffect: 1_000 }

function basis(pending: BolagsskattBasis['pending'], overrides: Partial<BolagsskattBasis> = {}): BolagsskattBasis {
  return {
    bookedResultBeforeTax: 50_000,
    pending,
    taxWithProposals: 0,
    taxAsBooked: 10_300,
    zeroedBy: pending.filter((p) => p.resultEffect < 0),
    ...overrides,
  }
}

describe('explainZeroedTax', () => {
  it('names the optional proposals, the tax without them, and offers the skip', () => {
    expect(explainZeroedTax(basis([overavskrivning, avsattning]))).toEqual({
      zeroedBy: [overavskrivning, avsattning],
      taxWithout: 10_300,
      canSkip: true,
    })
  })

  it('gives no figure when a mandatory återföring is pending, but still offers the skip', () => {
    expect(explainZeroedTax(basis([ateforing, overavskrivning]))).toEqual({
      zeroedBy: [overavskrivning],
      taxWithout: null,
      canSkip: true,
    })
  })

  it('offers no skip when only a tax owed zeroes it', () => {
    expect(explainZeroedTax(basis([slp]))).toEqual({ zeroedBy: [slp], taxWithout: null, canSkip: false })
  })

  it('is null when no proposal zeroes the tax', () => {
    expect(explainZeroedTax(undefined)).toBeNull()
    expect(explainZeroedTax(basis([overavskrivning], { taxWithProposals: 1_000, zeroedBy: [] }))).toBeNull()
  })
})

describe('the 0 kr explanation in both catalogues', () => {
  const svT = createTranslator({ locale: 'sv', messages: sv, namespace: 'dispositions_tax_basis' })
  const enT = createTranslator({ locale: 'en', messages: en, namespace: 'dispositions_tax_basis' })
  const list = 'Förändring av överavskrivningar (-60 000 kr)'

  it('names the dispositions and the tax without them', () => {
    expect(svT('zeroed_by', { list })).toBe(
      `Skatten blir 0 kr om de här föreslagna dispositionerna bokförs: ${list}.`,
    )
    expect(enT('zeroed_by', { list })).toBe(`The tax is 0 kr if these proposed dispositions are booked: ${list}.`)
    expect(svT('zeroed_without', { amount: '10 300 kr' })).toBe('Utan dem blir skatten 10 300 kr.')
    expect(enT('zeroed_without', { amount: '10 300 kr' })).toBe('Without them the tax is 10 300 kr.')
  })

  it('says the optional ones can be skipped, without a dash', () => {
    expect(svT('zeroed_skip')).toContain('avmarkera dem (Hoppa över)')
    expect(enT('zeroed_skip')).toContain('untick them (Hoppa över)')
    expect(svT('booked_result')).toBe('Resultat före skatt i bokföringen')
    expect(enT('booked_result')).toBe('Result before tax in the books')
    for (const text of [svT('zeroed_skip'), enT('zeroed_skip'), svT('zeroed_by', { list }), enT('zeroed_by', { list })]) {
      expect(text).not.toMatch(/[–—]/)
    }
  })
})
