/**
 * Authoritative server-side validation for the create_supplier staged
 * operation. Used by:
 *   - The MCP tool execute() before staging (extensions/general/mcp-server/server.ts)
 *   - commitCreateSupplier() before the suppliers INSERT (lib/pending-operations/commit.ts)
 *
 * Defense in depth: validating at the commit boundary protects the DB even
 * if a caller writes directly to pending_operations.params bypassing the
 * MCP tool, satisfying ASVS V4.5 / ISO A.8.28 input-validation guidance.
 *
 * Financial identifiers (IBAN, BIC, bankgiro, plusgiro, org_number,
 * vat_number, default_expense_account) are format-validated so adversarial
 * or malformed payment-routing data cannot be persisted. Bankgiro is
 * length-checked (7-8 digits, Peppol SE-R-008/009) and additionally passes
 * Bankgirot's modulus-10 (Luhn) check digit. VAT numbers are matched against
 * the VIES per-country patterns in lib/vat/vies-client.ts; the SE pattern
 * (SE + 12 digits) is the same 14-character form Peppol SE-R-001 requires.
 *
 * These are FORMAT checks only. No field here is legally mandatory for a
 * supplier record: ML 17 kap 24 § lists what a seller must put on an invoice
 * it issues, not what a buyer's supplier register must hold, so it cannot make
 * any register field required. Every field except `name` is therefore optional,
 * matching components/suppliers/SupplierForm.tsx and CreateSupplierSchema
 * (lib/api/schemas.ts): the staged/agent path accepts exactly what the
 * dashboard accepts.
 */
import { z } from 'zod'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { parseVatNumber } from '@/lib/vat/vies-client'

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/
const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/
const SE_ORG_NUMBER_RE = /^\d{6}-?\d{4}$|^\d{12}$/
const COUNTRY_RE = /^[A-Z]{2}$/
const PLUSGIRO_RE = /^\d{1,7}-?\d{1}$/
const BAS_EXPENSE_RE = /^[4567]\d{3}$/
const SUPPLIER_TYPES = ['swedish_business', 'eu_business', 'non_eu_business'] as const

/**
 * Accept string | null | undefined, trim, and normalise empty to undefined.
 * Then run the inner zod string validators on the survivor.
 */
function optString(inner: z.ZodTypeAny) {
  return z.preprocess(
    (v) => {
      if (v == null) return undefined
      if (typeof v !== 'string') return v
      const t = v.trim()
      return t === '' ? undefined : t
    },
    inner.optional(),
  )
}

const emailField = optString(z.string().email('Invalid email format').max(255))
const phoneField = optString(z.string().max(50))
const orgNumberField = optString(
  z
    .string()
    .max(20)
    .refine(
      (v) => SE_ORG_NUMBER_RE.test(v.replace(/\s/g, '')),
      'Invalid Swedish org number format (expected XXXXXX-XXXX or 12 digits)',
    ),
)
const vatNumberField = optString(
  z
    .string()
    .max(20)
    .refine(
      (v) => parseVatNumber(v) !== null,
      'Invalid EU VAT number format (must include valid country prefix)',
    ),
)
const countryField = optString(
  z.string().refine((v) => COUNTRY_RE.test(v.toUpperCase()), 'country must be a 2-letter ISO 3166-1 alpha-2 code'),
)
const bankgiroField = optString(
  z.string().max(20).refine(
    (v) => validateBankgiroNumber(v),
    'Invalid Bankgiro (must be 7-8 digits with valid Luhn check digit)',
  ),
)
const plusgiroField = optString(
  z.string().max(20).refine(
    (v) => PLUSGIRO_RE.test(v.replace(/\s/g, '')),
    'Invalid Plusgiro (expected 2-8 digits)',
  ),
)
const ibanField = optString(
  z.string().max(34).refine(
    (v) => IBAN_RE.test(v.replace(/\s/g, '').toUpperCase()),
    'Invalid IBAN format',
  ),
)
const bicField = optString(
  z.string().max(11).refine(
    (v) => BIC_RE.test(v.replace(/\s/g, '').toUpperCase()),
    'Invalid BIC/SWIFT format',
  ),
)
const expenseAccountField = optString(
  z.string().refine(
    (v) => BAS_EXPENSE_RE.test(v),
    'default_expense_account must be a 4-digit BAS expense account (class 4, 5, 6, or 7)',
  ),
)
// Accept either a number or a numeric string. Critically, an explicit 0 is
// preserved (some suppliers are due-on-receipt). null/undefined falls through
// to the 30-day default via .default().
const paymentTermsField = z
  .preprocess(
    (v) => {
      if (v == null || v === '') return undefined
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const n = Number(v)
        return Number.isNaN(n) ? v : n
      }
      return v
    },
    z.number().int('default_payment_terms must be an integer').min(0).max(365).optional(),
  )
  .default(30)

export const CreateSupplierParamsSchema = z
  .object({
    name: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.trim() : v),
        z.string().min(1, 'Supplier name is required').max(255),
      ),
    supplier_type: z.enum(SUPPLIER_TYPES).default('swedish_business'),
    email: emailField,
    phone: phoneField,
    org_number: orgNumberField,
    vat_number: vatNumberField,
    address_line1: optString(z.string().max(255)),
    address_line2: optString(z.string().max(255)),
    postal_code: optString(z.string().max(20)),
    city: optString(z.string().max(100)),
    country: countryField,
    bankgiro: bankgiroField,
    plusgiro: plusgiroField,
    bank_account: optString(z.string().max(50)),
    iban: ibanField,
    bic: bicField,
    default_expense_account: expenseAccountField,
    default_payment_terms: paymentTermsField,
    default_currency: optString(z.string().length(3, 'currency must be a 3-letter ISO code')),
    notes: optString(z.string().max(2000)),
  })
  .strict()

// Deliberately NO "eu_business requires vat_number" rule.
//
// Applying omvänd betalningsskyldighet to an EU purchase does not depend on the
// buyer holding the supplier's VAT number. The buyer reports the purchase and
// self-assesses output VAT, then deducts the same amount as input VAT, because
// it is a taxable person established in Sweden (ML 16 kap 6 § + 6 kap 34 §).
// A VIES-validated counterparty VAT number is a condition for zero-rating an
// intra-community SUPPLY, i.e. the SELLER's side, which is why only `customers`
// carries vat_number_validated / vat_number_validated_at and `suppliers` never
// has. Nothing downstream reads supplier.vat_number to decide reverse charge:
// lib/bookkeeping/supplier-invoice-entries.ts and generateReverseChargeBasisLines()
// key off supplier_type + invoice.reverse_charge alone.
//
// An EU supplier below its national registration threshold has no VAT number at
// all, so requiring one refused legitimate suppliers on the staged/agent path
// while the dashboard form created the very same company without complaint.
