import type { AccountVatTreatment } from '@/lib/vat/account-vat-treatment'
import { parseSpirisVatCode, spirisVatTreatment } from './spiris-vat-codes'

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
/**
 * Supported source chart format identifiers. A named union like
 * BankFileFormatId next door, so adding a vendor is one line here rather than
 * a change to the interface itself.
 */
export type SourceChartFormatId = 'spiris'

export interface SourceChartFormat {
  /** Stable id, used in code and tests, never shown. */
  id: SourceChartFormatId
  /**
   * The migration provider this format belongs to, so a surface that already
   * knows which system the user is leaving can offer the chart only where it
   * can actually be read. Onboarding asks that question up front, and offering
   * a Spiris-only reader to someone who picked Bokio promises what the parser
   * cannot deliver.
   */
  provider: 'visma'
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
  /**
   * The momssats the code itself states, or null when it states none.
   *
   * Separate from translate because applySourceVatCodes only asks for a
   * treatment, and the rate it derives from that comes from the account label.
   * The label is the weaker source: a chart is free to code 20-12% on an
   * account whose name carries no percentage, and guessing then files 25 %
   * against an explicit 12 %.
   */
  rateFromCode: (code: string) => number | null
}

export const SOURCE_CHART_FORMATS: readonly SourceChartFormat[] = [
  {
    id: 'spiris',
    // Spiris Bokföring is the product the migration list still calls Visma
    // eEkonomi, its name before the rename.
    provider: 'visma',
    // The current name only. The old one is where a user who knows the product
    // by it will actually look: source_chart_help_where spells out "I Spiris
    // Bokföring, tidigare Visma eEkonomi" next to the menu path.
    label: 'Spiris Bokföring',
    delimiter: ';',
    columns: {
      accountNumber: 'AccountNumber',
      accountName: 'AccountName',
      vatCode: 'VatCodeAndPercent',
      isActive: 'IsActive',
    },
    translate: spirisVatTreatment,
    rateFromCode: (code) => parseSpirisVatCode(code)?.rate ?? null,
  },
]

/**
 * The chart format for a migration provider, or null when this project cannot
 * read that system's export. Asked by any surface that knows the provider
 * before a file is picked.
 */
export function sourceChartFormatForProvider(
  provider: string | null | undefined,
): SourceChartFormat | null {
  return SOURCE_CHART_FORMATS.find((format) => format.provider === provider) ?? null
}

/** Every format's label, for telling the user what a file could have been. */
export function supportedFormatLabels(): string[] {
  return SOURCE_CHART_FORMATS.map((f) => f.label)
}
