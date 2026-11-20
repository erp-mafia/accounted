/**
 * How the momsdeklaration's Korrigera classifies one worklist row (one
 * momssats of a verifikat): the supplier type and whether it is a service or
 * goods, which together pick the basis account (ruta 20-24). Client-safe:
 * VatChecksCard renders and sends what this decides.
 *
 * The supplier type comes from the first that has one: the person's own
 * choice on the row, the supplier type preselected from the supplier's
 * country (rc-basis-supplier-default.ts), the toolbar's choice for every row
 * without one. When none has one the row is unclassified (null) and cannot be
 * corrected until the person picks (crm#1431): there is no silent EU default.
 */

export type RcSupplierType = 'eu_business' | 'non_eu_business' | 'swedish_business'
export type RcSupplyType = 'service' | 'goods'

export interface RcGapClassification {
  supplierType: RcSupplierType | null
  supplyType: RcSupplyType
}

/** Goods from outside the EU are import VAT (ruta 50/60-62), not reverse charge: such a row is a service. */
export function coerceSupplyType(supplierType: RcSupplierType | null, supplyType: RcSupplyType): RcSupplyType {
  return supplierType === 'non_eu_business' ? 'service' : supplyType
}

/**
 * A row's classification, by the order in the file comment. A row choice of
 * only the supply type (its supplier type still null) keeps taking the
 * supplier type from the preselection or the toolbar.
 */
export function rcGapClassification(
  override: RcGapClassification | undefined,
  preselected: RcSupplierType | null | undefined,
  shared: RcGapClassification,
): RcGapClassification {
  const supplierType = override?.supplierType ?? preselected ?? shared.supplierType
  const supplyType = override ? override.supplyType : shared.supplyType
  return { supplierType, supplyType: coerceSupplyType(supplierType, supplyType) }
}
