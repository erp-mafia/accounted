/**
 * Display names of the purchase-category taxonomy for server code that has
 * no request locale (the MCP taxonomy tool). The names live in
 * messages/<locale>.json under purchaseCategories, like every UI string; the
 * dashboard reads them with useTranslations('purchaseCategories'). Loaded
 * lazily so the message catalogue stays out of every importer's bundle.
 */
import type { PurchaseCategoryCode, PurchaseCategoryGroup } from './purchase-categories'

/** The purchaseCategories namespace: groups.<port key> and categories.<code>, nested on the dots. */
interface NameTable {
  groups: Record<string, unknown>
  categories: Record<string, unknown>
}

export interface PurchaseCategoryNames {
  group(group: PurchaseCategoryGroup): string
  category(code: PurchaseCategoryCode): string
}

/** The string at a dotted key in a nested table, as next-intl reads it; undefined when there is none. */
function lookup(table: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = table
  for (const segment of key.split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined
  }
  return typeof node === 'string' ? node : undefined
}

export async function loadPurchaseCategoryNames(locale: 'sv' | 'en'): Promise<PurchaseCategoryNames> {
  const mod = locale === 'en' ? await import('@/messages/en.json') : await import('@/messages/sv.json')
  const table = ((mod.default ?? mod) as unknown as { purchaseCategories: NameTable }).purchaseCategories
  return {
    group: (group) => lookup(table.groups, group) ?? group,
    category: (code) => lookup(table.categories, code) ?? code,
  }
}
