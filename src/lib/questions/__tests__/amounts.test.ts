import { describe, expect, it } from 'vitest'
import { amountsNotAmong, findMoneyMentions, isAmountAmong } from '../amounts'

const values = (text: string) => findMoneyMentions(text).map((m) => m.readings.map((r) => r.value))
const first = (text: string) => findMoneyMentions(text)[0]

describe('findMoneyMentions', () => {
  it('reads Swedish amounts: space, no-break space and dot as thousands, comma as decimal', () => {
    expect(values('Leverantören drog 4 990 kr den 3 november, mot 2 195 kr tidigare.')).toEqual([[4990], [2195]])
    expect(values('1 250,50 kr och 12 500 SEK och 3 000 kronor')).toEqual([[1250.5], [12500], [3000]])
    expect(values('1.250,50 kr')).toEqual([[1250.5]])
    expect(values('1.234.567,89 SEK')).toEqual([[1234567.89]])
    expect(values('4990:-')).toEqual([[4990]])
    expect(first('4 990,00 kr')).toEqual({ text: '4 990,00 kr', readings: [{ value: 4990, exact: true }] })
    expect(first('4 990 kr').readings).toEqual([{ value: 4990, exact: false }])
  })

  it('reads English amounts: comma as thousands, dot as decimal', () => {
    expect(values('The charge was 1,250.50 USD, then 1,250,000 SEK and 12.50 EUR.')).toEqual([[1250.5], [1250000], [12.5]])
    expect(values('$1,250.50 and €99 and SEK 4 990')).toEqual([[1250.5], [99], [4990]])
    expect(values('100 €')).toEqual([[100]])
  })

  it('gives both readings when the format is ambiguous', () => {
    expect(first('1,250 kr').readings).toEqual([
      { value: 1.25, exact: true },
      { value: 1250, exact: false },
    ])
    expect(first('1.250 kr').readings).toEqual([
      { value: 1250, exact: false },
      { value: 1.25, exact: true },
    ])
  })

  it('reads scaled amounts as round figures', () => {
    expect(first('3 miljoner kronor').readings).toEqual([{ value: 3_000_000, exact: false }])
    expect(first('400 tkr').readings).toEqual([{ value: 400_000, exact: false }])
    expect(first('1,2 mkr').readings).toEqual([{ value: 1_200_000, exact: false }])
    expect(first('2 million USD').readings).toEqual([{ value: 2_000_000, exact: false }])
  })

  it('ignores the sign', () => {
    expect(values('-4 990,00 kr och −2 195 kr')).toEqual([[4990], [2195]])
  })

  it('does not read years, dates, percentages or invoice numbers', () => {
    expect(findMoneyMentions('Faktura 1042 från 2026-11-05 avser 25 % av årets 12 leveranser 2026.')).toEqual([])
    expect(findMoneyMentions('Konto 1930 och verifikat A373 den 27 april.')).toEqual([])
    expect(findMoneyMentions('Omräknat i SEK 2026-11-05.')).toEqual([])
    expect(findMoneyMentions('Vi har 3 krav och 100 kronjuveler.')).toEqual([])
  })

  it('keeps a number before the amount out of it', () => {
    expect(values('Faktura 1042 4 990 kr saknar underlag.')).toEqual([[4990]])
    expect(values('Faktura 1042 123 kr.')).toEqual([[123]])
    expect(values('Den 3 november 2026 12 500 kr.')).toEqual([[12500]])
  })

  it('reads an amount with a unit that continues the sentence', () => {
    expect(values('Hyran är 18 500 kr/mån.')).toEqual([[18500]])
    expect(values('Saldot (316 000 kr) står kvar.')).toEqual([[316000]])
    expect(values('Det kostade 99 kr.')).toEqual([[99]])
  })
})

describe('isAmountAmong', () => {
  it('compares to the öre when the text has decimals', () => {
    expect(isAmountAmong(first('4 989,60 kr'), [4989.6])).toBe(true)
    expect(isAmountAmong(first('4 989,60 kr'), [-4989.6])).toBe(true)
    expect(isAmountAmong(first('4 989,60 kr'), [4989.61])).toBe(false)
    expect(isAmountAmong(first('4 990,00 kr'), [4989.6])).toBe(false)
  })

  it('compares to the whole krona when the text has none: rounded, or with the öre dropped', () => {
    expect(isAmountAmong(first('4 990 kr'), [4989.6])).toBe(true)
    expect(isAmountAmong(first('4 989 kr'), [4989.6])).toBe(true)
    expect(isAmountAmong(first('4 990 kr'), [4990])).toBe(true)
    expect(isAmountAmong(first('4 991 kr'), [4989.6])).toBe(false)
    expect(isAmountAmong(first('4 990 kr'), [4989.01])).toBe(false)
  })

  it('accepts either reading of an ambiguous amount', () => {
    expect(isAmountAmong(first('1,250 kr'), [1250])).toBe(true)
    expect(isAmountAmong(first('1,250 kr'), [1.25])).toBe(true)
    expect(isAmountAmong(first('1,250 kr'), [125])).toBe(false)
  })

  it('matches nothing against no amounts, and skips amounts that are not numbers', () => {
    expect(isAmountAmong(first('100 kr'), [])).toBe(false)
    expect(isAmountAmong(first('100 kr'), [Number.NaN, 100])).toBe(true)
  })
})

describe('amountsNotAmong', () => {
  it('lists the amounts that stand on no record, as written, each once', () => {
    const texts = ['Kortet drogs 10 242,28 kr och sedan 500 kr.', 'Tidigare 500 kr och 3 000 000 kr.', null]
    expect(amountsNotAmong(texts, [-10242.28, 3_000_000])).toEqual(['500 kr'])
    expect(amountsNotAmong(texts, [10242.28, 500, 3_000_000])).toEqual([])
  })

  it('is empty for a text without amounts', () => {
    expect(amountsNotAmong(['Finns det ett skriftligt avtal?', undefined], [])).toEqual([])
  })
})
