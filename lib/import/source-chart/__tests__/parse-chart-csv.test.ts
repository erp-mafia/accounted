import { describe, it, expect } from 'vitest'
import { parseSourceChartCsv } from '../parse-chart-csv'

/** A Spiris export as it arrives: BOM, semicolons, CRLF. */
function spirisCsv(...rows: string[]): string {
  const header = 'IsActive;AccountNumber;AccountName;VatCodeAndPercent'
  return '﻿' + [header, ...rows].join('\r\n') + '\r\n'
}

describe('parseSourceChartCsv', () => {
  it('reads the shape a Spiris export actually has', () => {
    const { accounts, notices } = parseSourceChartCsv(
      spirisCsv('True;3051;Försäljn varor 25% sv;05-25%', 'False;3056;Försäljn varor till EG;'),
    )
    expect(notices).toEqual([])
    expect(accounts).toEqual([
      { accountNumber: '3051', accountName: 'Försäljn varor 25% sv', vatCode: '05-25%', isActive: true },
      { accountNumber: '3056', accountName: 'Försäljn varor till EG', vatCode: null, isActive: false },
    ])
  })

  it('strips the BOM so the first column name still matches', () => {
    // Without the strip the first header reads "﻿IsActive", IsActive is
    // never found, and every account comes back active.
    const { accounts } = parseSourceChartCsv(spirisCsv('False;3051;Test;'))
    expect(accounts[0].isActive).toBe(false)
  })

  it('finds columns by name, not by position', () => {
    const csv = '﻿AccountName;VatCodeAndPercent;AccountNumber;IsActive\r\n'
      + 'Försäljning;35-0%;3058;True\r\n'
    expect(parseSourceChartCsv(csv).accounts).toEqual([
      { accountNumber: '3058', accountName: 'Försäljning', vatCode: '35-0%', isActive: true },
    ])
  })

  it('keeps a semicolon that is inside a quoted account name', () => {
    const { accounts } = parseSourceChartCsv(spirisCsv('True;3051;"Varor; tjänster";05-25%'))
    expect(accounts[0].accountName).toBe('Varor; tjänster')
    expect(accounts[0].vatCode).toBe('05-25%')
  })

  it('unescapes a doubled quote', () => {
    const { accounts } = parseSourceChartCsv(spirisCsv('True;3051;"Kallas ""sv""";05-25%'))
    expect(accounts[0].accountName).toBe('Kallas "sv"')
  })

  it('accepts LF-only line endings', () => {
    const csv = 'IsActive;AccountNumber;AccountName;VatCodeAndPercent\nTrue;3051;Test;05-25%\n'
    expect(parseSourceChartCsv(csv).accounts).toHaveLength(1)
  })

  it('names what it can read when the header matches no format', () => {
    // A file that lands here is far more likely to be a correct chart from a
    // system this does not read yet than a broken one, so the warning lists
    // what is supported instead of blaming the file.
    const { accounts, format, notices } = parseSourceChartCsv(
      'Konto;Benämning;Momskod\r\n3001;Försäljning;MP1\r\n',
    )
    expect(accounts).toEqual([])
    expect(format).toBeNull()
    // Names what CAN be read rather than what the file lacks; the labels ride
    // in as a param so the sentence stays one i18n key.
    expect(notices[0]).toEqual({
      code: 'source_chart_unrecognised',
      severity: 'action',
      params: { formats: 'Spiris Bokföring' },
    })
  })

  it('detects the format and names it back', () => {
    // Detection that guesses wrong in silence is worse than asking, so what it
    // read the file as has to be visible.
    const { format } = parseSourceChartCsv(spirisCsv('True;3051;Test;05-25%'))
    expect(format?.id).toBe('spiris')
    expect(format?.label).toBe('Spiris Bokföring')
  })

  it('still returns the chart when the VAT column is missing, and says why it is empty', () => {
    const csv = 'IsActive;AccountNumber;AccountName\r\nTrue;3051;Test\r\n'
    const { accounts, notices } = parseSourceChartCsv(csv)
    expect(accounts).toEqual([
      { accountNumber: '3051', accountName: 'Test', vatCode: null, isActive: true },
    ])
    expect(notices[0]).toEqual({
      code: 'source_chart_no_vat_column',
      severity: 'action',
      params: { format: 'Spiris Bokföring' },
    })
  })

  it('treats a missing IsActive column as all active, never all inactive', () => {
    // Hiding the whole chart is the worse failure of the two.
    const csv = 'AccountNumber;AccountName;VatCodeAndPercent\r\n3051;Test;05-25%\r\n'
    expect(parseSourceChartCsv(csv).accounts[0].isActive).toBe(true)
  })

  it('counts the rows it skipped rather than failing the file', () => {
    const { accounts, notices } = parseSourceChartCsv(
      spirisCsv('True;3051;Bra;05-25%', 'True;;Utan nummer;', 'True;ABC;Bokstäver;'),
    )
    expect(accounts).toHaveLength(1)
    // 'notice', not 'action': a skipped row folds away behind the toggle
    // instead of taking the one ochre sentence the step allows.
    expect(notices[0]).toEqual({
      code: 'source_chart_rows_skipped',
      severity: 'notice',
      params: { count: 2 },
    })
  })

  it('keeps the first of a duplicated account number', () => {
    const { accounts } = parseSourceChartCsv(
      spirisCsv('True;3051;Först;05-25%', 'False;3051;Sedan;42-0%'),
    )
    expect(accounts).toEqual([
      { accountNumber: '3051', accountName: 'Först', vatCode: '05-25%', isActive: true },
    ])
  })

  it('reports an empty file instead of throwing', () => {
    const empty = { code: 'source_chart_empty_file', severity: 'action' }
    expect(parseSourceChartCsv('')).toEqual({ accounts: [], format: null, notices: [empty] })
    expect(parseSourceChartCsv('﻿\r\n').notices[0]).toEqual(empty)
  })

  it('ignores blank lines between rows', () => {
    const csv = spirisCsv('True;3051;Test;05-25%', '', 'True;3052;Test 2;05-12%')
    expect(parseSourceChartCsv(csv).accounts).toHaveLength(2)
  })
})
