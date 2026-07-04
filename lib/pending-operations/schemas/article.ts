import { z } from 'zod'

// Commit-boundary re-validation for staged article operations. A staged
// pending_operations row is re-parsed here before it touches the articles table
// so a tampered row cannot inject unexpected fields or malformed data
// (defense in depth, ASVS V4.5): mirrors lib/pending-operations/schemas/create-supplier.ts.

const revenueAccount = z
  .string()
  .regex(/^3\d{3}$/, 'Revenue account must be a 4-digit BAS class-3 account (3xxx)')

const vatRatePercent = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])

/** Empty string / null → undefined, then bounded string. */
const optString = (max: number) =>
  z.preprocess((v) => (v == null || v === '' ? undefined : v), z.string().max(max).optional())

const trimmedName = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().min(1, 'Article name is required').max(200),
)

export const CreateArticleParamsSchema = z.object({
  name: trimmedName,
  type: z.enum(['vara', 'tjanst']).default('tjanst'),
  unit: optString(32),
  price_excl_vat: z.number().nonnegative(),
  vat_rate: vatRatePercent.default(25),
  revenue_account: revenueAccount.nullable().optional(),
  cost_price: z.number().nonnegative().nullable().optional(),
  ean: optString(32),
  housework_type: optString(64),
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
  vat_rate: vatRatePercent.optional(),
  revenue_account: revenueAccount.nullable().optional(),
  cost_price: z.number().nonnegative().nullable().optional(),
  ean: optString(32),
  housework_type: optString(64),
  name_en: optString(200),
  notes: optString(2000),
  article_number: optString(64),
  active: z.boolean().optional(),
})

export type CreateArticleParams = z.infer<typeof CreateArticleParamsSchema>
export type UpdateArticleParams = z.infer<typeof UpdateArticleParamsSchema>
