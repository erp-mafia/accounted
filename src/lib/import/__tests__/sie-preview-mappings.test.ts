import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import { suggestMappings } from '../account-mapper'
import { onlyUsedSIEMappings, prepareSIEPreviewMappings, remappedSIEAccounts, remappedSIEAccountsText, sieUsedAccounts } from '../sie-preview-mappings'
import { parseSIEFile } from '../sie-parser'
import { SIEJobValidationError, validateSIEJobInput } from '../sie-jobs'
import { buildSIEAccountRows } from '../account-sync'

const ledger = '#SIETYP 4\n#RAR 0 20260101 20261231\n#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n' +
  '#VER A 1 20260201 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'
const preview = (source: string) => {
  const parsed = parseSIEFile(source)
  return prepareSIEPreviewMappings(parsed, suggestMappings(parsed.accounts, BAS_REFERENCE))
}

describe('SIE preview account boundaries', () => {
  it('retains unused non-four-digit definitions in the source without manufacturing invalid targets', () => {
    const source = '#KONTO 999 "Unused"\n#KONTO 193000 "Unused subaccount"\n' + ledger
    const result = preview(source)
    expect(result.archivedOnlyAccounts.map(a => a.number)).toEqual(['999', '193000'])
    expect(result.mappings.map(m => m.sourceAccount)).toEqual(['1930', '3001'])
    const mappings = SIEJobMappingsSchema.parse(result.mappings)
    expect(() => validateSIEJobInput(source, parseSIEFile(source), mappings,
      { filename: 'test.se', createFiscalPeriod: true, importTransactions: true, importOpeningBalances: true })).not.toThrow()
    expect(buildSIEAccountRows('company', 'user', mappings).map(a => a.account_number)).toEqual(['1930', '3001'])
  })

  it('routes a used class 9 observation account to 2999 OBS-konto and keeps an unused one as a definition', () => {
    // Desk crm#63: Fortnox 9999 with amounts. The onboarding books flow has no
    // mapping page, so an empty target there became a self-created 9999 and
    // the job refused it with the generic class message.
    const source = ledger.replaceAll('1930', '9999')
    const result = preview(source)
    const mapping = result.mappings.find(m => m.sourceAccount === '9999')!
    expect(mapping).toMatchObject({ targetAccount: '2999', targetName: 'OBS-konto', matchType: 'class', confidence: 0.5, isOverride: false })
    expect(() => validateSIEJobInput(source, parseSIEFile(source), SIEJobMappingsSchema.parse(result.mappings),
      { filename: 'test.se', createFiscalPeriod: true, importTransactions: true, importOpeningBalances: true })).not.toThrow()

    const unused = preview('#KONTO 9999 "OBS"\n' + ledger)
    expect(unused.mappings.find(m => m.sourceAccount === '9999')).toMatchObject({ targetAccount: '9999' })
  })

  it('names the accounts behind SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS in the error details', () => {
    const source = ledger.replaceAll('1930', '9999')
    const mapped = preview(source).mappings.map(m => m.sourceAccount === '9999' ? { ...m, targetAccount: '9998', targetName: 'Internt' } : m)
    let thrown: unknown
    try {
      validateSIEJobInput(source, parseSIEFile(source), SIEJobMappingsSchema.parse(mapped),
        { filename: 'test.se', createFiscalPeriod: true, importTransactions: true, importOpeningBalances: true })
    } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(SIEJobValidationError)
    expect(thrown as SIEJobValidationError).toMatchObject({ code: 'SIE_IMPORT_UNSUPPORTED_ACCOUNT_CLASS', details: { account_numbers: ['9998'] } })
  })

  it.each(['999', '19300', '193000', '0099'])('requires a deliberate mapping for used source %s', number => {
    const source = ledger.replaceAll('1930', number)
    const result = preview(source)
    expect(result.archivedOnlyAccounts).toEqual([])
    expect(result.excludedSystemAccounts).toEqual([])
    const mapping = result.mappings.find(m => m.sourceAccount === number)!
    expect(mapping.targetAccount).toBe('')
    const mapped = result.mappings.map(m => m === mapping ? { ...m, targetAccount: '1930' } : m)
    expect(() => validateSIEJobInput(source, parseSIEFile(source), SIEJobMappingsSchema.parse(mapped),
      { filename: 'test.se', createFiscalPeriod: true, importTransactions: true, importOpeningBalances: true })).not.toThrow()
  })

  it.each(['#IB 0', '#UB -1', '#UB 0', '#RES 0'])('does not classify a balance account as unused: %s', tag => {
    const result = preview('#KONTO 193000 "Balance"\n' + ledger + `\n${tag} 193000 100`)
    expect(result.archivedOnlyAccounts).toEqual([])
    expect(result.mappings.find(m => m.sourceAccount === '193000')?.targetAccount).toBe('')
  })

  it('does not net offsetting activity away or drop malformed amount evidence', () => {
    for (const records of [
      '#VER A 2 20260202 "Offset"\n{\n#TRANS 999 {} 100\n#TRANS 999 {} -100\n}',
      '#IB 0 999 invalid',
      '#VER A 2 20260202 "Corrected"\n{\n#BTRANS 999 {} 100\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}',
    ]) {
      expect(preview('#KONTO 999 "Source"\n' + ledger + '\n' + records).archivedOnlyAccounts).toEqual([])
    }
  })

  it('preserves unused four-digit custom definitions and excludes only unused system accounts', () => {
    const result = preview('#KONTO 9999 "Unused custom"\n#KONTO 0099 "Unused internal"\n' + ledger)
    expect(result.mappings.find(m => m.sourceAccount === '9999')?.targetAccount).toBe('9999')
    expect(result.excludedSystemAccounts.map(a => a.number)).toEqual(['0099'])
    expect(result.archivedOnlyAccounts).toEqual([])
  })

  it('keeps a custom definition with only zero balances without forcing a remap', () => {
    const result = preview('#KONTO 9999 "Zero balance"\n' + ledger + '\n#IB 0 9999 0\n#UB 0 9999 0')
    expect(result.mappings.find(m => m.sourceAccount === '9999')?.targetAccount).toBe('9999')
  })

  it('records the reverse-charge basis pair the file books beside a cost account (crm#1096)', () => {
    const source = '#SIETYP 4\n#RAR 0 20260101 20261231\n#KONTO 1930 "Bank"\n#KONTO 5420 "Programvaror"\n' +
      '#KONTO 4535 "Inköp tjänster EU"\n#KONTO 4599 "Justering omvänd moms"\n' +
      '#VER A 1 20260129 "Inköp"\n{\n#TRANS 1930 {} -100\n#TRANS 5420 {} 100\n#TRANS 4535 {} 100\n#TRANS 4599 {} -100\n}'
    const { mappings } = preview(source)
    expect(mappings.filter(m => m.rcBasisPair).map(m => [m.sourceAccount, m.rcBasisPair]))
      .toEqual([['5420', {
        pairs: [{ legs: ['4535'], offsets: ['4599'], vouchers: 1, lastAt: new Date(2026, 0, 29).getTime() }],
      }]])
    // Preview evidence for the VAT prefill: the job's mappings do not carry it.
    expect(SIEJobMappingsSchema.parse(mappings).some(m => 'rcBasisPair' in m)).toBe(false)
  })

  it('clears invalid stored targets but preserves a valid explicit remapping', () => {
    const parsed = parseSIEFile(ledger)
    const mappings = suggestMappings(parsed.accounts, BAS_REFERENCE)
    expect(prepareSIEPreviewMappings(parsed, [{ ...mappings[0], targetAccount: '193000' }]).mappings[0].targetAccount).toBe('')
    expect(prepareSIEPreviewMappings(parsed, [{ ...mappings[0], targetAccount: '9999' }]).mappings[0].targetAccount).toBe('')
    expect(prepareSIEPreviewMappings(parsed, [{ ...mappings[0], targetAccount: '1940' }]).mappings[0].targetAccount).toBe('1940')
  })
})

describe('only the accounts the file uses (#63)', () => {
  // A provider export carries its whole chart in #KONTO: 2440 and 6110 are
  // defined but nothing in the file touches them.
  const chart = '#KONTO 2440 "Leverantörsskulder"\n#KONTO 6110 "Kontorsmateriel"\n'
  const unusedOf = (source: string) => preview(source).unusedAccounts.map(a => a.number)

  it('names unused BAS definitions and keeps every used account', () => {
    const result = preview(chart + ledger)
    expect(result.unusedAccounts).toEqual([
      { number: '2440', name: 'Leverantörsskulder' },
      { number: '6110', name: 'Kontorsmateriel' },
    ])
    expect(result.unusedOwnAccounts).toEqual([])
    // The default keeps the file's chart (#2605): the unused rows stay mapped.
    expect(result.mappings.map(m => m.sourceAccount)).toEqual(['2440', '6110', '1930', '3001'])
    expect(onlyUsedSIEMappings(parseSIEFile(chart + ledger), result.mappings).map(m => m.sourceAccount))
      .toEqual(['1930', '3001'])
  })

  it('counts a voucher line of any amount, struck and added rättelse lines included', () => {
    expect(unusedOf(chart + ledger + '\n#VER A 2 20260202 "Noll"\n{\n#TRANS 6110 {} 0\n#TRANS 1930 {} 0\n}'))
      .toEqual(['2440'])
    expect(unusedOf(chart + ledger +
      '\n#VER A 2 20260202 "Rättad"\n{\n#BTRANS 6110 {} 100\n#RTRANS 2440 {} 100\n#TRANS 2440 {} 100\n#TRANS 3001 {} -100\n}'))
      .toEqual([])
  })

  it.each(['#IB 0', '#IB -1', '#UB 0', '#UB -1', '#RES 0', '#RES -1'])('counts a non-zero %s row', tag => {
    expect(unusedOf(chart + ledger + `\n${tag} 2440 -100`)).toEqual(['6110'])
  })

  it('counts object balances with an amount', () => {
    expect(unusedOf(chart + '#DIM 6 "Projekt"\n#OBJEKT 6 "P1" "Projekt 1"\n' + ledger + '\n#OIB 0 2440 {6 "P1"} -100'))
      .toEqual(['6110'])
  })

  it('leaves out a BAS definition whose only balances are zero', () => {
    expect(unusedOf(chart + ledger + '\n#IB 0 2440 0\n#UB 0 2440 0.00\n#RES 0 6110 0')).toEqual(['2440', '6110'])
    // A number outside BAS is the company's own: kept, and as before a zero
    // row on a number no chart can hold still needs a hand-made target.
    const zeroOnly = preview('#KONTO 193000 "Underkonto"\n' + ledger + '\n#IB 0 193000 0')
    expect(zeroOnly.mappings.find(m => m.sourceAccount === '193000')?.targetAccount).toBe('')
    expect(zeroOnly.unusedAccounts).toEqual([])
    expect(zeroOnly.unusedOwnAccounts.map(a => a.number)).toEqual(['193000'])
  })

  it('keeps the company\'s own unused accounts: only unused BAS accounts can be added back from the catalog', () => {
    const source = chart + '#KONTO 1932 "Sparkonto"\n#KONTO 6111 "Egen kostnad"\n' + ledger
    const result = preview(source)
    expect(result.unusedAccounts.map(a => a.number)).toEqual(['2440', '6110'])
    expect(result.unusedOwnAccounts).toEqual([
      { number: '1932', name: 'Sparkonto' },
      { number: '6111', name: 'Egen kostnad' },
    ])
    expect(onlyUsedSIEMappings(parseSIEFile(source), result.mappings).map(m => m.sourceAccount))
      .toEqual(['1932', '6111', '1930', '3001'])
  })

  it('keeps an account a parse issue names: its amount could not be read', () => {
    expect(unusedOf(chart + ledger + '\n#IB 0 2440 invalid')).toEqual(['6110'])
    expect(sieUsedAccounts(parseSIEFile(chart + ledger + '\n#IB 0 2440 invalid')).has('2440')).toBe(true)
  })

  it('never lists system or archive-only definitions: they are not created either way', () => {
    const result = preview('#KONTO 0099 "Internt"\n#KONTO 999 "Kort"\n' + chart + ledger)
    expect(result.excludedSystemAccounts.map(a => a.number)).toEqual(['0099'])
    expect(result.archivedOnlyAccounts.map(a => a.number)).toEqual(['999'])
    expect(result.unusedAccounts.map(a => a.number)).toEqual(['2440', '6110'])
  })

  it('creates the used accounts and the own ones, and still passes the job input check', () => {
    const source = chart + '#KONTO 9999 "Oanvänt OBS"\n' + ledger + '\n#IB 0 1930 500\n#IB 0 2440 -500'
    const parsed = parseSIEFile(source)
    const kept = SIEJobMappingsSchema.parse(onlyUsedSIEMappings(parsed, preview(source).mappings))
    // 6110 is unused BAS: left out. 9999 is unused but the company's own: kept, as #2605.
    expect(kept.map(m => m.sourceAccount).sort()).toEqual(['1930', '2440', '3001', '9999'])
    expect(() => validateSIEJobInput(source, parsed, kept,
      { filename: 'test.se', createFiscalPeriod: true, importTransactions: true, importOpeningBalances: true })).not.toThrow()
    expect(buildSIEAccountRows('company', 'user', kept).map(a => a.account_number).sort()).toEqual(['1930', '2440', '3001', '9999'])
  })
})

// crm#1684: a #TRANS row the import books on another account than the file's
// is a choice somebody made (a remembered mapping, a hand pick, an agent's
// mappings). The unattended doors name it before the import runs.
describe('accounts booked on another number than the file\'s (crm#1684)', () => {
  const file = '#SIETYP 4\n#RAR 0 20260101 20261231\n#KONTO 1930 "Bank"\n#KONTO 2640 "Ingående moms"\n' +
    '#KONTO 3041 "Sales 25"\n#KONTO 3047 "Sales other"\n#KONTO 3049 "Unused"\n' +
    '#VER B 1 20260216 "Invoice"\n{\n#TRANS 1930 {} 125\n#TRANS 2640 {} 0\n#TRANS 3047 {} -125\n}'
  const mapping = (sourceAccount: string, targetAccount: string) => ({ sourceAccount, targetAccount })

  it('lists a used source account mapped to another number', () => {
    const parsed = parseSIEFile(file)
    expect(remappedSIEAccounts(parsed, [mapping('1930', '1930'), mapping('3047', '3041')]))
      .toEqual([{ source: '3047', target: '3041' }])
  })

  it('lists nothing when every account keeps its own number: the mapper\'s default', () => {
    const parsed = parseSIEFile(file)
    const suggested = prepareSIEPreviewMappings(parsed, suggestMappings(parsed.accounts, BAS_REFERENCE)).mappings
    expect(suggested.find(m => m.sourceAccount === '3047')).toMatchObject({ targetAccount: '3047' })
    expect(remappedSIEAccounts(parsed, suggested)).toEqual([])
  })

  it('applies a remembered mapping as before, and names it', () => {
    const parsed = parseSIEFile(file)
    const stored = [{ source_account: '3047', source_name: 'Sales other', target_account: '3041', confidence: 1, match_type: 'manual' as const }]
    const suggested = prepareSIEPreviewMappings(parsed, suggestMappings(parsed.accounts, BAS_REFERENCE, stored as never)).mappings
    expect(suggested.find(m => m.sourceAccount === '3047')).toMatchObject({ targetAccount: '3041', isOverride: true })
    expect(remappedSIEAccounts(parsed, suggested)).toEqual([{ source: '3047', target: '3041' }])
  })

  it('skips unused definitions, unmapped rows and the 2640 group-header redirect', () => {
    const parsed = parseSIEFile(file)
    expect(remappedSIEAccounts(parsed, [
      mapping('3049', '3041'), // no row in the file uses it
      mapping('1930', ''), // unmapped: the job refuses or skips, not a remap
      mapping('2640', '2641'), // BAS group header, not a posting account
    ])).toEqual([])
  })

  it('names every pair in Swedish and folds a long list', () => {
    const remapped = Array.from({ length: 3 }, (_, i) => ({ source: `304${i}`, target: '3041' }))
    expect(remappedSIEAccountsText(remapped)).toContain('3 av filens konton bokförs på ett annat kontonummer än i filen (3040 → 3041, 3041 → 3041, 3042 → 3041)')
    expect(remappedSIEAccountsText(remapped, 2)).toContain('(3040 → 3041, 3041 → 3041 samt ytterligare 1)')
  })
})
