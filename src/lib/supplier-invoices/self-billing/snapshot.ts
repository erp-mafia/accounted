/**
 * The frozen facts of a self-billing invoice (självfaktura, crm#1367).
 *
 * A buyer that issues the invoice in its supplier's name prints the parties
 * as they were on the day of issue (ML 2023:200 17 kap 24 § p.3-6), the prior
 * agreement and the acceptance procedure (17 kap 15 §). The snapshot freezes
 * them on the supplier_invoices row (self_billing_snapshot), so the document
 * renders the same every time, whatever later happens to the supplier card or
 * the company settings. The database refuses to change it afterwards
 * (guard_self_billing_identity).
 *
 * Pure: no database, no React, so the create path, the credit path and the
 * tests share one builder.
 */
import { z } from 'zod'

export const SELF_BILLING_SNAPSHOT_VERSION = 1 as const

const nullableText = z.string().nullable()

const SelfBillingPartySchema = z.object({
  name: z.string(),
  org_number: nullableText,
  vat_number: nullableText,
  address_line1: nullableText,
  address_line2: nullableText,
  postal_code: nullableText,
  city: nullableText,
  country: nullableText,
})

const SelfBillingPayToSchema = z.object({
  bankgiro: nullableText,
  plusgiro: nullableText,
  iban: nullableText,
  bic: nullableText,
  clearing_number: nullableText,
  account_number: nullableText,
})

export const SelfBillingSnapshotSchema = z.object({
  v: z.literal(SELF_BILLING_SNAPSHOT_VERSION),
  /** The supplier: the seller, in whose name the invoice is issued. */
  seller: SelfBillingPartySchema,
  /** The company: the buyer, which issues the invoice. */
  buyer: SelfBillingPartySchema,
  /** Where the seller is paid, from the supplier card. */
  pay_to: SelfBillingPayToSchema,
  agreement_ref: z.string(),
  acceptance_text: z.string(),
  /** On a credit note: the self-billing invoice it credits. */
  credits: z.object({ number: z.string(), invoice_date: z.string() }).nullable(),
})

export type SelfBillingParty = z.infer<typeof SelfBillingPartySchema>
export type SelfBillingSnapshot = z.infer<typeof SelfBillingSnapshotSchema>

/**
 * The acceptance clause when the company has written none. It names no
 * objection period of its own: the agreement decides that, and inventing one
 * here could contradict it.
 */
export function defaultSelfBillingAcceptanceText(agreementRef: string): string {
  return (
    `Fakturan är upprättad av köparen genom självfakturering enligt avtal ${agreementRef}. ` +
    'Säljaren har granskat och godkänt fakturan om ingen invändning har lämnats till köparen inom den tid som avtalet anger.'
  )
}

/** The supplier card fields the snapshot reads. */
export interface SelfBillingSupplierSource {
  name: string | null
  org_number: string | null
  vat_number: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
  bankgiro: string | null
  plusgiro: string | null
  iban: string | null
  bic: string | null
  clearing_number: string | null
  account_number: string | null
}

/** The company settings fields the snapshot reads. */
export interface SelfBillingCompanySource {
  company_name: string | null
  org_number: string | null
  vat_number: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
  self_billing_acceptance_text?: string | null
}

/** A field the snapshot needs that the card or the settings lack. */
export type SelfBillingMissingField =
  | 'seller.name'
  | 'seller.address'
  | 'seller.vat_number'
  | 'buyer.name'
  | 'buyer.org_number'
  | 'buyer.address'

const text = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed === '' ? null : trimmed
}

function party(source: Omit<SelfBillingSupplierSource, 'bankgiro' | 'plusgiro' | 'iban' | 'bic' | 'clearing_number' | 'account_number'>): SelfBillingParty {
  return {
    name: text(source.name) ?? '',
    org_number: text(source.org_number),
    vat_number: text(source.vat_number),
    address_line1: text(source.address_line1),
    address_line2: text(source.address_line2),
    postal_code: text(source.postal_code),
    city: text(source.city),
    country: text(source.country),
  }
}

const hasAddress = (p: SelfBillingParty): boolean => Boolean(p.address_line1 && p.postal_code && p.city)

/**
 * Build the snapshot, or name every field ML 17 kap 24 § needs that is
 * missing: both parties' names and addresses (p.5-6), the buyer's
 * organisationsnummer, and the seller's momsregistreringsnummer whenever the
 * invoice charges VAT (p.3).
 */
export function buildSelfBillingSnapshot(input: {
  supplier: SelfBillingSupplierSource
  company: SelfBillingCompanySource
  agreementRef: string
  chargesVat: boolean
  credits?: { number: string; invoice_date: string } | null
}): { ok: true; snapshot: SelfBillingSnapshot } | { ok: false; missing: SelfBillingMissingField[] } {
  const seller = party(input.supplier)
  const buyer = party({ ...input.company, name: input.company.company_name })
  const missing: SelfBillingMissingField[] = []
  if (!seller.name) missing.push('seller.name')
  if (!hasAddress(seller)) missing.push('seller.address')
  if (input.chargesVat && !seller.vat_number) missing.push('seller.vat_number')
  if (!buyer.name) missing.push('buyer.name')
  if (!buyer.org_number) missing.push('buyer.org_number')
  if (!hasAddress(buyer)) missing.push('buyer.address')
  if (missing.length > 0) return { ok: false, missing }

  const agreementRef = input.agreementRef.trim()
  return {
    ok: true,
    snapshot: {
      v: SELF_BILLING_SNAPSHOT_VERSION,
      seller,
      buyer,
      pay_to: {
        bankgiro: text(input.supplier.bankgiro),
        plusgiro: text(input.supplier.plusgiro),
        iban: text(input.supplier.iban),
        bic: text(input.supplier.bic),
        clearing_number: text(input.supplier.clearing_number),
        account_number: text(input.supplier.account_number),
      },
      agreement_ref: agreementRef,
      acceptance_text: text(input.company.self_billing_acceptance_text) ?? defaultSelfBillingAcceptanceText(agreementRef),
      credits: input.credits ?? null,
    },
  }
}

/**
 * The snapshot of a credit note for a self-billing invoice: the original's
 * parties, agreement and clause, plus the invoice it credits (ML 17 kap 22 §:
 * an unambiguous reference to the original). Null when the original's
 * snapshot cannot be read.
 */
export function creditNoteSelfBillingSnapshot(
  original: unknown,
  credits: { number: string; invoice_date: string },
): SelfBillingSnapshot | null {
  const parsed = SelfBillingSnapshotSchema.safeParse(original)
  if (!parsed.success) return null
  return { ...parsed.data, credits }
}

/** The snapshot as stored, or null when the row does not hold a readable one. */
export function readSelfBillingSnapshot(stored: unknown): SelfBillingSnapshot | null {
  const parsed = SelfBillingSnapshotSchema.safeParse(stored)
  return parsed.success ? parsed.data : null
}
