import { describe, expect, it } from 'vitest'
import { userFacingCode } from '@/lib/errors/user-facing'
import { roundOre } from '@/lib/money'
import { parseSIEFile } from '../sie-parser'
import { buildSIEMigrationAdjustmentEntry, buildSIEOpeningBalanceEntry, prepareSIEVouchers, validateIBBalance } from '../sie-import'
import { mappingsToMap } from '../account-mapper'
import { SIEJobValidationError, validateSIEJobInput } from '../sie-jobs'
import { findSIEAmountsWithoutTarget, sieAccountsCarryingAmounts, sieAccountsOfferedForMapping } from '../sie-amounts-without-target'
import type { AccountMapping, ParsedSIEFile } from '../types'
import { BAS_ACCOUNTS, FORTNOX_YEAR } from './fixtures/fortnox-source-system-accounts'

const options = { filename: 'migration-sie-2026-01-01.se', createFiscalPeriod: true, importOpeningBalances: true, importTransactions: true }
const map = (source: string, target = source): AccountMapping => ({
  sourceAccount: source, targetAccount: target, sourceName: 'Konto', targetName: 'Konto', confidence: 1, matchType: 'exact', isOverride: false,
})
const refusal = (content: string, mappings: AccountMapping[], submitted = options): SIEJobValidationError => {
  try {
    validateSIEJobInput(content, parseSIEFile(content), mappings, submitted)
  } catch (error) {
    if (error instanceof SIEJobValidationError) return error
    throw error
  }
  throw new Error('the import was admitted')
}

/**
 * The ledger an import leaves behind, per account, built by the functions the
 * job itself runs: the IB verifikat (validateIBBalance,
 * buildSIEOpeningBalanceEntry) and every prepared voucher (prepareSIEVouchers).
 */
function ledgerAfterImport(parsed: ParsedSIEFile, mappings: AccountMapping[]) {
  const accountMap = mappingsToMap(mappings)
  const balances = new Map<string, number>()
  const post = (account: string, amount: number) => balances.set(account, roundOre((balances.get(account) ?? 0) + amount))
  const opening = buildSIEOpeningBalanceEntry('period-1', parsed, accountMap, validateIBBalance(parsed, accountMap).roundingAdjustment, 'IB', '2099')
  for (const line of opening?.lines ?? []) post(line.account_number, line.debit_amount - line.credit_amount)
  const prepared = prepareSIEVouchers(parsed, accountMap, 'B', 'import-1', { startOrdinal: 0, accountIds: new Map() })
  const movements = new Map<string, number>()
  for (const entry of prepared.preparedEntries) {
    for (const line of entry.lines) {
      post(line.account_number, line.debit_amount - line.credit_amount)
      movements.set(line.account_number, roundOre((movements.get(line.account_number) ?? 0) + line.debit_amount - line.credit_amount))
    }
  }
  return { balances, movements, prepared, accountMap }
}

/** What the file itself reports for the year: #UB per balance account, #RES per result account, by target. */
function fileBalances(parsed: ParsedSIEFile, accountMap: Map<string, string>) {
  const reported = new Map<string, number>()
  for (const row of [...parsed.closingBalances, ...parsed.resultBalances]) {
    if (row.yearIndex !== 0) continue
    const target = accountMap.get(row.account)
    if (!target) throw new Error(`the file reports ${row.account}, which has no target`)
    reported.set(target, roundOre((reported.get(target) ?? 0) + row.amount))
  }
  return reported
}

const nonZero = (balances: Map<string, number>) =>
  [...balances].filter(([, amount]) => amount !== 0).sort(([a], [b]) => a.localeCompare(b))

describe('an SIE import leaves no amount out for a missing target account', () => {
  const parsed = parseSIEFile(FORTNOX_YEAR)

  it('reads the fixture without a parse error', () => {
    expect(parsed.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(parsed.vouchers).toHaveLength(9)
  })

  it('counts an account as carrying amounts only on vouchers that move a balance', () => {
    const carrying = sieAccountsCarryingAmounts(parsed, { importTransactions: true, importOpeningBalances: true })
    // Fortnox 0099: the same amount in debit and credit, or zero rows.
    expect(carrying.has('0099')).toBe(false)
    expect(carrying.get('0999')).toEqual({ vouchers: 2, firstVoucher: 'E12', openingBalance: 0 })
    expect(carrying.get('1930')).toEqual({ vouchers: 5, firstVoucher: 'A2', openingBalance: 100000 })
    expect(carrying.get('2081')).toEqual({ vouchers: 0, firstVoucher: null, openingBalance: -50000 })
  })

  it('counts a voucher that moves an amount between two projects on one account', () => {
    const retag = parseSIEFile('#FLAGGA 0\n#SIETYP 4\n#RAR 0 20260101 20261231\n#VER A 1 20260110 "Omföring projekt"\n{\n' +
      '#TRANS 5010 {6 "A"} -100.00\n#TRANS 5010 {6 "B"} 100.00\n#TRANS 0099 {} 0.00\n}')
    const carrying = sieAccountsCarryingAmounts(retag, { importTransactions: true, importOpeningBalances: true })
    // No account balance changes, each project's does: 0099 on it needs a target or the voucher is lost.
    expect([...carrying.keys()].sort()).toEqual(['0099', '5010'])
  })

  it('offers a source-system account for mapping only when it carries amounts', () => {
    expect(sieAccountsOfferedForMapping(parsed.accounts, [parsed]).map((account) => account.number).filter((n) => n.startsWith('0')))
      .toEqual(['0999'])
  })

  // 2026-10-22, provider migration: 0xxx accounts never reached the mapping
  // page, 65 supplier payments were skipped and the import read completed.
  it('refuses the year while the company\'s own 0999 has no target, naming it and its vouchers', () => {
    const error = refusal(FORTNOX_YEAR, BAS_ACCOUNTS.map((account) => map(account)))
    expect(error.code).toBe('SIE_IMPORT_UNMAPPED_ACCOUNTS')
    expect(userFacingCode(error)).toBe('SIE_IMPORT_UNMAPPED_ACCOUNTS')
    expect(error.message).toBe(
      'Ett konto med belopp i SIE-filen saknar målkonto: 0999 Inköp gården (2 verifikationer, till exempel E12). ' +
      'Utan målkonto kan beloppen varken bokföras eller stämmas av mot bokföringen. ' +
      'Välj målkonto för kontot i kontomappningen och starta importen igen.',
    )
    expect(error.details).toEqual({
      accounts_without_target: [{ account: '0999', name: 'Inköp gården', vouchers: 2, first_voucher: 'E12', opening_balance: 0 }],
      accounts_without_target_count: 1,
    })
  })

  it('refuses a blank target the same way as a missing mapping row', () => {
    const error = refusal(FORTNOX_YEAR, [...BAS_ACCOUNTS.map((account) => map(account)), map('0999', '')])
    expect(error.code).toBe('SIE_IMPORT_UNMAPPED_ACCOUNTS')
    expect(error.message).toContain('0999 Inköp gården')
  })

  // 2026-11-11, MCP: 14 of the 47 mappings the file needed; 410 of 411
  // vouchers were skipped and the import read completed.
  it('refuses a mapping list that covers only some of the accounts with amounts', () => {
    const error = refusal(FORTNOX_YEAR, ['1510', '2081', '2099', '3001'].map((account) => map(account)).concat(map('0999', '4010')))
    expect(error.code).toBe('SIE_IMPORT_UNMAPPED_ACCOUNTS')
    expect((error.details?.accounts_without_target as Array<{ account: string }>).map((row) => row.account))
      .toEqual(['1930', '2611', '2641', '5010', '6570'])
    expect(error.message).toContain('5 konton med belopp i SIE-filen saknar målkonto: ' +
      '1930 Företagskonto (5 verifikationer, till exempel A2; ingående balans 100 000,00 kr)')
    expect(error.message).toContain('Välj målkonto för kontona i kontomappningen')
  })

  it('names eight accounts and counts the rest', () => {
    const rows = findSIEAmountsWithoutTarget(parsed, new Set(), options)
    expect(rows).toHaveLength(10)
    const error = refusal(FORTNOX_YEAR, [map('0099', '2999')])
    expect(error.message).toContain('10 konton med belopp i SIE-filen saknar målkonto')
    expect(error.message).toContain('och 2 konton till.')
  })

  it('asks for no target for an opening balance the import was told to leave out', () => {
    const transactionsOnly = { ...options, importOpeningBalances: false }
    // 2081 and 2099 only carry an opening balance.
    const mappings = BAS_ACCOUNTS.filter((account) => !['2081', '2099'].includes(account)).map((account) => map(account)).concat(map('0999', '4010'))
    expect(() => validateSIEJobInput(FORTNOX_YEAR, parseSIEFile(FORTNOX_YEAR), mappings, transactionsOnly)).not.toThrow()
    const withOpening = refusal(FORTNOX_YEAR, mappings)
    expect(withOpening.message).toContain('2 konton med belopp i SIE-filen saknar målkonto: ' +
      '2081 Aktiekapital (ingående balans \u221250 000,00 kr), 2099 Årets resultat (ingående balans \u221262 500,00 kr)')
  })

  describe('once 0999 has a target, the books equal the file', () => {
    const mappings = [...BAS_ACCOUNTS.map((account) => map(account)), map('0999', '4010')]

    it('admits the year with Fortnox 0099 left without a target', () => {
      expect(() => validateSIEJobInput(FORTNOX_YEAR, parseSIEFile(FORTNOX_YEAR), mappings, options)).not.toThrow()
    })

    it('skips only vouchers that move no balance', () => {
      const { prepared } = ledgerAfterImport(parsed, mappings)
      expect(prepared.skippedDetails.map((skipped) => [skipped.voucherId, skipped.reason])).toEqual([
        ['X1', 'unmapped'], ['A3', 'unmapped'], ['A6', 'zero_lines'],
      ])
      expect(prepared.preparedEntries.map((entry) => entry.sourceId)).toEqual(['A1', 'A2', 'E12', 'A4', 'E13', 'A5'])
    })

    it('leaves every account on the balance the file reports in #UB and #RES', () => {
      const { balances, accountMap } = ledgerAfterImport(parsed, mappings)
      expect(nonZero(balances)).toEqual(nonZero(fileBalances(parsed, accountMap)))
      // The two that went wrong on 2026-10-22, and the cost that landed on 3740.
      expect(balances.get('1930')).toBe(97218.5)
      expect(balances.get('2641')).toBe(3038.4)
      expect(balances.get('4010')).toBe(2153.6)
      expect(balances.has('3740')).toBe(false)
      expect(roundOre([...balances.values()].reduce((sum, amount) => sum + amount, 0))).toBe(0)
    })

    it('needs no adjustment verifikat: the job\'s own comparison with #UB and #RES finds no difference', () => {
      const { movements, prepared, accountMap } = ledgerAfterImport(parsed, mappings)
      const adjustment = buildSIEMigrationAdjustmentEntry('period-1', parsed, accountMap, movements, prepared.skippedDetails)
      expect(adjustment).toMatchObject({ input: null, deltaAccounts: 0 })
    })
  })

  it('shows what the old gate let through: the skipped payments leave 1930 and 2641 off and their cost on öresutjämning', () => {
    // The mapping list of 2026-10-22, run through the preparation without the gate.
    const mappings = BAS_ACCOUNTS.map((account) => map(account))
    const { balances, movements, prepared, accountMap } = ledgerAfterImport(parsed, mappings)
    expect(prepared.skippedDetails.filter((skipped) => skipped.reason === 'unmapped').map((skipped) => skipped.voucherId))
      .toEqual(['X1', 'A3', 'E12', 'E13'])
    expect(balances.get('1930')).toBe(99910.5)
    const adjustment = buildSIEMigrationAdjustmentEntry('period-1', parsed, accountMap, movements, prepared.skippedDetails)
    expect(adjustment.input?.lines.find((line) => line.account_number === '3740')).toMatchObject({ debit_amount: 2153.6 })
  })
})
