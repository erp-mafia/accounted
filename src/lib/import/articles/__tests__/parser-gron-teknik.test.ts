import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseArticlesFile } from '../parser'

function buildXlsx(rows: (string | number)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Artiklar')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('parseArticlesFile: grön teknik installation types', () => {
  it('keeps an installation type on goods (grön teknik covers material) and still drops ROT/RUT on goods', () => {
    const buffer = buildXlsx([
      ['Benämning', 'Pris', 'Typ', 'Husarbete'],
      ['Solpanel 430 W', '2400', 'vara', 'installation_solceller'],
      ['Laddbox', '9000', 'vara', 'INSTALLATION_LADDPUNKT'],
      ['Montage batteri', '750', 'tjänst', 'INSTALLATION_LAGRING'],
      ['Kakel', '400', 'vara', 'BYGG'],
    ])

    const result = parseArticlesFile(buffer, 'artiklar.xlsx')

    expect(result.rows.map((r) => [r.name, r.type, r.housework_type])).toEqual([
      ['Solpanel 430 W', 'vara', 'INSTALLATION_SOLCELLER'],
      ['Laddbox', 'vara', 'INSTALLATION_LADDPUNKT'],
      ['Montage batteri', 'tjanst', 'INSTALLATION_LAGRING'],
      ['Kakel', 'vara', null],
    ])
    expect(result.notices).toContainEqual({
      code: 'articles_housework_on_goods_dropped',
      severity: 'notice',
      params: { count: 1 },
    })
  })
})
