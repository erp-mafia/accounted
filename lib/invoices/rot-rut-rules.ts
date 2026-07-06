/**
 * ROT/RUT-avdrag rules.
 *
 * Implements the calculation and validation logic for Sweden's tax deduction
 * for household services (RUT) and home renovation (ROT). As of 2026:
 *   - ROT: 30% of labor cost, max 50 000 kr per person per year.
 *   - RUT: 50% of labor cost, max 75 000 kr per person per year.
 *
 * The deduction applies to labor only: material costs and travel time are
 * NOT eligible. In this v1 we treat the entire invoice item amount as labor
 * when the user flags it ROT/RUT; the user is expected to either invoice
 * labor on its own row or split materials onto a non-flagged row. A future
 * iteration can add per-line "labor portion" handling if needed.
 *
 * We CAN'T verify that the customer has remaining yearly headroom (they may
 * have claimed elsewhere). We surface a warning when the per-invoice total
 * already exceeds the statutory max: the customer must then handle the
 * excess outside of fakturamodellen.
 *
 * All functions are pure and deterministic. No I/O, no DB calls: easy to
 * unit-test and easy to embed in the API validator and the live total
 * preview in the invoice editor.
 */

/** Percentage of eligible amount deducted for ROT (renovation). 2026 rule. */
export const ROT_PERCENT = 0.30

/** Percentage of eligible amount deducted for RUT (household services). 2026 rule. */
export const RUT_PERCENT = 0.50

/** Maximum yearly ROT deduction per person, in kr. 2026 rule. */
export const ROT_MAX = 50000

/** Maximum yearly RUT deduction per person, in kr. 2026 rule. */
export const RUT_MAX = 75000

export type DeductionType = 'rot' | 'rut'

/** Skatteverket work codes used by Husavdragstjänsten. Maps a free-text */
/** "what the worker did" label to the official code. The code drives which */
/** element the begäran-om-utbetalning file (Begaran.xsd V6) reports the */
/** hours under: see WORK_TYPE_ELEMENTS in lib/invoices/rot-rut-file.ts. */
/** The lists mirror the XSD exactly: rot work types are the seven */
/** ArendeUtfortArbeteRotTYPE elements (IT-tjänster is a RUT service and was */
/** removed from the rot list 2026-07); rut covers all thirteen */
/** ArendeUtfortArbeteRutTYPE elements incl. the two schablontjänster. */
export const ROT_WORK_TYPES = [
  { code: 'BYGG', label: 'Byggnadsarbete' },
  { code: 'EL', label: 'Elarbete' },
  { code: 'GLAS_PLAT', label: 'Glas- och plåtarbete' },
  { code: 'MARK_DRAN', label: 'Mark- och dräneringsarbete' },
  { code: 'MURNING', label: 'Murnings- och putsarbete' },
  { code: 'MALNING', label: 'Mål- och tapetseringsarbete' },
  { code: 'VVS', label: 'VVS-arbete' },
] as const

export const RUT_WORK_TYPES = [
  { code: 'STAD', label: 'Städning' },
  { code: 'KLAD', label: 'Kläd- och textilvård' },
  { code: 'SNOSKOTTNING', label: 'Snöskottning' },
  { code: 'TRADGARD', label: 'Trädgårdsarbete' },
  { code: 'BARNPASS', label: 'Barnpassning' },
  { code: 'PERSONLIG_OMS', label: 'Personlig omsorg' },
  { code: 'FLYTT', label: 'Flyttjänster' },
  { code: 'IT', label: 'IT-tjänster i hemmet' },
  { code: 'REPARATION', label: 'Reparation av vitvaror' },
  { code: 'MOBLERING', label: 'Möblering' },
  { code: 'TILLSYN', label: 'Tillsyn av bostad' },
  // Schablontjänster: reported as utförd/ej utförd in the Skatteverket file,
  // never with hours or material.
  { code: 'TRANSPORT', label: 'Transport till försäljning (schablon)' },
  { code: 'TVATT', label: 'Tvätt vid tvättinrättning (schablon)' },
] as const

export interface ItemForDeduction {
  /** Unit price (per `quantity`). Same field as invoice_items.unit_price. */
  unit_price: number
  /** Quantity. Same field as invoice_items.quantity. */
  quantity: number
  /** 'rot' | 'rut' | null. Drives whether the deduction kicks in at all. */
  deduction_type?: DeductionType | null
  /**
   * Optional. Reserved for a future iteration where the eligible portion of
   * the row is just the labor hours × hourly rate. v1 ignores this and
   * deducts on the full line total; we still take the field so the API
   * schema accepts it without rejecting future-shaped payloads.
   */
  labor_hours?: number | null
}

/**
 * Compute the deduction amount for a single invoice item. Returns 0 when
 * the item has no deduction_type. The result is always >= 0 and <= line
 * total (no over-deduction even if percentages are tweaked).
 */
export function computeDeduction(item: ItemForDeduction): number {
  if (!item.deduction_type) return 0
  const lineTotal = item.unit_price * item.quantity
  if (lineTotal <= 0) return 0
  const percent = item.deduction_type === 'rot' ? ROT_PERCENT : RUT_PERCENT
  const raw = lineTotal * percent
  // Cap at line total: defensive against future rule changes that would
  // push percent past 1.0.
  const capped = Math.min(raw, lineTotal)
  return Math.round(capped * 100) / 100
}

/**
 * Sum the per-item deduction over an invoice. Returns the total to store
 * on invoices.deduction_total and to use as the 1513 debit amount.
 */
export function computeInvoiceDeductionTotal(items: ItemForDeduction[]): number {
  let total = 0
  for (const item of items) {
    total += computeDeduction(item)
  }
  return Math.round(total * 100) / 100
}

/**
 * Sum per deduction kind. Used to surface separate cap warnings.
 */
export function computeDeductionTotalsByKind(items: ItemForDeduction[]): {
  rot: number
  rut: number
} {
  let rot = 0
  let rut = 0
  for (const item of items) {
    const amount = computeDeduction(item)
    if (item.deduction_type === 'rot') rot += amount
    else if (item.deduction_type === 'rut') rut += amount
  }
  return {
    rot: Math.round(rot * 100) / 100,
    rut: Math.round(rut * 100) / 100,
  }
}

export interface ValidateInvoiceItem extends ItemForDeduction {
  housing_designation?: string | null
}

export interface ValidationResult {
  errors: string[]
  warnings: string[]
}

/**
 * Validate ROT/RUT prerequisites against a draft invoice.
 *
 * Errors block invoice creation; warnings surface in the UI but don't
 * block (we can't verify a customer's yearly headroom across providers,
 * but we can surface a "this invoice alone exceeds the cap" warning).
 *
 * The function takes invoice-level metadata as separate arguments rather
 * than reading them off the items array so callers can compose it from
 * either a HTTP request body or the form state without restructuring.
 */
export function validateInvoice(
  items: ValidateInvoiceItem[],
  personnummerProvided: boolean,
  housingDesignationProvided: boolean,
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const hasAnyDeduction = items.some((item) => item.deduction_type)
  const hasAnyRot = items.some((item) => item.deduction_type === 'rot')

  if (hasAnyDeduction && !personnummerProvided) {
    errors.push('Personnummer krävs för ROT/RUT-avdrag.')
  }

  // ROT requires fastighetsbeteckning per Skatteverket's Husavdragstjänst.
  // RUT does not (in 2026 the Skatteverket file accepts RUT without it).
  if (hasAnyRot && !housingDesignationProvided) {
    errors.push('Fastighetsbeteckning krävs för ROT-avdrag.')
  }

  const { rot, rut } = computeDeductionTotalsByKind(items)

  if (rot > ROT_MAX) {
    warnings.push(
      `ROT-avdraget på denna faktura (${rot.toFixed(2)} kr) överstiger årsmaximum ${ROT_MAX.toLocaleString('sv-SE')} kr. ` +
        'Kunden behöver kontrollera sitt återstående utrymme själv.',
    )
  }
  if (rut > RUT_MAX) {
    warnings.push(
      `RUT-avdraget på denna faktura (${rut.toFixed(2)} kr) överstiger årsmaximum ${RUT_MAX.toLocaleString('sv-SE')} kr. ` +
        'Kunden behöver kontrollera sitt återstående utrymme själv.',
    )
  }

  return { errors, warnings }
}
