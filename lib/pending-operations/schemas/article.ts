import { z } from 'zod'
import { INVOICE_POSTING_ACCOUNT_REGEX } from '@/lib/invoices/posting-account'
import { HOUSEWORK_TYPE_VALUES, normalizeHouseworkType } from '@/lib/invoices/rot-rut-rules'

// Commit-boundary re-validation for staged article operations. A staged
// pending_operations row is re-parsed here before it touches the articles table
// so a tampered row cannot inject unexpected fields or malformed data
// (defense in depth, ASVS V4.5): mirrors lib/pending-operations/schemas/create-supplier.ts.

const invoicePostingAccount = z
  .string()
  .regex(INVOICE_POSTING_ACCOUNT_REGEX, 'Posting account must be a 4-digit BAS class 1-3 account')

const vatRatePercent = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])

/** Empty string / null → undefined, then bounded string. */
const optString = (max: number) =>
  z.preprocess((v) => (v == null || v === '' ? undefined : v), z.string().max(max).optional())

// Same vocabulary as HouseworkTypeSchema in lib/api/schemas.ts: work-type code
// or bare ROT/RUT, upper-cased; empty → undefined; anything else rejected.
const houseworkCode = z.string().max(64).transform((v, ctx) => {
  const normalized = normalizeHouseworkType(v)
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid housework_type. Allowed: ${HOUSEWORK_TYPE_VALUES.join(', ')}`,
    })
    return z.NEVER
  }
  return normalized
})
// Create: empty / null / omitted all mean "no flag" (column stays NULL).
const houseworkTypeCreate = z.preprocess(
  (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
  houseworkCode.optional(),
)
// Update: commitUpdateArticle drops undefined keys, so a clear must arrive as
// null. Omitted stays undefined (untouched); null / '' / whitespace clear.
const houseworkTypeUpdate = z.preprocess(
  (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? (v === undefined ? undefined : null) : v),
  houseworkCode.nullable().optional(),
)

const trimmedName = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().min(1, 'Article name is required').max(200),
)

// ISO 4217 shape, normalized to upper case; the currencies-table FK on
// articles.currency is the authoritative allow-list (unknown codes fail at
// commit with a clear message). Empty string / null → undefined.
const currencyCode = z.preprocess(
  (v) => (v == null || v === '' ? undefined : typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code (e.g. EUR)').optional(),
)

export const CreateArticleParamsSchema = z.object({
  name: trimmedName,
  type: z.enum(['vara', 'tjanst']).default('tjanst'),
  unit: optString(32),
  price_excl_vat: z.number().nonnegative(),
  currency: currencyCode,
  vat_rate: vatRatePercent.default(25),
  revenue_account: invoicePostingAccount.nullable().optional(),
  cost_price: z.number().nonnegative().nullable().optional(),
  ean: optString(32),
  housework_type: houseworkTypeCreate,
  name_en: optString(200),
  notes: optString(2000),
  article_number: optString(64),
})

export const UpdateArticleParamsSchema = z.object({
  article_id: z.string().uuid(),
  name: trimmedName.optional(),
  type: z.enum(['vara', 'tjanst']).optional(),
  unit: optString(32),
  price_excl_vat: z.number().nonnegative().optional(),
  currency: currencyCode,
  vat_rate: vatRatePercent.optional(),
  revenue_account: invoicePostingAccount.nullable().optional(),
  cost_price: z.number().nonnegative().nullable().optional(),
  ean: optString(32),
  housework_type: houseworkTypeUpdate,
  name_en: optString(200),
  notes: optString(2000),
  article_number: optString(64),
  active: z.boolean().optional(),
})

