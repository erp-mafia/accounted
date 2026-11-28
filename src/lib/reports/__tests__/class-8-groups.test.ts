import { describe, it, expect } from 'vitest'
import { CLASS_8_GROUPS, class8GroupOf, splitClass8 } from '../class-8-groups'

describe('class8GroupOf', () => {
  it('puts 80-84 in Finansiella poster, 88 in Bokslutsdispositioner and 89 in Skatter', () => {
    expect(['8010', '8113', '8250', '8314', '8423'].map((a) => class8GroupOf(a).key)).toEqual([
      'finansiella_poster',
      'finansiella_poster',
      'finansiella_poster',
      'finansiella_poster',
      'finansiella_poster',
    ])
    expect(class8GroupOf('8811').key).toBe('bokslutsdispositioner')
    expect(class8GroupOf('8850').key).toBe('bokslutsdispositioner')
    expect(class8GroupOf('8910').key).toBe('skatter')
    expect(class8GroupOf('8980').key).toBe('skatter')
    // Årets resultat sits in kontogrupp 89 but is no tax: a block of its own.
    expect(class8GroupOf('8990').key).toBe('arets_resultat')
    expect(class8GroupOf('8999').key).toBe('arets_resultat')
  })

  it('keeps a kontogrupp BAS leaves unused in a block of its own above the line', () => {
    const group = class8GroupOf('8510')
    expect(group.key).toBe('ovriga_finansiella_poster')
    expect(group.aboveResultAfterFinancial).toBe(true)
  })

  it('puts every block above Resultat efter finansiella poster before every block below it', () => {
    const above = CLASS_8_GROUPS.map((g) => g.aboveResultAfterFinancial)
    expect(above).toEqual([true, true, false, false, false])
    expect(CLASS_8_GROUPS.map((g) => g.heading)).toEqual([
      'Finansiella poster',
      'Övriga finansiella poster',
      'Bokslutsdispositioner',
      'Skatter',
      'Årets resultat',
    ])
  })
})

describe('splitClass8', () => {
  it('returns the blocks in order with each item in its account\'s block, empty blocks left out', () => {
    const rows = ['8910', '8423', '8811', '8314'].map((account_number) => ({ account_number }))

    const blocks = splitClass8(rows, (row) => row.account_number)

    expect(blocks.map((b) => [b.group.key, b.items.map((r) => r.account_number)])).toEqual([
      ['finansiella_poster', ['8423', '8314']],
      ['bokslutsdispositioner', ['8811']],
      ['skatter', ['8910']],
    ])
  })

  it('returns nothing for no items', () => {
    expect(splitClass8([], (row: { account_number: string }) => row.account_number)).toEqual([])
  })
})
