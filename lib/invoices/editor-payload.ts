/**
 * Pure payload builders for the invoice editor (components/invoices/
 * InvoiceEditor.tsx). Extracted so the exact request bodies the editor sends
 * to POST /api/invoices, PATCH /api/invoices/[id] and POST
 * /api/invoices/self-billed are pinned by unit tests: the repo renders no
 * components in tests, so these builders are the byte-compatibility ratchet
 * under any editor re-layout.
 *
 * Nothing in here may read component state: every input arrives as an
 * argument, every function is a pure mapping from form data to wire body.
 */

/** True when a dimensions bag ({sie_dim_no: code}) carries at least one value. */
export function hasDimensionValues(
  dims: Record<string, string> | null | undefined,
): boolean {
  return !!dims && Object.keys(dims).length > 0
}

/** The self-billing carrier fields the form always holds (default ''). */
export interface SelfBillingCarrierFields {
  external_invoice_number?: string
  self_billing_agreement_ref?: string
  received_date?: string
}

/** The per-item ROT/RUT fields that are privacy-stripped when unused. */
export interface DeductionItemFields {
  deduction_type?: 'rot' | 'rut' | null
  labor_hours?: number | null
  work_type?: string | null
  housing_designation?: string | null
  apartment_number?: string | null
  brf_org_number?: string | null
}

/**
 * Per-item bags ride the payload only when they carry values: the server
 * treats an absent bag as "inherit the invoice's default_dimensions".
 */
export function pruneItemDimensions<
  T extends { dimensions?: Record<string, string> | null },
>(items: T[]): T[] {
  return items.map((item) =>
    hasDimensionValues(item.dimensions) ? item : { ...item, dimensions: undefined },
  )
}

/**
 * The form always carries the self-billing fields (they default to '' in both
 * create and edit mode). The editor's normal create/draft/edit flows never
 * use self-billing (that goes through /api/invoices/self-billed), so drop the
 * empty carriers before spreading the form data into the /api/invoices (or
 * PATCH) body: a bare external_invoice_number: '' otherwise trips the shared
 * CreateInvoiceSchema's min(1). Belt-and-suspenders; the server schema also
 * coerces '' to undefined for these fields.
 */
export function stripSelfBillingFields<T extends SelfBillingCarrierFields>(
  data: T,
): Omit<T, keyof SelfBillingCarrierFields> {
  const {
    external_invoice_number: _ein,
    self_billing_agreement_ref: _sbar,
    received_date: _rd,
    ...rest
  } = data
  return rest
}

/**
 * Privacy by default: ROT/RUT line fields are only sent to the API when the
 * line actually claims a deduction. Defaults are pre-instantiated as null in
 * the form state, but null personal-data fields shouldn't ride along on every
 * regular invoice.
 */
export function sanitizeDeductionItems<T extends DeductionItemFields>(
  items: T[],
): Array<T | Omit<T, keyof DeductionItemFields>> {
  return items.map((item) => {
    if (item.deduction_type) return item
    const {
      deduction_type: _dt,
      labor_hours: _lh,
      work_type: _wt,
      housing_designation: _hd,
      apartment_number: _an,
      brf_org_number: _bn,
      ...rest
    } = item
    return rest
  })
}

export interface InvoiceWritePayloadOptions {
  /** POST with save_as_draft: true (unnumbered draft, no invoice.created). */
  saveAsDraft?: boolean
  /** Öresavrundning display flag (component state, not a form field). */
  oreRounding: boolean
  /** Invoice-level default dims: always sent so an edit can clear them ({} = none). */
  defaultDims: Record<string, string>
}

/**
 * The one body builder behind "Granska & skapa" (POST), "Spara som utkast"
 * (POST + save_as_draft) and edit mode (PATCH). Unifies the three previously
 * inline, near-identical builders in InvoiceEditor.tsx: same dimension
 * pruning, same ROT/RUT privacy strip, same invoice-level personnummer /
 * housing sanitization.
 */
export function buildInvoiceWritePayload<
  TItem extends DeductionItemFields & { dimensions?: Record<string, string> | null },
  TForm extends SelfBillingCarrierFields & { items: TItem[] },
>(data: TForm, options: InvoiceWritePayloadOptions) {
  const anyDeduction = data.items.some((i) => i.deduction_type)
  const sanitizedItems = sanitizeDeductionItems(pruneItemDimensions(data.items))
  return {
    ...stripSelfBillingFields(data),
    ...(options.saveAsDraft ? { save_as_draft: true } : {}),
    ore_rounding: options.oreRounding,
    default_dimensions: options.defaultDims,
    items: sanitizedItems,
    // Invoice-level personnummer/housing only ride along when a deduction is
    // actually claimed somewhere. undefined keys disappear in JSON.
    ...(anyDeduction
      ? {}
      : { deduction_personnummer: undefined, deduction_housing_designation: undefined }),
  }
}

/** The reduced field set POST /api/invoices/self-billed accepts. */
export interface SelfBilledFormShape {
  customer_id: string
  external_invoice_number?: string
  self_billing_agreement_ref?: string
  invoice_date: string
  received_date?: string
  due_date: string
  currency: string
  notes?: string
  items: Array<{
    description: string
    quantity: number
    unit: string
    unit_price: number
    vat_rate: number
  }>
}

/**
 * Body mapper for a mottagen självfaktura (POST /api/invoices/self-billed):
 * a faithful revenue-only transcription, so items are reduced to the five
 * wire fields and none of the invoice-doc extras (document_type, ROT/RUT,
 * payment link, ore_rounding) are sent.
 */
export function buildSelfBilledPayload<T extends SelfBilledFormShape>(data: T) {
  return {
    customer_id: data.customer_id,
    external_invoice_number: data.external_invoice_number,
    self_billing_agreement_ref: data.self_billing_agreement_ref || undefined,
    invoice_date: data.invoice_date,
    received_date: data.received_date,
    due_date: data.due_date,
    currency: data.currency,
    notes: data.notes,
    items: data.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unit_price: i.unit_price,
      vat_rate: i.vat_rate,
    })),
  }
}
