import type { AccountVatTreatment } from '@/lib/vat/account-vat-treatment'
import { spirisVatTreatment } from './spiris-vat-codes'

/**
 * The chart-of-accounts export formats this project can read.
 *
 * Declarative on purpose: a new accounting system is an entry in the list plus
 * a translate function, not a new parser. Everything that differs between
 * vendors (delimiter, column names, VAT code vocabulary) is data here.
 *
 * The format is detected from the header rather than picked by the user. Column
 * sets are effectively fingerprints, vendors do not collide on them, and asking
 * would put the burden on the one fact the user is least sure of: this product
 * was called Visma eEkonomi until recently and is now Spiris Bokföring, so a
 * dropdown turns a rename into a wrong answer on a correct file. Detection is
 * reported back instead, so a wrong guess is visible rather than silent.
 */
export interface SourceChartFormat {
  /** Stable id, used in code and tests, never shown. */
  id: 'spiris'
  /** What to call it when telling the user what was read. */
  label: string
  delimiter: ';' | ','
  /**
   * Header names. accountNumber and accountName are required for a match;
   * the other two are read when present.
   */
  columns: {
    accountNumber: string
    accountName: string
    vatCode?: string
    isActive?: string
  }
  /** This vendor's VAT code vocabulary. Signature matches applySourceVatCodes. */
  translate: (code: string, accountNumber: string) => AccountVatTreatment | null
}

export const SOURCE_CHART_FORMATS: readonly SourceChartFormat[] = [
  {
    id: 'spiris',
    // Both names, because the rename is recent enough that a user may know it
    // by either and the word has to be recognisable when it is read back.
    label: 'Spiris Bokföring',
    delimiter: ';',
    columns: {
      accountNumber: 'AccountNumber',
      accountName: 'AccountName',
      vatCode: 'VatCodeAndPercent',
      isActive: 'IsActive',
    },
    translate: spirisVatTreatment,
  },
]

/** Every format's label, for telling the user what a file could have been. */
export function supportedFormatLabels(): string[] {
  return SOURCE_CHART_FORMATS.map((f) => f.label)
}
