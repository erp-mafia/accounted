/**
 * The purchase-category taxonomy as an MCP read: the codes inbox items carry
 * as purchase_category, their names and the BAS accounts each is typically
 * booked on (the SE country pack). Company-independent reference data. A
 * group is the business-event category the codes are children of, so
 * expense.software.saas is listed under expense.software.
 *
 * Search-only (catalogVisibility 'search'): reachable through
 * gnubok_search_tools and the gnubok_call_tool bridge, at no cost to the
 * tools/list budget.
 */
import { SE_PURCHASE_CATEGORY_PACK } from '@/lib/bookkeeping/bas-data/purchase-category-accounts'
import {
  PURCHASE_CATEGORIES,
  PURCHASE_CATEGORY_GROUPS,
  PURCHASE_CATEGORY_VERSION,
  type PurchaseCategoryGroup,
} from '@/lib/categories/purchase-categories'
import { loadPurchaseCategoryNames } from '@/lib/categories/purchase-category-names'
import type { McpTool, McpToolAnnotations } from './server'

export function createPurchaseCategoryTools(deps: { readOnly: McpToolAnnotations }): McpTool[] {
  return [
    {
      name: 'gnubok_list_purchase_categories',
      keywords: ['inköpskategori', 'inköpskategorier', 'kategori', 'vad köptes', 'purchase category', 'taxonomi'],
      title: 'List Purchase Categories',
      description:
        'The purchase-category taxonomy inbox items read as purchase_category: stable codes (e.g. expense.software.saas) with Swedish and English names and typical BAS accounts, grouped by the business-event category each is a child of (expense.software). Reference only: books nothing.',
      catalogVisibility: 'search',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {
            type: 'string',
            enum: [...PURCHASE_CATEGORY_GROUPS],
            description: 'Only this group: a business-event category, e.g. "expense.software". Omit for the whole taxonomy.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          version: { type: 'string', description: 'Taxonomy version, e.g. pc-2026-10.' },
          country: { type: 'string', description: 'The chart the accounts belong to (SE = BAS).' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                group: { type: 'string', description: 'The business-event category the codes are children of, e.g. expense.software.' },
                name: { type: 'string' },
                name_en: { type: 'string' },
                categories: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      name: { type: 'string' },
                      name_en: { type: 'string' },
                      accounts: { type: 'array', items: { type: 'string' }, description: 'Typical accounts, the usual one first.' },
                    },
                    required: ['code', 'name', 'accounts'],
                  },
                },
              },
              required: ['group', 'name', 'categories'],
            },
          },
        },
        required: ['version', 'country', 'groups'],
      },
      annotations: deps.readOnly,
      async execute(args) {
        const only = typeof args.group === 'string' ? (args.group as PurchaseCategoryGroup) : null
        const [sv, en] = await Promise.all([loadPurchaseCategoryNames('sv'), loadPurchaseCategoryNames('en')])
        const groups = PURCHASE_CATEGORY_GROUPS.filter((g) => !only || g === only).map((group) => ({
          group,
          name: sv.group(group),
          name_en: en.group(group),
          categories: PURCHASE_CATEGORIES.filter((c) => c.group === group).map((c) => ({
            code: c.code,
            name: sv.category(c.code),
            name_en: en.category(c.code),
            accounts: [...SE_PURCHASE_CATEGORY_PACK.accountsFor(c.code)],
          })),
        }))
        return { version: PURCHASE_CATEGORY_VERSION, country: SE_PURCHASE_CATEGORY_PACK.country, groups }
      },
    },
  ]
}
