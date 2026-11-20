/**
 * Deep link into the CSV/Excel wizard on /import with one data type
 * preselected. The register list pages (Kunder, Leverantörer, Artiklar) build
 * it for their "Importera" button and the import page parses it, so the link
 * format lives here and nowhere else.
 */

export const CSV_DATA_ENTITIES = ['opening_balance', 'customers', 'suppliers', 'articles'] as const

export type CsvDataEntity = (typeof CSV_DATA_ENTITIES)[number]

/** The registers that have a list page of their own. */
export type RegisterImportEntity = Exclude<CsvDataEntity, 'opening_balance'>

export function registerImportHref(entity: RegisterImportEntity): string {
  return `/import?mode=csv_data&entity=${entity}`
}

/** The `entity` query value as a wizard tab, or null when absent or unknown. */
export function parseCsvDataEntity(value: string | null | undefined): CsvDataEntity | null {
  return CSV_DATA_ENTITIES.find((entity) => entity === value) ?? null
}
