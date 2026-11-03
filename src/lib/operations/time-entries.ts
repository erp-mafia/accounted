/**
 * Time-entry operations (tidrapportering): reads over the hours registered
 * per customer, project and consultant. Rules live in
 * lib/time-tracking/service.ts, shared with the time-tracking extension's
 * dashboard routes. Writes stage over MCP: nothing is registered until a
 * person approves the preview, which names every resolved reference.
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import {
  listTimeCodes,
  listTimeEntries,
  summarizeTimeEntries,
  TIME_ENTRY_LIST_LIMIT_MAX,
} from '@/lib/time-tracking/service'
import { MAX_HOURS_PER_ENTRY } from '@/lib/time-tracking/types'
import type { TimeEntry as TimeEntryRecord } from '@/lib/time-tracking/types'
import { createTimeEntries, deleteTimeEntry, pinnedEntryInput, updateTimeEntry } from '@/lib/time-tracking/writes'
import { invoiceTimeEntries, TIME_INVOICE_MAX_ENTRIES } from '@/lib/time-tracking/invoice'
import type { TimeInvoicePreview } from '@/lib/time-tracking/invoice'
import type { CreateTimeEntriesPreview, UpdateTimeEntryPreview } from '@/lib/time-tracking/writes'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const TimeEntry = z.object({
  time_entry_id: z.string().uuid(),
  entry_date: z.string(),
  consultant: z.string(),
  customer_id: z.string().uuid().nullable(),
  customer_code: z.string().nullable(),
  customer_name: z.string().nullable(),
  project_code: z.string().nullable(),
  activity_code: z.string().nullable(),
  hours: z.number(),
  comment: z.string().nullable(),
  is_billable: z.boolean(),
  invoice_id: z.string().uuid().nullable(),
  invoiced_externally: z.boolean(),
  source: z.enum(['manual', 'import']),
  created_at: z.string(),
  updated_at: z.string(),
})

/** company_id, user_id and import_key are internal: the doors answer the documented shape. */
const toOutputEntry = ({ id, company_id: _c, user_id: _u, import_key: _k, ...e }: TimeEntryRecord) => ({
  time_entry_id: id,
  ...e,
})

const Totals = {
  hours: z.number(),
  billable_hours: z.number(),
  uninvoiced_billable_hours: z.number(),
  uninvoiced_amount: z.number().nullable(),
}

const filters = {
  from: saneIsoDateSchema.optional().describe('First entry date, inclusive (YYYY-MM-DD).'),
  to: saneIsoDateSchema.optional().describe('Last entry date, inclusive (YYYY-MM-DD).'),
  customer_id: z.string().uuid().optional().describe('Only hours on this Accounted customer.'),
  customer_code: z.string().trim().min(1).max(40).optional().describe('Only hours on this imported customer code, linked or not.'),
  consultant: z.string().trim().min(1).max(20).optional().describe('Only hours by this consultant (initials, e.g. "AB").'),
  project_code: z.string().trim().min(1).max(40).optional().describe('Only hours on this project (SIE dimension 6 code).'),
  uninvoiced: z
    .enum(['true', 'false'])
    .optional()
    .describe('"true" keeps only billable hours not yet on an invoice.'),
}

const toFilters = <T extends { uninvoiced?: 'true' | 'false' }>({ uninvoiced, ...rest }: T) => ({
  ...rest,
  uninvoiced: uninvoiced === 'true',
})

export const timeEntriesList = defineOperation({
  id: 'time-entries.list',
  kind: 'read',
  scope: 'time:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List registered hours (tidrader), newest first.',
    description:
      'Returns time entries newest first: date, consultant, customer, project, activity code, hours, billable flag and the invoice they were billed on (or invoiced_externally for hours billed outside Accounted). Filter by date range, customer, consultant, project or uninvoiced. Offset pagination: pass next_offset back as offset; it is null on the last page.',
    useWhen: 'Checking what was logged on a day, a customer or a project, or finding hours that are not invoiced yet.',
    doNotUseFor: 'Totals per customer, project or consultant (GET /time-entries/summary).',
    pitfalls: [
      'customer_id is null for imported hours whose customer code is not linked to an Accounted customer; filter those by customer_code.',
      'customer_name is the linked customer\'s current name when linked, otherwise the name from the imported report.',
      'hours are decimal hours: 1.5 is one hour and thirty minutes.',
    ],
    example: {
      request: { from: '2026-10-01', to: '2026-10-31', consultant: 'AB' },
      response: {
        data: {
          entries: [
            {
              time_entry_id: '7a2e…',
              entry_date: '2026-10-14',
              consultant: 'AB',
              customer_id: '51c0…',
              customer_code: 'GF',
              customer_name: 'Galärbryggan AB',
              project_code: 'P12',
              activity_code: '1',
              hours: 3.5,
              comment: 'Månadsavstämning',
              is_billable: true,
              invoice_id: null,
              invoiced_externally: false,
              source: 'manual',
              created_at: '2026-10-14T15:02:11Z',
              updated_at: '2026-10-14T15:02:11Z',
            },
          ],
          total: 1,
          has_more: false,
          next_offset: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    ...filters,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TIME_ENTRY_LIST_LIMIT_MAX)
      .optional()
      .describe(`Page size, 1-${TIME_ENTRY_LIST_LIMIT_MAX} (default 100).`),
    offset: z.coerce.number().int().min(0).optional().describe('next_offset from the previous page. Omit for the first page.'),
  }),
  output: z.object({
    entries: z.array(TimeEntry),
    total: z.number().int(),
    has_more: z.boolean(),
    next_offset: z.number().int().nullable(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/time-entries' },
  mcp: {
    name: 'gnubok_list_time_entries',
    title: 'List Time Entries',
    description:
      'List registered hours (tidrader) newest first: date, consultant, customer, project, activity code, hours, billable and invoiced. Filter by from/to, customer, consultant, project or uninvoiced; paginate with offset = next_offset.',
    keywords: ['tidrapport', 'tidrader', 'timmar', 'tidredovisning', 'projektredovisning', 'arbetad tid', 'konsulttimmar'],
  },
  run: async (ctx, input) => {
    const outcome = await listTimeEntries(ctx, toFilters(input))
    if (!outcome.ok || outcome.dryRun) return outcome
    const { entries, ...page } = outcome.data
    return {
      ok: true,
      data: { entries: entries.map(toOutputEntry), ...page },
    }
  },
})

export const timeEntriesSummary = defineOperation({
  id: 'time-entries.summary',
  kind: 'read',
  scope: 'time:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Hours and uninvoiced amounts per customer, project or consultant and month.',
    description:
      'Totals per group (group_by: customer, project or consultant) and calendar month, newest month first: hours, billable hours, uninvoiced billable hours and their amount at the activity code\'s hourly rate, else the company default rate. Takes the same filters as the entry list.',
    useWhen: 'Answering "how much is unbilled for this customer", building invoice basis (fakturaunderlag) or following up hours per project or consultant.',
    doNotUseFor: 'The individual rows behind a total (GET /time-entries).',
    pitfalls: [
      'uninvoiced_amount is null when some of the group\'s uninvoiced billable hours have no known rate: set a rate on the activity code or a default rate in the time-tracking settings.',
      'Amounts are SEK excluding VAT.',
      'With group_by=project, hours without a project form one group with key "" and label null.',
    ],
    example: {
      request: { group_by: 'customer', uninvoiced: 'true' },
      response: {
        data: {
          group_by: 'customer',
          rows: [
            {
              key: '51c0…',
              label: 'Galärbryggan AB',
              month: '2026-10',
              hours: 12.5,
              billable_hours: 12.5,
              uninvoiced_billable_hours: 12.5,
              uninvoiced_amount: 11875,
            },
          ],
          totals: { hours: 12.5, billable_hours: 12.5, uninvoiced_billable_hours: 12.5, uninvoiced_amount: 11875 },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    ...filters,
    group_by: z.enum(['customer', 'project', 'consultant']).default('customer').describe('What to total by (default customer).'),
  }),
  output: z.object({
    group_by: z.enum(['customer', 'project', 'consultant']),
    rows: z.array(z.object({ key: z.string(), label: z.string().nullable(), month: z.string(), ...Totals })),
    totals: z.object(Totals),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/time-entries/summary' },
  mcp: {
    name: 'gnubok_get_time_summary',
    title: 'Get Time Summary',
    description:
      'Hours per customer, project or consultant (group_by) and month, with uninvoiced billable hours priced at the activity rate or default rate. Use for unbilled time and fakturaunderlag; same filters as gnubok_list_time_entries.',
    keywords: ['fakturaunderlag', 'ofakturerad tid', 'timmar per kund', 'timmar per projekt', 'debiterbar tid', 'tidsammanställning'],
  },
  run: (ctx, input) => summarizeTimeEntries(ctx, { ...toFilters(input), group_by: input.group_by }),
})

export const timeEntriesCodes = defineOperation({
  id: 'time-entries.codes',
  kind: 'read',
  scope: 'time:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The codes a time entry can reference: consultants, activity codes, customer codes and projects.',
    description:
      'Returns the time-tracking registers: consultants (initials and name), activity codes with their hourly rates, the default hourly rate, imported customer codes with the Accounted customer each is linked to, and the active projects (SIE dimension 6).',
    useWhen: 'Resolving a name the user said ("Galärbryggan", "bokslut", "Anna") to the code a filter takes.',
    doNotUseFor: 'Listing all customers (GET /customers) or all dimensions (GET /dimensions).',
    pitfalls: [
      'Consultants and activity codes are created on the dashboard or by importing a time report; an empty list means none are set up yet.',
      'Only customer codes linked to an existing customer are listed.',
    ],
    example: {
      response: {
        data: {
          consultants: [{ code: 'AB', name: 'Anna Berg' }],
          activity_codes: [{ code: '1', name: 'Löpande bokföring', hourly_rate: 950 }],
          default_hourly_rate: 800,
          customer_codes: [{ code: 'GF', customer_id: '51c0…', customer_name: 'Galärbryggan AB' }],
          projects: [{ code: 'P12', name: 'Bokslut 2026' }],
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: z.object({
    consultants: z.array(z.object({ code: z.string(), name: z.string() })),
    activity_codes: z.array(z.object({ code: z.string(), name: z.string(), hourly_rate: z.number().nullable() })),
    default_hourly_rate: z.number().nullable(),
    customer_codes: z.array(z.object({ code: z.string(), customer_id: z.string().uuid(), customer_name: z.string().nullable() })),
    projects: z.array(z.object({ code: z.string(), name: z.string() })),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/time-entries/codes' },
  mcp: {
    name: 'gnubok_list_time_codes',
    title: 'List Time Codes',
    description:
      'Time-tracking registers: consultants, activity codes with hourly rates, default rate, customer codes linked to Accounted customers, and active projects. Call first to resolve a spoken name to the code the time tools take.',
    keywords: ['medarbetare', 'konsulter', 'aktivitetskoder', 'arbetskoder', 'timpris', 'kundkoder', 'projektkoder'],
  },
  run: (ctx) => listTimeCodes(ctx),
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const TIME_ENTRY_ID = z.string().uuid().describe('The time entry id (time_entry_id from the list).')
const ENTRY_PATH = '/api/v1/companies/:companyId/time-entries/:id'
const MAX_ENTRIES_PER_CALL = 20

const hours = z
  .number()
  .positive()
  .max(MAX_HOURS_PER_ENTRY)
  .refine((h) => Math.abs(Math.round(h * 100) - h * 100) < 1e-6, 'at most two decimals')
  .describe(`Decimal hours, at most ${MAX_HOURS_PER_ENTRY} and two decimals: 1.5 is one hour thirty minutes.`)

const ref = (what: string) => z.string().trim().min(1).max(120).describe(what)

const entryFields = {
  entry_date: saneIsoDateSchema.describe('The day the work was done (YYYY-MM-DD). Resolve "igår" or "i måndags" to a date first.'),
  hours,
  customer_id: z.string().uuid().optional().describe('The Accounted customer. Give this or customer.'),
  customer: ref('Customer by name, customer number or imported customer code; resolved, never created. Give this or customer_id.').optional(),
  project: ref('Project (SIE dimension 6) by code or name.').nullable().optional(),
  activity: ref('Activity code (arbetskod) by code or name; sets the hourly rate.').nullable().optional(),
  consultant: ref('Consultant by initials or name. Omit to use the consultant linked to the acting user.').optional(),
  comment: z.string().trim().max(1000).nullable().optional().describe('What was done; shown on the invoice basis.'),
  is_billable: z.boolean().optional().describe('Default true.'),
}

const EntryInput = z
  .object(entryFields)
  .refine((e) => Boolean(e.customer_id) !== Boolean(e.customer), {
    message: 'give exactly one of customer_id and customer',
    path: ['customer'],
  })

export const timeEntriesCreate = defineOperation({
  id: 'time-entries.create',
  kind: 'write',
  scope: 'time:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Register hours (tidrader), one or up to 20 in one call.',
    description:
      'Registers time entries. Customer, project, activity code and consultant may be given by code or by name: each resolves by exact code, exact name, then a confident fuzzy match, and anything ambiguous is refused with candidates. Nothing is created in the registers. All or nothing. Dry-runnable.',
    useWhen: 'Someone says what they worked on: "3 timmar på Galärbryggan igår, bokslut".',
    doNotUseFor: 'Importing a whole time report (the time-tracking import on the dashboard) or correcting a logged entry (PATCH /time-entries/{id}).',
    pitfalls: [
      'An ambiguous or unknown name answers 400 TIME_ENTRY_REFERENCE_UNRESOLVED with details.candidates: retry with the code.',
      'Without consultant, the consultant linked to the acting user is used; with no link, 400 TIME_ENTRY_CONSULTANT_REQUIRED lists the consultants.',
      'In a batch, details.entry_index names the entry at fault.',
    ],
    example: {
      request: { entries: [{ entry_date: '2026-11-02', hours: 3, customer: 'Galärbryggan', activity: 'bokslut' }] },
      response: {
        data: {
          entries: [
            {
              time_entry_id: '7a2e…',
              entry_date: '2026-11-02',
              consultant: 'AB',
              customer_id: '51c0…',
              customer_code: null,
              customer_name: 'Galärbryggan AB',
              project_code: null,
              activity_code: '2',
              hours: 3,
              comment: null,
              is_billable: true,
              invoice_id: null,
              invoiced_externally: false,
              source: 'manual',
              created_at: '2026-11-03T08:12:40Z',
              updated_at: '2026-11-03T08:12:40Z',
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    entries: z.array(EntryInput).min(1).max(MAX_ENTRIES_PER_CALL).describe(`1-${MAX_ENTRIES_PER_CALL} entries, registered together.`),
  }),
  output: z.object({ entries: z.array(TimeEntry) }),
  errorCodes: ['TIME_ENTRY_REFERENCE_UNRESOLVED', 'TIME_ENTRY_CONSULTANT_REQUIRED', 'TIME_ENTRY_CUSTOMER_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/time-entries' },
  mcp: {
    name: 'gnubok_log_time',
    title: 'Log Time',
    description:
      'Stage registering hours (1-20 entries) for approval. Customer, project, activity and consultant by code or name; ambiguous names are refused with candidates. Omit consultant to use the caller\'s. Resolve relative dates first.',
    keywords: ['logga tid', 'registrera tid', 'tidrapportera', 'rapportera timmar', 'timmar', 'tidrad', 'jobbade'],
    stage: {
      pendingType: 'create_time_entries',
      title: (input) => {
        const entries = (input.entries as Array<{ hours: number; entry_date: string }>) ?? []
        const total = Math.round(entries.reduce((s, e) => s + e.hours, 0) * 100) / 100
        return entries.length === 1
          ? `Registrera ${total} h den ${entries[0].entry_date}`
          : `Registrera ${entries.length} tidrader, ${total} h`
      },
      // Commit with the references the approver saw, by id and code.
      pinParams: (_input, preview) => ({
        entries: (preview as CreateTimeEntriesPreview).entries.map(pinnedEntryInput),
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await createTimeEntries(ctx, input.entries, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: { entries: outcome.data.entries.map(toOutputEntry) } }
  },
})

export const timeEntriesUpdate = defineOperation({
  id: 'time-entries.update',
  kind: 'write',
  scope: 'time:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Change a time entry that is not invoiced yet.',
    description:
      'Sparse update: only the fields sent change; project, activity and comment take null to clear. References resolve like on create. An invoiced entry is frozen and answers 409 TIME_ENTRY_INVOICED. Dry-runnable.',
    useWhen: 'Hours, date, customer, project, activity or comment were logged wrong.',
    doNotUseFor: 'Removing an entry (DELETE /time-entries/{id}).',
    pitfalls: [
      'At least one field besides time_entry_id must be sent.',
      'Imported entries can be changed too; their import key is kept, so re-importing the same report does not bring the old values back.',
    ],
    example: { request: { hours: 2.5 }, response: { data: { entry: { time_entry_id: '7a2e…', hours: 2.5 } }, meta: META } },
  },
  input: z
    .object({
      time_entry_id: TIME_ENTRY_ID,
      entry_date: entryFields.entry_date.optional(),
      hours: hours.optional(),
      customer_id: entryFields.customer_id,
      customer: entryFields.customer,
      project: entryFields.project,
      activity: entryFields.activity,
      consultant: entryFields.consultant,
      comment: entryFields.comment,
      is_billable: entryFields.is_billable,
    })
    .refine((p) => Object.keys(p).some((k) => k !== 'time_entry_id'), { message: 'send at least one field to change' })
    .refine((p) => !(p.customer_id && p.customer), { message: 'give customer_id or customer, not both', path: ['customer'] }),
  output: z.object({ entry: TimeEntry }),
  errorCodes: ['TIME_ENTRY_NOT_FOUND', 'TIME_ENTRY_INVOICED', 'TIME_ENTRY_REFERENCE_UNRESOLVED', 'TIME_ENTRY_CUSTOMER_NOT_FOUND'],
  http: { method: 'PATCH', path: ENTRY_PATH, pathParams: { id: 'time_entry_id' } },
  mcp: {
    name: 'gnubok_update_time_entry',
    title: 'Update Time Entry',
    description:
      'Stage a change to a time entry that is not invoiced: send only the fields to change (project, activity, comment take null to clear). References by code or name, resolved like gnubok_log_time.',
    keywords: ['ändra tidrad', 'rätta tid', 'ändra timmar'],
    stage: {
      pendingType: 'update_time_entry',
      title: () => 'Ändra tidrad',
      pinParams: (input, preview) => ({
        time_entry_id: input.time_entry_id,
        ...(preview as UpdateTimeEntryPreview).changes,
      }),
    },
  },
  run: async (ctx, { time_entry_id, ...patch }, { dryRun }) => {
    const outcome = await updateTimeEntry(ctx, time_entry_id, patch, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: { entry: toOutputEntry(outcome.data.entry) } }
  },
})

export const timeEntriesDelete = defineOperation({
  id: 'time-entries.delete',
  kind: 'write',
  scope: 'time:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Delete a time entry that is not invoiced yet.',
    description: 'Removes the entry. An invoiced entry is frozen and answers 409 TIME_ENTRY_INVOICED. Dry-runnable.',
    useWhen: 'Hours were logged twice or on something that was never done.',
    doNotUseFor: 'Correcting hours or a customer (PATCH /time-entries/{id}).',
    pitfalls: ['A deleted imported entry comes back if the same report is imported again.'],
    example: { response: { data: { deleted: true, time_entry_id: '7a2e…' }, meta: META } },
  },
  input: z.object({ time_entry_id: TIME_ENTRY_ID }),
  output: z.object({ deleted: z.literal(true), time_entry_id: z.string().uuid() }),
  errorCodes: ['TIME_ENTRY_NOT_FOUND', 'TIME_ENTRY_INVOICED'],
  http: { method: 'DELETE', path: ENTRY_PATH, pathParams: { id: 'time_entry_id' } },
  mcp: {
    name: 'gnubok_delete_time_entry',
    title: 'Delete Time Entry',
    description: 'Stage deleting a time entry that is not invoiced, e.g. hours logged twice. To correct hours or the customer, use gnubok_update_time_entry instead.',
    keywords: ['ta bort tidrad', 'radera tid'],
    stage: { pendingType: 'delete_time_entry', title: () => 'Ta bort tidrad' },
  },
  run: (ctx, { time_entry_id }, { dryRun }) => deleteTimeEntry(ctx, time_entry_id, { dryRun }),
})

export const timeEntriesInvoice = defineOperation({
  id: 'time-entries.invoice',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Create a draft invoice from a customer\'s uninvoiced billable hours.',
    description:
      'Builds a draft invoice for one customer from its uninvoiced billable time entries (optionally from/to), priced at the activity code rate or the default rate, and links the entries to it. Built and written exactly like POST /invoices (VAT rules, payee, invoice.created). The draft is not sent or booked. Dry-runnable.',
    useWhen: 'Billing the hours of a month or a project to the customer: "fakturera Galärbryggan för oktober".',
    doNotUseFor: 'Invoices that are not time-based (POST /invoices) or sending the invoice (POST /invoices/{id}/send after review).',
    pitfalls: [
      'Hours without a rate answer 400 TIME_INVOICE_RATE_MISSING: set the activity code rate or a default rate first.',
      'Linked entries are frozen while the draft exists; deleting the draft frees them again.',
      'lines=activity (default) gives one line per activity code, project and rate; lines=entry one line per entry with its date, consultant and comment.',
      'Only hours linked to an Accounted customer can be invoiced: link imported customer codes first.',
    ],
    example: {
      request: { customer_id: '51c0…', from: '2026-10-01', to: '2026-10-31', invoice_date: '2026-11-03' },
      response: { data: { invoice_id: '9d4f…', entry_count: 14, hours: 12.5, subtotal: 11875 }, meta: META },
    },
  },
  input: z.object({
    customer_id: z.string().uuid().describe('The customer to invoice (key of a customer row in the time summary).'),
    from: saneIsoDateSchema.optional().describe('First entry date to include (YYYY-MM-DD).'),
    to: saneIsoDateSchema.optional().describe('Last entry date to include (YYYY-MM-DD).'),
    invoice_date: saneIsoDateSchema.describe('Invoice date (YYYY-MM-DD), usually today.'),
    due_date: saneIsoDateSchema.optional().describe('Omit for the customer\'s payment terms, else the company default.'),
    lines: z.enum(['activity', 'entry']).default('activity').describe('activity: one line per activity code, project and rate (default); entry: one line per entry.'),
    our_reference: z.string().trim().max(200).nullable().optional(),
    your_reference: z.string().trim().max(200).nullable().optional(),
    time_entry_ids: z.array(z.string().uuid()).min(1).max(TIME_INVOICE_MAX_ENTRIES).optional().describe('Set by staging to the entries the approver saw; omit.'),
    expected_hours: z.number().optional().describe('Set by staging; omit.'),
    expected_subtotal: z.number().optional().describe('Set by staging; omit.'),
  }),
  output: z.object({
    invoice_id: z.string().uuid(),
    entry_count: z.number().int(),
    hours: z.number(),
    subtotal: z.number(),
  }),
  errorCodes: ['TIME_INVOICE_NOTHING_TO_INVOICE', 'TIME_INVOICE_RATE_MISSING', 'TIME_INVOICE_ENTRIES_CHANGED', 'TIME_INVOICE_TOO_MANY_ENTRIES', 'TIME_ENTRY_CUSTOMER_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/time-entries/invoice' },
  mcp: {
    name: 'gnubok_invoice_time_entries',
    title: 'Invoice Time Entries',
    description:
      'Stage a draft invoice (not sent, not booked) from one customer\'s uninvoiced billable hours, optionally from/to, priced at the activity or default rate, and link the hours to it. Built like gnubok_create_invoice.',
    keywords: ['fakturera tid', 'fakturera timmar', 'fakturaunderlag', 'faktura från tidrapport', 'debitera timmar'],
    stage: {
      pendingType: 'create_invoice_from_time_entries',
      title: () => 'Fakturautkast från tidrapporter',
      // Commit exactly the rows and totals the approver saw.
      pinParams: (input, preview) => {
        const p = preview as TimeInvoicePreview
        return {
          ...input,
          due_date: p.due_date,
          time_entry_ids: p.time_entry_ids,
          expected_hours: p.hours,
          expected_subtotal: p.subtotal,
        }
      },
    },
  },
  run: (ctx, input, { dryRun }) => invoiceTimeEntries(ctx, input, { dryRun }),
})
