/**
 * Recurring invoice schedule operations (återkommande fakturor): list the
 * company's schedules, create one, change one. One definition behind the v1
 * endpoints and the MCP tools gnubok_list_recurring_schedules,
 * gnubok_create_recurring_schedule and gnubok_update_recurring_schedule; the
 * rules live in lib/invoices/recurring-schedule-actions.ts.
 *
 * The writes stage over MCP, and over v1 with ?stage=true: a key that may not
 * approve proposes the schedule or the change, and a person approves it in the
 * app. A schedule with auto_send emails every invoice it creates without any
 * further approval, so its proposal stages at high risk (risk-tiers.ts).
 *
 * The field rules are the dashboard's (lib/api/schemas.ts); this module adds
 * what an agent and an API client read about each field. Over MCP a dimension
 * value may be given by its name: the MCP server resolves it to the code
 * before the operation runs and names what it resolved in the preview. The
 * operation itself takes codes, as v1 does.
 */
import { z } from 'zod'
import {
  CreateRecurringScheduleObjectSchema,
  RecurringScheduleItemSchema,
  UpdateRecurringScheduleObjectSchema,
  refineCreateRecurringSchedule,
  refineUpdateRecurringSchedule,
} from '@/lib/api/schemas'
import {
  createRecurringSchedule,
  listRecurringSchedules,
  updateRecurringSchedule,
} from '@/lib/invoices/recurring-schedule-actions'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const PLACEHOLDERS =
  'Placeholders in notes and line descriptions are filled in when each invoice is created: {månad} {nästa månad} {föregående månad} {år} (month names in the customer\'s language) and, with a period_start, {periodstart} {periodslut} (last day of the period) {nästa periodstart}.'

const DIMENSIONS =
  'Tags {"<sie_dim_no>":"<code>"}, e.g. {"6":"P001"}, codes from GET /dimensions (over MCP a value\'s name resolves to its code). Never created on the fly.'

/** A template line, with what each field means to the invoices the schedule creates. */
const ScheduleLine = RecurringScheduleItemSchema.safeExtend({
  line_type: RecurringScheduleItemSchema.shape.line_type.describe(
    'product (default), or text: a free-text or blank row copied onto every invoice, description only, amounts ignored, never booked. At least one product row is required.',
  ),
  description: RecurringScheduleItemSchema.shape.description.describe('The line text. May use the placeholders listed under notes.'),
  unit: RecurringScheduleItemSchema.shape.unit.describe('st, tim, dag, mån. Default st.'),
  unit_price: RecurringScheduleItemSchema.shape.unit_price.describe('Price per unit excl. VAT.'),
  vat_rate: RecurringScheduleItemSchema.shape.vat_rate.describe(
    'Omitted or null: the customer\'s default rate at each run. A rate outside that default set (non-zero to a foreign business) bills the default.',
  ),
  dimensions: RecurringScheduleItemSchema.shape.dimensions.describe(`${DIMENSIONS} Wins per key over default_dimensions.`),
  article_id: RecurringScheduleItemSchema.shape.article_id.describe(
    'An article of the company (GET /articles, gnubok_list_articles): the line books to its account and, without vat_rate, at its rate.',
  ),
})

const C = CreateRecurringScheduleObjectSchema.shape

const CreateInput = CreateRecurringScheduleObjectSchema.extend({
  customer_id: C.customer_id.describe('The customer the invoices go to (GET /customers, gnubok_list_customers).'),
  name: C.name.describe('Internal name of the schedule, not printed on the invoice.'),
  day_of_month: C.day_of_month.describe('Day the invoice is created; 29-31 clamp to the last day in shorter months.'),
  interval_months: C.interval_months.describe('Months between invoices, any whole number 1-12. Default 1 (monthly); 3 = quarterly, 6 = half-yearly, 12 = yearly.'),
  send_hour: C.send_hour.describe('Whole hour (0-23) in Europe/Stockholm time at which the schedule runs. Default 8.'),
  payment_terms_days: C.payment_terms_days.describe('due_date = invoice_date + these days. Default 30.'),
  currency: C.currency.describe('Default SEK.'),
  notes: C.notes.describe(`Printed on every invoice the schedule creates. ${PLACEHOLDERS}`),
  auto_send: C.auto_send.describe(
    'Default false: every invoice is created as a draft for a person to send. true emails each invoice to the customer with no further approval; the customer needs an email address.',
  ),
  default_dimensions: C.default_dimensions.describe(`${DIMENSIONS} Copied onto every invoice.`),
  start_date: C.start_date.describe(
    'YYYY-MM-DD of the first run; fixes the month phase of a quarterly or yearly schedule (2027-02-15 with interval_months 12 = every February). Must fall on day_of_month (clamped in shorter months) and not be in the past. Omitted: the next occurrence of day_of_month.',
  ),
  period_start: C.period_start.describe(
    'YYYY-MM-DD, first day of the billing period the first invoice covers; moves on by interval_months after every run. Needed for {periodstart}, {periodslut} and {nästa periodstart}.',
  ),
  items: z.array(ScheduleLine).min(1, 'At least one item is required').describe('Template lines copied onto every invoice.'),
})
  .strict()
  .superRefine(refineCreateRecurringSchedule)

const U = UpdateRecurringScheduleObjectSchema.shape

const SCHEDULE_ID = z
  .string()
  .uuid()
  .describe('The schedule (recurring_schedule_id from GET /recurring-invoice-schedules or gnubok_list_recurring_schedules).')

/** The fields an update may change: at least one of them. */
const UpdateInput = UpdateRecurringScheduleObjectSchema.extend({
  schedule_id: SCHEDULE_ID,
  customer_id: U.customer_id.describe('Move the schedule to another customer of the company.'),
  day_of_month: U.day_of_month.describe('1-31, clamped in shorter months. A change moves next_run_date to the next run on the new day.'),
  interval_months: U.interval_months.describe('Months between invoices, 1-12. A change alone leaves next_run_date as it is.'),
  send_hour: U.send_hour.describe('Whole hour (0-23) in Europe/Stockholm time.'),
  your_reference: U.your_reference.describe('null clears it.'),
  our_reference: U.our_reference.describe('null clears it.'),
  notes: U.notes.describe(`null clears it. ${PLACEHOLDERS}`),
  period_start: U.period_start.describe(
    'YYYY-MM-DD, first day of the billing period the NEXT invoice covers; moves on by interval_months after every run. null clears it (the period placeholders may then not be used).',
  ),
  auto_send: U.auto_send.describe(
    'true emails every invoice with no further approval (the customer needs an email address); false returns to drafts.',
  ),
  status: U.status.describe(
    'paused stops creating invoices; active resumes. Resuming from a date that has passed moves next_run_date to the next future run, never today.',
  ),
  next_run_date: U.next_run_date.describe(
    'YYYY-MM-DD of the next run; re-phases the schedule (move a yearly invoice to February). Must fall on the day_of_month in effect (clamped in shorter months) and be after today in Europe/Stockholm. Wins over the automatic move.',
  ),
  default_dimensions: U.default_dimensions.describe(`${DIMENSIONS} Replaces the whole bag; {} clears every tag. Omit to keep.`),
  items: z
    .array(ScheduleLine)
    .min(1)
    .optional()
    .describe('Replaces ALL lines (send each back with its article_id); omit to keep them.'),
})
  .strict()
  .superRefine(refineUpdateRecurringSchedule)
  .superRefine((input, ctx) => {
    const { schedule_id: _id, ...changes } = input
    if (Object.values(changes).every((value) => value === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'At least one schedule field must be supplied' })
    }
  })

const ListedLine = z.object({
  line_type: z.string().describe('product or text.'),
  description: z.string(),
  quantity: z.number(),
  unit: z.string(),
  unit_price: z.number(),
  vat_rate: z.number().nullable().describe('null: the customer\'s default rate at each run.'),
  dimensions: z.record(z.string(), z.string()).describe('This line\'s tags; win per key over default_dimensions.'),
  article_id: z.string().uuid().nullable(),
})

const ListedSchedule = z.object({
  recurring_schedule_id: z.string().uuid(),
  name: z.string(),
  status: z.enum(['active', 'paused']),
  customer_id: z.string().uuid(),
  customer_name: z.string().nullable(),
  day_of_month: z.number().int().describe('1-31; clamps to the last day in shorter months.'),
  interval_months: z.number().int().describe('Months between runs, 1-12 (3 = quarterly, 12 = yearly).'),
  send_hour: z.number().int().describe('Whole hour 0-23 in Europe/Stockholm time.'),
  payment_terms_days: z.number().int(),
  currency: z.string(),
  auto_send: z.boolean().describe('true: every invoice is emailed with no further approval.'),
  next_run_date: z.string(),
  period_start: z.string().nullable().describe('First day of the billing period the next invoice covers; null: no period.'),
  last_run_at: z.string().nullable(),
  last_invoice_id: z.string().uuid().nullable().describe('The invoice the last run created.'),
  last_run_warning: z.string().nullable(),
  generated_count: z.number().int(),
  monthly_total_excl_vat: z.number().describe('What one run bills excl. VAT: the product lines, text rows aside.'),
  default_dimensions: z.record(z.string(), z.string()).describe('Tags copied onto every invoice the schedule creates.'),
  items: z.array(ListedLine),
})

const EXAMPLE_SCHEDULE = {
  recurring_schedule_id: '5c2d…',
  name: 'Månadsavgift support',
  status: 'active',
  customer_id: '0a1b…',
  customer_name: 'Kunden AB',
  day_of_month: 25,
  interval_months: 1,
  send_hour: 8,
  payment_terms_days: 30,
  currency: 'SEK',
  auto_send: false,
  next_run_date: '2026-12-25',
  period_start: null,
  last_run_at: '2026-11-25T07:00:12Z',
  last_invoice_id: '9e8f…',
  last_run_warning: null,
  generated_count: 4,
  monthly_total_excl_vat: 5000,
  default_dimensions: {},
  items: [
    { line_type: 'product', description: 'Support {månad}', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: null, dimensions: {}, article_id: null },
  ],
}

export const recurringInvoiceSchedulesList = defineOperation({
  id: 'recurring-invoice-schedules.list',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s recurring invoice schedules, newest first.',
    description:
      'Each schedule creates a customer invoice on day_of_month (clamped to the last day in shorter months) every interval_months months at send_hour, Europe/Stockholm, from its template lines. Answers status, auto_send, next_run_date, the last run and its invoice, the lines in their order and what one run bills excl. VAT. Filter by status. Paged with limit and offset: total_count, has_more and next_offset say what is left.',
    useWhen: 'Before changing a schedule (its recurring_schedule_id and lines), or to see what will be invoiced and when.',
    doNotUseFor: 'The invoices a schedule created (GET /invoices), or a schedule\'s run history in detail.',
    pitfalls: [
      'Send a line back with its article_id when you replace the lines: a line without it loses the link to its article.',
      'next_run_date is a day in Europe/Stockholm; the run happens at send_hour that day.',
    ],
    example: { response: { data: { schedules: [EXAMPLE_SCHEDULE], count: 1, total_count: 1, has_more: false }, meta: META } },
  },
  input: z.object({
    status: z.enum(['active', 'paused']).optional().describe('Only active or only paused schedules. Default both.'),
    limit: z.coerce.number().int().min(1).max(100).default(50).describe('Schedules per page, 1-100. Default 50.'),
    offset: z.coerce.number().int().min(0).default(0).describe('Schedules to skip: next_offset of the previous page. Default 0.'),
  }),
  output: z.object({
    schedules: z.array(ListedSchedule),
    count: z.number().int().describe('Schedules on this page.'),
    total_count: z.number().int(),
    has_more: z.boolean(),
    next_offset: z.number().int().optional().describe('Pass as offset for the next page; absent on the last page.'),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/recurring-invoice-schedules' },
  mcp: {
    name: 'gnubok_list_recurring_schedules',
    title: 'List Recurring Invoice Schedules',
    description:
      "List the company's recurring invoice schedules: auto-create customer invoices on day_of_month (clamps to the last day in shorter months) every interval_months months (1-12) at send_hour, Europe/Stockholm. Shows status, auto_send and next_run_date.",
    keywords: ['återkommande fakturor', 'stående faktura', 'abonnemang'],
  },
  run: (ctx, input) => listRecurringSchedules(ctx, input),
})

export const recurringInvoiceSchedulesCreate = defineOperation({
  id: 'recurring-invoice-schedules.create',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Create a recurring invoice schedule: a customer invoice from the same lines every interval_months months.',
    description:
      'The schedule creates a customer invoice on day_of_month (29-31 clamp to the last day in shorter months) every interval_months months at send_hour, Europe/Stockholm, from its template lines, first on start_date or the next occurrence of day_of_month. With auto_send false (the default) each invoice is a draft for a person to send; with auto_send true each one is numbered, issued and emailed to the customer with no further approval. ?stage=true proposes the schedule for a person to approve instead of creating it. Dry-runnable: the preview names the first run and what one run bills.',
    useWhen: 'The customer is invoiced the same thing on a fixed rhythm: a subscription, a retainer, rent or a support agreement.',
    doNotUseFor: 'A single invoice (POST /invoices), or changing a schedule that exists (PATCH /recurring-invoice-schedules/{id}).',
    pitfalls: [
      'auto_send true needs a customer with an email address, else 400 VALIDATION_ERROR (details.field auto_send). Its proposal is high risk: approving it lets every run email an invoice.',
      'start_date off the grid (not on day_of_month, clamped) or in the past answers 400 VALIDATION_ERROR (details.field start_date).',
      'A line\'s article_id must be one of the company\'s articles (400, details.field items); {periodstart}, {periodslut} and {nästa periodstart} need period_start.',
      'Over MCP the schedule is always staged: nothing exists until a person approves it.',
    ],
    example: {
      request: {
        customer_id: '0a1b…',
        name: 'Månadsavgift support',
        day_of_month: 25,
        items: [{ description: 'Support {månad}', quantity: 1, unit: 'st', unit_price: 5000 }],
      },
      response: {
        data: {
          recurring_schedule_id: '5c2d…',
          name: 'Månadsavgift support',
          customer_id: '0a1b…',
          day_of_month: 25,
          interval_months: 1,
          send_hour: 8,
          currency: 'SEK',
          auto_send: false,
          status: 'active',
          next_run_date: '2026-12-25',
          item_count: 1,
        },
        meta: META,
      },
    },
  },
  input: CreateInput,
  output: z.object({
    recurring_schedule_id: z.string().uuid(),
    name: z.string(),
    customer_id: z.string().uuid(),
    day_of_month: z.number().int(),
    interval_months: z.number().int(),
    send_hour: z.number().int(),
    currency: z.string(),
    auto_send: z.boolean(),
    status: z.literal('active'),
    next_run_date: z.string().describe('The first run, YYYY-MM-DD.'),
    item_count: z.number().int(),
  }),
  errorCodes: ['CUSTOMER_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/recurring-invoice-schedules' },
  mcp: {
    name: 'gnubok_create_recurring_schedule',
    title: 'Create Recurring Invoice Schedule',
    description:
      'Stage a new recurring invoice schedule: creates a customer invoice on day_of_month (clamps to the last day in shorter months) every interval_months months (default 1) at send_hour, Europe/Stockholm. auto_send defaults false; true emails each invoice without new approval.',
    keywords: ['återkommande faktura', 'stående faktura', 'abonnemang'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'create_recurring_schedule',
      title: (input) => `Nytt återkommande fakturaschema: ${String(input.name ?? '')}`,
      extras: () => ({
        next: {
          description: 'Once approved, verify the schedule with gnubok_list_recurring_schedules; the hourly cron creates invoices from next_run_date.',
          tool: 'gnubok_list_recurring_schedules',
        },
      }),
    },
  },
  run: (ctx, input, { dryRun }) => createRecurringSchedule(ctx, input, { dryRun }),
})

export const recurringInvoiceSchedulesUpdate = defineOperation({
  id: 'recurring-invoice-schedules.update',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Change a recurring invoice schedule: its fields, its status (pause or resume) or all of its lines.',
    description:
      'Changes only the fields given; items replaces every line. status paused stops the schedule, active resumes it. A new day_of_month, or resuming a schedule whose next_run_date has passed, moves next_run_date to the next run strictly after today (never today, so no edit sends an invoice the same hour); next_run_date given re-phases the schedule and wins. Any other change leaves next_run_date alone. ?stage=true proposes the change for a person to approve instead of making it. Dry-runnable: the preview shows the schedule as it is (current), the changes and the schedule as it would be (proposed).',
    useWhen: 'A price, a line, the rhythm or the customer of a schedule changes, or the schedule should pause or resume.',
    doNotUseFor: 'Creating a schedule (POST /recurring-invoice-schedules), or changing an invoice a schedule already created (PATCH /invoices/{id}).',
    pitfalls: [
      'An unknown schedule_id answers 404 RECURRING_SCHEDULE_NOT_FOUND.',
      'next_run_date off the grid of the day_of_month in effect, or not after today, answers 400 VALIDATION_ERROR (details.field next_run_date). A proposal approved after its next_run_date passed rolls it forward on the same grid.',
      'Turning auto_send on, or moving an auto-sending schedule to another customer, needs that customer\'s email address (400, details.field auto_send); the proposal is then high risk.',
      'items replaces every line: send the ones to keep too, each with its article_id.',
    ],
    example: {
      request: { status: 'paused' },
      response: {
        data: { recurring_schedule_id: '5c2d…', status: 'paused', updated_fields: ['status'], items_replaced: false },
        meta: META,
      },
    },
  },
  input: UpdateInput,
  output: z.object({
    recurring_schedule_id: z.string().uuid(),
    status: z.enum(['active', 'paused']),
    updated_fields: z.array(z.string()).describe('The schedule fields written, next_run_date included when it moved.'),
    items_replaced: z.boolean(),
    item_count: z.number().int().optional().describe('With items_replaced: the lines the schedule now has.'),
    next_run_date: z.string().optional().describe('When it was written: the next run, YYYY-MM-DD.'),
  }),
  errorCodes: ['RECURRING_SCHEDULE_NOT_FOUND', 'CUSTOMER_NOT_FOUND', 'VALIDATION_ERROR', 'INVOICE_RECURRING_UPDATE_PARTIAL'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/recurring-invoice-schedules/:id',
    pathParams: { id: 'schedule_id' },
  },
  mcp: {
    name: 'gnubok_update_recurring_schedule',
    title: 'Update Recurring Invoice Schedule',
    description:
      'Stage an update to a recurring invoice schedule (schedule_id from gnubok_list_recurring_schedules). status pauses/resumes; items replace all lines; day_of_month clamps to the last day in shorter months; next_run_date re-phases; send_hour is Europe/Stockholm.',
    keywords: ['återkommande faktura', 'stående faktura', 'pausa schema', 'ändra schema'],
    hints: { idempotent: true },
    stage: {
      pendingType: 'update_recurring_schedule',
      title: (_input, preview) =>
        `Uppdatera återkommande fakturaschema: ${String((preview?.current as { name?: unknown } | undefined)?.name ?? '')}`,
      // A proposal staged before this operation carries its fields under
      // `changes` ({ schedule_id, changes: {...} }). Remove this upgrade 30
      // days after the switch reached production, once no pending row of
      // the type is older than the switch.
      upgradeParams: (params) => {
        const { changes, ...rest } = params
        return changes && typeof changes === 'object' && !Array.isArray(changes)
          ? { ...rest, ...(changes as Record<string, unknown>) }
          : params
      },
    },
  },
  run: (ctx, input, { dryRun }) => updateRecurringSchedule(ctx, input, { dryRun }),
})

export const RECURRING_INVOICE_SCHEDULE_OPERATIONS = [
  recurringInvoiceSchedulesList,
  recurringInvoiceSchedulesCreate,
  recurringInvoiceSchedulesUpdate,
] as const
