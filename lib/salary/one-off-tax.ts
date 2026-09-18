export const ONE_OFF_TYPES = ['bonus', 'commission', 'other', 'correction', 'semesterersattning']

export function validateOneOffTaxLine(line: {
  one_off_tax_percent?: number | null; item_type: string; amount: number
  is_taxable: boolean; is_gross_deduction: boolean; is_net_deduction: boolean
}): string | null {
  const rate = line.one_off_tax_percent
  if (rate == null) return null
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || line.amount <= 0 ||
    !ONE_OFF_TYPES.includes(line.item_type) || !line.is_taxable || line.is_gross_deduction || line.is_net_deduction) {
    return 'Engångsskatt kräver ett positivt skattepliktigt lönetillägg och en verifierad procentsats mellan 0 och 100'
  }
  return null
}
