/**
 * Time-entry operations (tidrapportering): reads over the hours registered
 * per customer, project and consultant. Rules live in
 * lib/time-tracking/service.ts, shared with the time-tracking extension's
 * dashboard routes. Writes stay on the dashboard for now.
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import {
  listTimeCodes,
  listTimeEntries,
  summarizeTimeEntries,
  TIME_ENTRY_LIST_LIMIT_MAX,
} from '@/lib/time-tracking/service'
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
  source: z.enum(['manual', 'import']),
  created_at: z.string(),
  updated_at: z.string(),
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
      'Returns time entries newest first: date, consultant, customer, project, activity code, hours, billable flag and the invoice they were billed on. Filter by date range, customer, consultant, project or uninvoiced. Offset pagination: pass next_offset back as offset; it is null on the last page.',
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
      // company_id, user_id and import_key are internal: the door answers the documented shape.
      data: {
        entries: entries.map(({ id, company_id: _c, user_id: _u, import_key: _k, ...e }) => ({ time_entry_id: id, ...e })),
        ...page,
      },
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
