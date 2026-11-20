import { describe, it, expect } from 'vitest'
import { describeFileColumns } from '../file-columns'

type Field = 'name_col' | 'email_col' | 'city_col'
const FIELDS: Field[] = ['name_col', 'email_col', 'city_col']

describe('describeFileColumns', () => {
  it('lists every file column in file order with the fields read from it', () => {
    const headers = ['Kundnr', 'Namn', 'Ort', 'E-post']
    const result = describeFileColumns<Field>(
      headers,
      [['1001', 'Acme AB', 'Lund', 'a@acme.se']],
      { name_col: 1, email_col: 3, city_col: 2 },
      FIELDS,
    )

    expect(result).toEqual([
      { index: 0, header: 'Kundnr', fields: [] },
      { index: 1, header: 'Namn', fields: ['name_col'] },
      { index: 2, header: 'Ort', fields: ['city_col'] },
      { index: 3, header: 'E-post', fields: ['email_col'] },
    ])
  })

  it('ignores keys outside the field list, such as the confidence score', () => {
    // A manually confirmed mapping carries confidence 1, which is also a
    // valid column index: it must not mark column 1 as imported.
    const columns = { name_col: 0, email_col: null, city_col: null, confidence: 1 }
    const result = describeFileColumns<Field>(['Namn', 'Referens'], [], columns, FIELDS)

    expect(result).toEqual([
      { index: 0, header: 'Namn', fields: ['name_col'] },
      { index: 1, header: 'Referens', fields: [] },
    ])
  })

  it('treats an undetected (-1) or out-of-range column as not mapped', () => {
    const result = describeFileColumns<Field>(
      ['Företag', 'Stad'],
      [],
      { name_col: -1, email_col: 7, city_col: 1 },
      FIELDS,
    )

    expect(result).toEqual([
      { index: 0, header: 'Företag', fields: [] },
      { index: 1, header: 'Stad', fields: ['city_col'] },
    ])
  })

  it('shows a column the user mapped to two fields once, with both fields', () => {
    const result = describeFileColumns<Field>(
      ['Namn', 'Kontakt'],
      [],
      { name_col: 0, email_col: 1, city_col: 1 },
      FIELDS,
    )

    expect(result[1]).toEqual({ index: 1, header: 'Kontakt', fields: ['email_col', 'city_col'] })
  })

  it('drops blank trailing columns but keeps a headerless column that holds data', () => {
    const result = describeFileColumns<Field>(
      ['Namn', '', '  ', ''],
      [
        ['Acme AB', '', 'kvar', ''],
        ['Beta AB', null, '', undefined],
      ],
      { name_col: 0, email_col: null, city_col: null },
      FIELDS,
    )

    expect(result).toEqual([
      { index: 0, header: 'Namn', fields: ['name_col'] },
      { index: 2, header: '', fields: [] },
    ])
  })

  it('reaches data columns past the header row and trims numeric headers', () => {
    const result = describeFileColumns<Field>(
      ['Namn', 2024],
      [['Acme AB', '10', 'extra']],
      { name_col: 0, email_col: null, city_col: null },
      FIELDS,
    )

    expect(result).toEqual([
      { index: 0, header: 'Namn', fields: ['name_col'] },
      { index: 1, header: '2024', fields: [] },
      { index: 2, header: '', fields: [] },
    ])
  })

  it('returns nothing for an empty file', () => {
    expect(
      describeFileColumns<Field>([], [], { name_col: 0, email_col: null, city_col: null }, FIELDS),
    ).toEqual([])
  })
})
