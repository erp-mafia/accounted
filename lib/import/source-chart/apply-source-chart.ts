import { applySourceVatCodes } from '@/lib/import/account-vat-treatment'
import type { AccountMapping } from '@/lib/import/types'
import { parseSourceChartCsv } from './parse-chart-csv'
import { spirisVatTreatment } from './spiris-vat-codes'

/**
 * Apply a source system's chart export to a set of account mappings.
 *
 * The CSV counterpart of the provider-API path the arcim-migration extension
 * runs for Fortnox: same destination (applySourceVatCodes), different way of
 * getting the codes. It lives in core rather than in an extension because a
 * file the user hands over needs no OAuth, no provider client and no consent,
 * so the guided SIE import can offer it on its own.
 *
 * Enrichment, never a precondition. A file that cannot be read leaves the
 * mappings untouched and returns its complaint in `warnings`; the mapping step
 * falls back to the label suggestion exactly as it does today.
 */

export interface SourceChartSummary {
  /** Accounts the file described, whether or not this import uses them. */
  accountsInChart: number
  /** Of those, the ones the source system still offers for posting. */
  activeInChart: number
  /** Mappings now carrying a verbatim source code. */
  codesApplied: number
  /** Of those, the ones that resolved to a treatment. */
  treatmentsApplied: number
  /**
   * Codes read but not translated: a real ruta this project has no
   * AccountVatTreatment for (06, 37, 38, 50). The row keeps the code for
   * display and stays in the review list with its label suggestion.
   */
  codesWithoutTreatment: number
}

export interface SourceChartResult {
  mappings: AccountMapping[]
  warnings: string[]
  summary: SourceChartSummary
}

/**
 * `content` is the file already decoded as text. Spiris writes UTF-8 with a
 * BOM, which the parser strips; a file in another encoding still yields usable
 * codes, since those are ASCII, but mojibake account names.
 */
export function applySourceChartCsv(
  mappings: AccountMapping[],
  content: string,
): SourceChartResult {
  const { accounts, warnings } = parseSourceChartCsv(content)

  const codesByAccount = new Map<string, string>()
  for (const account of accounts) {
    if (account.vatCode) codesByAccount.set(account.accountNumber, account.vatCode)
  }

  const summaryBase = {
    accountsInChart: accounts.length,
    activeInChart: accounts.filter((a) => a.isActive).length,
  }

  if (codesByAccount.size === 0) {
    return {
      mappings,
      warnings: accounts.length > 0
        ? [...warnings, 'Kontoplanen innehöll inga momskoder.']
        : warnings,
      summary: { ...summaryBase, codesApplied: 0, treatmentsApplied: 0, codesWithoutTreatment: 0 },
    }
  }

  const applied = applySourceVatCodes(mappings, codesByAccount, spirisVatTreatment)

  // Counted on the result rather than as a delta: the guided SIE import has no
  // other source of provider codes, so what is on the mappings afterwards is
  // what this file put there, and a total is what the step wants to show.
  const codesApplied = applied.filter((m) => m.providerVatCode).length
  const treatmentsApplied = applied.filter((m) => m.providerVatTreatment).length

  return {
    mappings: applied,
    warnings,
    summary: {
      ...summaryBase,
      codesApplied,
      treatmentsApplied,
      codesWithoutTreatment: codesApplied - treatmentsApplied,
    },
  }
}
