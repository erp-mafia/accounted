/**
 * The Swedish names of the ledger context's VAT treatment codes. They stay
 * Swedish in both locales, like BAS account names and momsdeklaration labels.
 * Shared by the Karta view and the wiki's context
 * view, so a treatment reads the same on both.
 */
const VAT_LABELS: Record<string, string> = {
  standard_25: 'Moms 25%',
  standard_12: 'Moms 12%',
  standard_6: 'Moms 6%',
  reduced_12: 'Moms 12%',
  reduced_6: 'Moms 6%',
  reverse_charge: 'Omvänd moms',
  reverse_charge_eu: 'Omvänd moms (EU)',
  reverse_charge_services: 'Omvänd moms (tjänster)',
  eu_reverse_charge_services: 'Omvänd moms (EU-tjänster)',
  eu_goods: 'EU-varor',
  export: 'Export',
  exempt: 'Momsfri',
  no_vat: 'Ingen moms',
}

export function vatLabel(code: string | null): string | null {
  if (!code) return null
  return VAT_LABELS[code] ?? code
}
