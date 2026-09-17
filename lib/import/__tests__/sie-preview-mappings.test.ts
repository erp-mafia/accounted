import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import { suggestMappings } from '../account-mapper'
import { prepareSIEPreviewMappings } from '../sie-preview-mappings'
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

  it('clears invalid stored targets but preserves a valid explicit remapping', () => {
    const parsed = parseSIEFile(ledger)
    const mappings = suggestMappings(parsed.accounts, BAS_REFERENCE)
    expect(prepareSIEPreviewMappings(parsed, [{ ...mappings[0], targetAccount: '193000' }]).mappings[0].targetAccount).toBe('')
    expect(prepareSIEPreviewMappings(parsed, [{ ...mappings[0], targetAccount: '9999' }]).mappings[0].targetAccount).toBe('')
    expect(prepareSIEPreviewMappings(parsed, [{ ...mappings[0], targetAccount: '1940' }]).mappings[0].targetAccount).toBe('1940')
  })
})
