/**
 * The Swedish service/goods split of domestic sales per VAT rate that many
 * charts carry under BAS group 30 (crm#1661): 3041-3043 tjänster and
 * 3051-3053 varor at 25, 12 and 6 %. These are common company sub-accounts,
 * not BAS 2026 reference accounts (the reference has 3001-3003 per rate
 * only), so nothing here is ever activated or posted on its own: see
 * lib/invoices/article-type-revenue-account.ts for when a line may use one.
 */
export const ARTICLE_TYPE_SALES_ACCOUNTS = {
  standard_25: { rate: 0.25, tjanst: '3041', vara: '3051' },
  reduced_12: { rate: 0.12, tjanst: '3042', vara: '3052' },
  reduced_6: { rate: 0.06, tjanst: '3043', vara: '3053' },
} as const
