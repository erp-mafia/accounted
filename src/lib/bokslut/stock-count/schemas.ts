import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { STOCK_CATEGORIES } from './valuation'

/** At most this many rows on one list (the PDF and the booking stay quick). */
export const STOCK_COUNT_MAX_ROWS = 5000

export const StockCountRowSchema = z.object({
  description: z.string().trim().min(1).max(300).describe('What the item is, as the list names it.'),
  article_id: z.uuid().nullish().describe('The article (artikelregister) it is, when it is one.'),
  category: z.enum(STOCK_CATEGORIES).default('goods_for_resale')
    .describe('The kind of stock: raw_materials, supplies, work_in_progress, finished_goods or goods_for_resale (default).'),
  unit: z.string().trim().max(20).nullish().describe('Unit, e.g. st, kg.'),
  quantity: z.number().min(0).max(1_000_000_000).describe('The counted quantity.'),
  unit_cost: z.number().min(0).max(1_000_000_000).describe('Cost per unit (anskaffningsvärde, SEK, excl. VAT).'),
  write_down_percent: z.number().min(0).max(100).default(0)
    .describe('Write-down to net realisable value in percent of cost (inkurans), 0 when none.'),
})

export type StockCountRowBody = z.input<typeof StockCountRowSchema>

/** A new or changed draft count: its dates, notes and every row (the rows replace the old ones). */
export const SaveStockCountSchema = z
  .object({
    fiscal_period_id: z.uuid().describe('The fiscal year whose balansdag the count is for.'),
    count_date: isoDateSchema.describe('The day the stock was counted.'),
    roll_forward_note: z.string().trim().max(4000).nullish()
      .describe('Required when count_date is not balansdagen: how the count was rolled forward to it (LIV 1 §).'),
    note: z.string().trim().max(2000).nullish(),
    rows: z.array(StockCountRowSchema).max(STOCK_COUNT_MAX_ROWS),
  })
  .strict()

export type SaveStockCountBody = z.input<typeof SaveStockCountSchema>

/** Signed by hand: the name and day on the paper list, optionally with its scan. */
export const SignStockCountSchema = z.object({
  signer_name: z.string().trim().min(1).max(200),
  signed_on: isoDateSchema,
})

export const BankIdStockCountSchema = z.object({
  signer_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254).nullish(),
})

export const BookStockCountSchema = z.object({}).strict()
