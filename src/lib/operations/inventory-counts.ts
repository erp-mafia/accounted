/**
 * The year-end stock count (inventeringslista, LIV 1955:257) through the
 * machine doors: read the counts, stage a draft (made or changed, rows
 * included) and stage booking the lagerförändring of a signed count. The
 * rules live in lib/bokslut/stock-count; the dashboard's
 * /api/bookkeeping/inventory-counts routes call the same functions.
 *
 * Signing "på heder och samvete" has no door here: a person signs the list
 * in the app, by hand or with BankID. Served as MCP tools only while
 * BOLAGET_COMPANY_IDS is set at module load (registry.ts); run() checks the
 * company against it again, so an operation staged while it was on still
 * answers sensibly.
 */
import { z } from 'zod'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { bookStockCount, previewStockCountBooking } from '@/lib/bokslut/stock-count/booking'
import { StockCountError } from '@/lib/bokslut/stock-count/errors'
import {
  createStockCount,
  listStockCounts,
  loadFiscalPeriod,
  loadStockCountRecord,
  updateStockCount,
  type StockCountRecord,
} from '@/lib/bokslut/stock-count/register'
import { SaveStockCountSchema, StockCountRowSchema } from '@/lib/bokslut/stock-count/schemas'
import { getStockCount } from '@/lib/bokslut/stock-count/signing'
import { stockRowValue } from '@/lib/bokslut/stock-count/valuation'
import { defineOperation, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const STOCK_COUNT_ERRORS = [
  'STOCK_COUNT_DISABLED',
  'STOCK_COUNT_NOT_FOUND',
  'STOCK_COUNT_NO_PERIOD',
  'STOCK_COUNT_ROLL_FORWARD_REQUIRED',
  'STOCK_COUNT_LOCKED',
  'STOCK_COUNT_SIGNING_PENDING',
  'STOCK_COUNT_EMPTY',
  'STOCK_COUNT_NOT_SIGNED',
  'STOCK_COUNT_ALREADY_BOOKED',
  'STOCK_COUNT_ARTICLE_NOT_FOUND',
]

async function guarded<O>(companyId: string, fn: () => Promise<OperationOutcome<O>>): Promise<OperationOutcome<O>> {
  if (!stockCountEnabledFor(companyId)) return { ok: false, code: 'STOCK_COUNT_DISABLED' }
  try {
    return await fn()
  } catch (error) {
    if (error instanceof StockCountError) return { ok: false, code: error.code, details: error.details }
    if (isBookkeepingError(error)) return { ok: false, code: (error as { code: string }).code, error }
    throw error
  }
}

const CountOut = z.object({
  inventory_count_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  balance_date: z.string(),
  count_date: z.string(),
  roll_forward_note: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(['draft', 'signed', 'booked']),
  signer_name: z.string().nullable().describe('Who signed på heder och samvete.'),
  signed_at: z.string().nullable(),
  signed_document_id: z.string().uuid().nullable().describe('The signed copy in the archive.'),
  signing_request_id: z.string().uuid().nullable().describe('Set while (and after) the list went out for BankID signing.'),
  journal_entry_id: z.string().uuid().nullable().describe('The lagerförändring verifikat once booked.'),
  booked_at: z.string().nullable(),
})

const RowOut = z.object({
  position: z.number().int(),
  article_id: z.string().uuid().nullable(),
  description: z.string(),
  category: z.string(),
  unit: z.string().nullable(),
  quantity: z.number(),
  unit_cost: z.number(),
  write_down_percent: z.number(),
  value: z.number(),
})

const TotalOut = z.object({ category: z.string(), cost: z.number(), write_down: z.number(), value: z.number(), rows: z.number().int() })

const AdjustmentOut = z.object({
  category: z.string(),
  stock_account: z.string(),
  change_account: z.string(),
  counted: z.number(),
  ledger: z.number(),
  adjustment: z.number().describe('counted - ledger: positive raises the stock (Dr stock / Cr change).'),
})

const EXAMPLE_COUNT = {
  inventory_count_id: '6b1d…',
  fiscal_period_id: '0c4e…',
  balance_date: '2026-12-31',
  count_date: '2026-12-31',
  roll_forward_note: null,
  note: null,
  status: 'signed',
  signer_name: 'Anna Svensson',
  signed_at: '2027-01-03T09:00:00.000Z',
  signed_document_id: '4f1c…',
  signing_request_id: null,
  journal_entry_id: null,
  booked_at: null,
}

function countOut(record: StockCountRecord) {
  return {
    inventory_count_id: record.id,
    fiscal_period_id: record.fiscal_period_id,
    balance_date: record.balance_date,
    count_date: record.count_date,
    roll_forward_note: record.roll_forward_note,
    note: record.note,
    status: record.status,
    signer_name: record.signer_name,
    signed_at: record.signed_at,
    signed_document_id: record.signed_document_id,
    signing_request_id: record.signing_request_id,
    journal_entry_id: record.journal_entry_id,
    booked_at: record.booked_at,
  }
}

export const inventoryCountsList = defineOperation({
  id: 'inventory-counts.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the year-end stock counts (inventeringslistor), newest first, with their status and total value.',
    description:
      'One count per balansdag is the norm; a draft can be changed, a signed count is frozen, a booked count has its lagerförändring verifikat (journal_entry_id). Filter by fiscal_period_id.',
    useWhen: 'Year-end work: is the stock counted, signed and booked for the year?',
    doNotUseFor: 'Article stock levels: articles are stockless, there is no running stock.',
    pitfalls: ['STOCK_COUNT_DISABLED: the stock count is not switched on for this company.'],
    example: { response: { data: { counts: [{ ...EXAMPLE_COUNT, row_count: 12, total_value: 84250 }] }, meta: META } },
  },
  input: z.object({ fiscal_period_id: z.uuid().optional().describe('Only counts for this fiscal year.') }),
  output: z.object({ counts: z.array(CountOut.extend({ row_count: z.number().int(), total_value: z.number() })) }),
  errorCodes: ['STOCK_COUNT_DISABLED'],
  mcp: {
    name: 'gnubok_list_inventory_counts',
    title: 'List Inventory Counts',
    description: 'List year-end stock counts (inventeringslistor) with status (draft, signed, booked) and total value; filter by fiscal_period_id.',
    visibility: 'search',
    keywords: ['inventering', 'varulager', 'inventeringslista', 'lagervärde', 'lagerinventering bokslut'],
  },
  run: (ctx, input) =>
    guarded(ctx.companyId, async () => {
      const counts = await listStockCounts(ctx.supabase, ctx.companyId, { fiscalPeriodId: input.fiscal_period_id })
      return { ok: true, data: { counts: counts.map((c) => ({ ...countOut(c), row_count: c.row_count, total_value: c.total_value })) } }
    }),
})

export const inventoryCountsGet = defineOperation({
  id: 'inventory-counts.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one stock count: every row with its value, the totals per kind of stock, and for a signed count the lagerförändring it would book.',
    description:
      'Each row is valued at quantity x unit cost less its write-down to net realisable value (ÅRL 4:9). booking (signed counts only) compares the counted value per kind with the ledger balance on its BAS 14xx accounts at balansdagen and names the 49xx lagerförändring lines.',
    useWhen: 'You need the list itself, or to see what booking a signed count would post.',
    doNotUseFor: 'Listing counts (gnubok_list_inventory_counts).',
    pitfalls: ['booking is null until the count is signed.'],
    example: { response: { data: { count: EXAMPLE_COUNT, rows: [], totals: [], total_value: 0, booking: null }, meta: META } },
  },
  input: z.object({ inventory_count_id: z.uuid().describe('The count (id).') }),
  output: z.object({
    count: CountOut,
    rows: z.array(RowOut),
    totals: z.array(TotalOut),
    total_value: z.number(),
    booking: z.object({ counted_total: z.number(), ledger_total: z.number(), adjustments: z.array(AdjustmentOut) }).nullable(),
  }),
  errorCodes: ['STOCK_COUNT_DISABLED', 'STOCK_COUNT_NOT_FOUND'],
  mcp: {
    name: 'gnubok_get_inventory_count',
    title: 'Get Inventory Count',
    description: 'Read one stock count: rows, totals per kind of stock and, once signed, the lagerförändring it would book against the ledger.',
    visibility: 'search',
    keywords: ['inventeringslista', 'lagerförändring', 'varulager värde', 'inkurans'],
  },
  run: (ctx, input) =>
    guarded(ctx.companyId, async () => {
      const view = await getStockCount(ctx.supabase, ctx.companyId, ctx.userId, input.inventory_count_id)
      const booking = view.status === 'signed'
        ? await previewStockCountBooking(ctx.supabase, ctx.companyId, view.id, { record: view })
        : null
      return {
        ok: true,
        data: {
          count: countOut(view),
          rows: view.rows.map(({ id: _id, ...row }) => row),
          totals: view.totals,
          total_value: view.total_value,
          booking: booking
            ? { counted_total: booking.counted_total, ledger_total: booking.ledger_total, adjustments: booking.adjustments }
            : null,
        },
      }
    }),
})

export const inventoryCountsSave = defineOperation({
  id: 'inventory-counts.save',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Make a draft stock count for a fiscal year, or change a draft: dates, notes and every row (the rows given replace the old ones).',
    description:
      'Each row: description, quantity, unit_cost (cost per unit excl. VAT), optional write_down_percent (to net realisable value), unit, article_id and category (goods_for_resale by default). Values are computed here, rounded to öre. balansdagen is the fiscal year\'s last day; a count_date on another day needs roll_forward_note (LIV 1 §). Only a draft not out for signing changes. Dry-runnable.',
    useWhen: 'Entering or correcting the year-end count from a spreadsheet or a counted list.',
    doNotUseFor: 'Signing (a person signs in the app) or booking (gnubok_book_inventory_count).',
    pitfalls: [
      'STOCK_COUNT_ROLL_FORWARD_REQUIRED: count_date is not balansdagen and roll_forward_note is missing.',
      'STOCK_COUNT_LOCKED: the count is signed; make a new draft instead.',
      'STOCK_COUNT_SIGNING_PENDING: the list is out for BankID signing.',
    ],
    example: {
      request: {
        fiscal_period_id: '0c4e…',
        count_date: '2026-12-31',
        rows: [{ description: 'Kaffe 500 g', quantity: 120, unit_cost: 42.5, unit: 'st' }],
      },
      response: { data: { count: { ...EXAMPLE_COUNT, status: 'draft', signer_name: null, signed_at: null }, total_value: 5100, row_count: 1 }, meta: META },
    },
  },
  input: SaveStockCountSchema.extend({
    inventory_count_id: z.uuid().optional().describe('Change this draft; omitted, a new draft is made.'),
  }).strict(),
  output: z.object({ count: CountOut, total_value: z.number(), row_count: z.number().int() }),
  errorCodes: [...STOCK_COUNT_ERRORS],
  mcp: {
    name: 'gnubok_save_inventory_count',
    title: 'Save Inventory Count',
    description:
      'Stage a draft year-end stock count (inventeringslista) or a change to one: count date, roll-forward note and every row (quantity, unit cost, write-down). A person signs it in Accounted.',
    visibility: 'search',
    keywords: ['inventering', 'inventeringslista', 'varulager', 'lagerinventering', 'lägsta värdets princip'],
    stage: {
      pendingType: 'save_inventory_count',
      title: (input) => {
        const rows = Array.isArray(input.rows) ? input.rows.length : 0
        return input.inventory_count_id ? `Ändra inventeringslista (${rows} rader)` : `Ny inventeringslista (${rows} rader)`
      },
    },
  },
  run: (ctx, input, { dryRun }) =>
    guarded(ctx.companyId, async () => {
      const { inventory_count_id: id, ...body } = input
      if (dryRun) {
        const period = await loadFiscalPeriod(ctx.supabase, ctx.companyId, body.fiscal_period_id)
        if (body.count_date !== period.period_end && !body.roll_forward_note?.trim()) {
          return { ok: false, code: 'STOCK_COUNT_ROLL_FORWARD_REQUIRED', details: { balance_date: period.period_end } }
        }
        if (id) {
          const current = await loadStockCountRecord(ctx.supabase, ctx.companyId, id)
          if (current.status !== 'draft') return { ok: false, code: 'STOCK_COUNT_LOCKED' }
          if (current.signing_request_id) return { ok: false, code: 'STOCK_COUNT_SIGNING_PENDING' }
        }
        const rows = body.rows.map((r) => StockCountRowSchema.parse(r))
        const values = rows.map((r) => stockRowValue(r))
        return {
          ok: true,
          dryRun: true,
          preview: {
            inventory_count_id: id ?? null,
            fiscal_period_id: period.id,
            balance_date: period.period_end,
            count_date: body.count_date,
            row_count: rows.length,
            rows: rows.map((r, i) => ({ description: r.description, quantity: r.quantity, unit_cost: r.unit_cost, write_down_percent: r.write_down_percent, value: values[i] })),
          },
        }
      }
      const view = id
        ? await updateStockCount(ctx.supabase, ctx.companyId, id, body)
        : await createStockCount(ctx.supabase, ctx.companyId, ctx.userId, body)
      return { ok: true, data: { count: countOut(view), total_value: view.total_value, row_count: view.rows.length } }
    }),
})

export const inventoryCountsBook = defineOperation({
  id: 'inventory-counts.book',
  kind: 'write',
  scope: 'bookkeeping:write',
  // Posts a bokslut verifikat (14xx against 49xx) that changes the year's
  // result; undone only by a storno.
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Book the lagerförändring of a signed stock count on balansdagen: counted value per kind of stock against the ledger, one verifikat.',
    description:
      'For each kind of stock (råvaror 1410/4910, förnödenheter 1420/4920, produkter i arbete 1440/4940, färdiga varor 1450/4950, handelsvaror 1460/4960) the counted value is compared with the ledger balance at balansdagen and the difference is booked on the stock account against its förändring account. Once per fiscal year; a closed or locked year refuses. The signed list becomes the verifikat\'s underlag. Dry-runnable: the dry run answers the adjustments.',
    useWhen: 'The count is signed and the year-end books need the stock value.',
    doNotUseFor: 'An unsigned count (a person signs it first in Accounted).',
    pitfalls: [
      'STOCK_COUNT_NOT_SIGNED: the list is not signed på heder och samvete yet.',
      'STOCK_COUNT_ALREADY_BOOKED: the year already has a booked count.',
      'A kind the ledger holds but the list lacks is counted as nothing and written down to zero.',
    ],
    example: {
      request: { inventory_count_id: '6b1d…' },
      response: { data: { inventory_count_id: '6b1d…', journal_entry_id: 'c41d…', adjustments: [] }, meta: META },
    },
  },
  input: z.object({ inventory_count_id: z.uuid().describe('The signed count.') }).strict(),
  output: z.object({
    inventory_count_id: z.string().uuid(),
    journal_entry_id: z.string().uuid().nullable().describe('Null when the ledger already held the counted value.'),
    adjustments: z.array(AdjustmentOut),
  }),
  errorCodes: [...STOCK_COUNT_ERRORS],
  mcp: {
    name: 'gnubok_book_inventory_count',
    title: 'Book Inventory Count',
    description:
      'Stage booking the lagerförändring of a signed stock count on balansdagen: counted value per kind against the 14xx ledger balance, against 49xx. Once per fiscal year.',
    visibility: 'search',
    keywords: ['bokför lagerförändring', 'lagerförändring bokslut', 'varulager bokföring', 'inventering bokför'],
    stage: { pendingType: 'book_inventory_count', title: () => 'Bokför lagerförändring enligt inventering' },
  },
  run: (ctx, input, { dryRun }) =>
    guarded(ctx.companyId, async () => {
      if (dryRun) {
        const record = await loadStockCountRecord(ctx.supabase, ctx.companyId, input.inventory_count_id)
        if (record.status === 'booked') return { ok: false, code: 'STOCK_COUNT_ALREADY_BOOKED' }
        if (record.status !== 'signed') return { ok: false, code: 'STOCK_COUNT_NOT_SIGNED' }
        const preview = await previewStockCountBooking(ctx.supabase, ctx.companyId, record.id, { record })
        return {
          ok: true,
          dryRun: true,
          preview: {
            inventory_count_id: record.id,
            balance_date: record.balance_date,
            counted_total: preview.counted_total,
            ledger_total: preview.ledger_total,
            adjustments: preview.adjustments,
            lines: preview.lines,
          },
        }
      }
      const result = await bookStockCount(ctx.supabase, ctx.companyId, ctx.userId, input.inventory_count_id)
      return {
        ok: true,
        data: { inventory_count_id: result.count.id, journal_entry_id: result.entry?.id ?? null, adjustments: result.preview.adjustments },
      }
    }),
})

/** Registered as MCP tools only while BOLAGET_COMPANY_IDS is set (registry.ts). */
export const STOCK_COUNT_OPERATION_LIST = [
  inventoryCountsList,
  inventoryCountsGet,
  inventoryCountsSave,
  inventoryCountsBook,
] as const
