import { describe, expect, it } from 'vitest'
import { parseSIEFile } from '../sie-parser'
import { bucketOfAccount, buildTheaterModel } from '../theater-model'

function sie(lines: string[]): string {
  return [
    '#FLAGGA 0',
    '#SIETYP 4',
    '#FNAMN "Nordvik Bygg AB"',
    '#ORGNR 5566778899',
    '#RAR 0 20260101 20261231',
    '#RAR -1 20250101 20251231',
    '#KONTO 1930 "Företagskonto"',
    '#KONTO 3041 "Försäljning tjänster"',
    '#KONTO 4010 "Material"',
    '#KONTO 2641 "Ingående moms"',
    ...lines,
  ].join('\n')
}

function voucher(num: number, description: string, account = '4010', amount = 100): string[] {
  return [
    `#VER A ${num} 20260115 "${description}"`,
    '{',
    `#TRANS ${account} {} ${amount}.00`,
    `#TRANS 2641 {} ${(amount * 0.25).toFixed(2)}`,
    `#TRANS 1930 {} -${(amount * 1.25).toFixed(2)}`,
    '}',
  ]
}

describe('bucketOfAccount', () => {
  it('maps class digits to the four display buckets', () => {
    expect(bucketOfAccount('1930')).toBe('tillgangar')
    expect(bucketOfAccount('2641')).toBe('skulder')
    expect(bucketOfAccount('3041')).toBe('intakter')
    expect(bucketOfAccount('4010')).toBe('kostnader')
    expect(bucketOfAccount('7010')).toBe('kostnader')
    expect(bucketOfAccount('8310')).toBe('kostnader')
  })
})

describe('buildTheaterModel', () => {
  it('aggregates accounts by posting count and years oldest first', () => {
    const parsed = parseSIEFile(
      sie([...voucher(1, 'Byggmax'), ...voucher(2, 'Byggmax'), ...voucher(3, 'Ahlsell')])
    )
    const model = buildTheaterModel(parsed)
    expect(model.companyName).toBe('Nordvik Bygg AB')
    expect(model.years.map((y) => y.start)).toEqual(['2025-01-01', '2026-01-01'])
    expect(model.totalVouchers).toBe(3)
    // 4010, 2641, 1930 each appear 3 times; heaviest-first with names.
    const acc4010 = model.accounts.find((a) => a.number === '4010')
    expect(acc4010).toMatchObject({ name: 'Material', bucket: 'kostnader', weight: 3 })
    expect(model.buckets.map((b) => b.id)).toEqual(['tillgangar', 'skulder', 'kostnader'])
  })

  it('groups counterparties by normalized name and needs at least two sightings', () => {
    const parsed = parseSIEFile(
      sie([
        ...voucher(1, 'BYGGMAX AB'),
        ...voucher(2, 'Byggmax'),
        ...voucher(3, 'Engångsleverantören'),
      ])
    )
    const model = buildTheaterModel(parsed)
    expect(model.counterparties).toHaveLength(1)
    expect(model.counterparties[0]).toMatchObject({ name: 'Byggmax', weight: 2, account: '4010' })
    expect(model.totalCounterparties).toBe(1)
  })

  it('attaches the counterparty to the counter account, not the bank leg', () => {
    const parsed = parseSIEFile(
      sie([...voucher(1, 'Vasakronan', '5010', 18500), ...voucher(2, 'Vasakronan', '5010', 18500)])
    )
    const model = buildTheaterModel(parsed)
    expect(model.counterparties[0]).toMatchObject({ name: 'Vasakronan', account: '5010' })
  })

  it('skips internal accounting voucher texts', () => {
    const parsed = parseSIEFile(
      sie([
        ...voucher(1, 'Lön juli'),
        ...voucher(2, 'Lön augusti'),
        ...voucher(3, 'Momsredovisning Q2'),
        ...voucher(4, 'Avskrivning inventarier'),
        ...voucher(5, 'Årets resultat'),
      ])
    )
    expect(buildTheaterModel(parsed).counterparties).toHaveLength(0)
  })

  it('caps accounts and counterparties to readable sizes', () => {
    const accounts: string[] = []
    const vouchers: string[] = []
    for (let i = 0; i < 30; i++) {
      const num = String(5000 + i)
      accounts.push(`#KONTO ${num} "Konto ${num}"`)
      for (let j = 0; j < 3; j++) {
        vouchers.push(...voucher(i * 3 + j + 1, `Leverantör ${i} AB`, num))
      }
    }
    const model = buildTheaterModel(parseSIEFile(sie([...accounts, ...vouchers])))
    expect(model.accounts.length).toBeLessThanOrEqual(14)
    expect(model.counterparties.length).toBeLessThanOrEqual(12)
    expect(model.totalCounterparties).toBe(30)
  })
})
