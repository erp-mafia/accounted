/**
 * SWR cache keys for company-scoped reference data.
 *
 * One builder per data set is the single source of truth for the hooks
 * (lib/reference-data/hooks.ts), the server seed (seed.ts) and the
 * invalidation helper (invalidate.ts): a key spelled out anywhere else can
 * drift from the seed and silently reintroduce the refetch this layer exists
 * to remove. Every key carries the company id in position 1 so a company
 * switch can never serve another company's list, and resolves to `null`
 * (SWR: do not fetch) when there is no active company.
 *
 * `company_settings` keeps the shape components/settings/useSettings.ts has
 * used since 2026-07-13 so that hook needs no change to be seeded.
 */

export const REFERENCE_KINDS = [
  'company_settings',
  'ref:fiscal-periods',
  'ref:cash-accounts',
  'ref:accounts',
  'ref:dimensions',
  'ref:booking-templates',
  'ref:customers',
  'ref:suppliers',
  'ref:articles',
] as const

export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

type Key<K extends ReferenceKind, Rest extends readonly unknown[] = []> =
  | readonly [K, string, ...Rest]
  | null

export const refKeys = {
  companySettings: (companyId: string | null): Key<'company_settings'> =>
    companyId ? (['company_settings', companyId] as const) : null,
  fiscalPeriods: (companyId: string | null): Key<'ref:fiscal-periods'> =>
    companyId ? (['ref:fiscal-periods', companyId] as const) : null,
  cashAccounts: (companyId: string | null): Key<'ref:cash-accounts'> =>
    companyId ? (['ref:cash-accounts', companyId] as const) : null,
  accounts: (
    companyId: string | null,
    activeOnly = true,
  ): Key<'ref:accounts', [boolean]> =>
    companyId ? (['ref:accounts', companyId, activeOnly] as const) : null,
  dimensions: (companyId: string | null): Key<'ref:dimensions'> =>
    companyId ? (['ref:dimensions', companyId] as const) : null,
  bookingTemplates: (companyId: string | null): Key<'ref:booking-templates'> =>
    companyId ? (['ref:booking-templates', companyId] as const) : null,
  customers: (companyId: string | null): Key<'ref:customers'> =>
    companyId ? (['ref:customers', companyId] as const) : null,
  suppliers: (companyId: string | null): Key<'ref:suppliers'> =>
    companyId ? (['ref:suppliers', companyId] as const) : null,
  articles: (
    companyId: string | null,
    includeInactive = false,
  ): Key<'ref:articles', [boolean]> =>
    companyId ? (['ref:articles', companyId, includeInactive] as const) : null,
}

const KIND_SET: ReadonlySet<string> = new Set(REFERENCE_KINDS)

/** True for any key produced by `refKeys` (used by the invalidation filter). */
export function isReferenceKey(key: unknown): key is readonly [ReferenceKind, string, ...unknown[]] {
  return Array.isArray(key) && typeof key[0] === 'string' && KIND_SET.has(key[0])
}
