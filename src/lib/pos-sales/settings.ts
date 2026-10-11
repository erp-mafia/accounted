import { z } from 'zod'
import { POS_TENDER_KINDS, type PosTenderKind } from '@accounted/connect-contract'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'

/**
 * How a point-of-sale day becomes a daily takings voucher: one account per
 * way of paying, per VAT rate, for tips and for rounding. Stored per
 * connection in pos_connections.settings and always read merged over the
 * defaults, so a stored map never needs every key.
 *
 * Defaults follow BAS 2026 and the swedish-cash-register skill
 * (references/cash-bookkeeping.md, verified against bas.se):
 *
 * - card and Swish to 1686 Fordringar för kontokort och kuponger, the
 *   clearing account the acquirer's and the bank's payouts clear: the payout
 *   books against 1686, never as sales, so revenue is never booked twice;
 * - cash to 1910 Kassa;
 * - a redeemed gift card to 2421 Ej inlösta presentkort (a multi-purpose
 *   voucher carries no VAT when sold, so the redemption takes it);
 * - tips to 2820 Kortfristiga skulder till anställda: the liability route,
 *   which the skill makes the default until the company says the employer
 *   decides the split (then they are lön);
 * - sales per rate to 3001/3002/3003 with 2611/2621/2631;
 * - sales WITHOUT VAT have no default: in a restaurant they are as likely a
 *   gift card sold (2421, a liability) as an exempt sale (3004), and only a
 *   person knows which;
 * - invoice, prepaid and unrecognised tenders have no default either: the
 *   money arrives somewhere this voucher cannot see.
 *
 * A kind or rate without an account stops the day at needs_review with the
 * reason, never at a guessed account.
 */

const accountNumber = accountNumberSchema

/** Rates the mapping knows, in percent, as the string keys JSON stores. */
export const POS_VAT_RATE_KEYS = ['25', '12', '6', '0'] as const
export type PosVatRateKey = (typeof POS_VAT_RATE_KEYS)[number]

export const posSalesSettingsSchema = z.object({
  tender_accounts: z.object(
    Object.fromEntries(POS_TENDER_KINDS.map((kind) => [kind, accountNumber.nullable()])) as Record<
      PosTenderKind,
      z.ZodNullable<typeof accountNumber>
    >,
  ),
  revenue_accounts: z.object({
    '25': accountNumber.nullable(),
    '12': accountNumber.nullable(),
    '6': accountNumber.nullable(),
    '0': accountNumber.nullable(),
  }),
  vat_accounts: z.object({
    '25': accountNumber.nullable(),
    '12': accountNumber.nullable(),
    '6': accountNumber.nullable(),
  }),
  tips_account: accountNumber,
  rounding_account: accountNumber,
  /** The largest difference per day booked as rounding; anything larger stops the day. */
  max_rounding: z.number().min(0).max(10),
})
export type PosSalesSettings = z.infer<typeof posSalesSettingsSchema>

export const DEFAULT_POS_SALES_SETTINGS: PosSalesSettings = {
  tender_accounts: {
    card: '1686',
    swish: '1686',
    cash: '1910',
    gift_card: '2421',
    invoice: null,
    prepaid: null,
    other: null,
  },
  revenue_accounts: { '25': '3001', '12': '3002', '6': '3003', '0': null },
  vat_accounts: { '25': '2611', '12': '2621', '6': '2631' },
  tips_account: '2820',
  rounding_account: ORE_ROUNDING_ACCOUNT,
  max_rounding: ORE_ROUNDING_SETTLEMENT_MAX,
}

/** What a caller may send to change settings: any subset, nested maps merged key by key. */
export const posSalesSettingsPatchSchema = z
  .object({
    // Strict: an unknown tender kind or rate is a typo, never silently dropped.
    tender_accounts: posSalesSettingsSchema.shape.tender_accounts.partial().strict(),
    revenue_accounts: posSalesSettingsSchema.shape.revenue_accounts.partial().strict(),
    vat_accounts: posSalesSettingsSchema.shape.vat_accounts.partial().strict(),
    tips_account: accountNumber,
    rounding_account: accountNumber,
    max_rounding: posSalesSettingsSchema.shape.max_rounding,
  })
  .partial()
  .strict()
export type PosSalesSettingsPatch = z.infer<typeof posSalesSettingsPatchSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The stored settings merged over the defaults. A stored value that no longer
 * validates (an older shape, a hand edit) falls back to the default for that
 * key instead of breaking the day: the default is always a valid mapping.
 */
export function resolvePosSalesSettings(stored: unknown): PosSalesSettings {
  const source = isRecord(stored) ? stored : {}
  const merged: PosSalesSettings = structuredClone(DEFAULT_POS_SALES_SETTINGS)
  for (const mapKey of ['tender_accounts', 'revenue_accounts', 'vat_accounts'] as const) {
    const storedMap = source[mapKey]
    if (!isRecord(storedMap)) continue
    const target = merged[mapKey] as Record<string, string | null>
    for (const key of Object.keys(target)) {
      if (!(key in storedMap)) continue
      const value = storedMap[key]
      if (value === null || accountNumber.safeParse(value).success) target[key] = value as string | null
    }
  }
  for (const key of ['tips_account', 'rounding_account'] as const) {
    if (accountNumber.safeParse(source[key]).success) merged[key] = source[key] as string
  }
  if (posSalesSettingsSchema.shape.max_rounding.safeParse(source.max_rounding).success) {
    merged.max_rounding = source.max_rounding as number
  }
  return merged
}

/** Apply a validated patch on top of the resolved settings. */
export function applyPosSalesSettingsPatch(current: PosSalesSettings, patch: PosSalesSettingsPatch): PosSalesSettings {
  return {
    ...current,
    ...(patch.tips_account !== undefined ? { tips_account: patch.tips_account } : {}),
    ...(patch.rounding_account !== undefined ? { rounding_account: patch.rounding_account } : {}),
    ...(patch.max_rounding !== undefined ? { max_rounding: patch.max_rounding } : {}),
    tender_accounts: { ...current.tender_accounts, ...(patch.tender_accounts ?? {}) },
    revenue_accounts: { ...current.revenue_accounts, ...(patch.revenue_accounts ?? {}) },
    vat_accounts: { ...current.vat_accounts, ...(patch.vat_accounts ?? {}) },
  }
}
