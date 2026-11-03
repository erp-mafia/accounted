import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { isoDateSchema } from '@/lib/invariants/zod'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { readWorkbookFromBuffer } from '@/lib/import/shared/workbook-reader'
import { parseTimeWorkbook, TimeWorkbookError } from './lib/workbook-import'
import type { ParsedTimeWorkbook } from './lib/workbook-import'
import { buildInvoiceBasisCsv, summarizeByCustomerMonth } from '@/lib/time-tracking/summary'
import { DEFAULT_SETTINGS, MAX_HOURS_PER_ENTRY, MAX_IMPORT_FILE_BYTES } from './types'
import type { TimeTrackingSettings } from './types'
import { fetchAllTimeEntries, listTimeEntries, TIME_ENTRY_LIST_LIMIT_MAX, withCustomerName } from '@/lib/time-tracking/service'
import type { TimeEntryRow } from '@/lib/time-tracking/service'

const SETTINGS_KEY = 'settings'
const RATE_LIMIT_IMPORT = { maxRequests: 10, windowMs: 60_000 }
const IMPORT_CHUNK = 500

const isoDate = isoDateSchema
const code = (max: number) => z.string().trim().min(1).max(max)
const rate = z.number().min(0).max(100_000).nullable()
const hours = z
  .number()
  .positive()
  .max(MAX_HOURS_PER_ENTRY)
  .refine((h) => Math.abs(Math.round(h * 100) - h * 100) < 1e-6, 'Ange timmar med högst två decimaler')

const settingsSchema = z.object({
  consultants: z.array(z.object({ code: code(20), name: code(120) })).max(500),
  activity_codes: z.array(z.object({ code: code(20), name: code(120), hourly_rate: rate })).max(500),
  customer_links: z.array(z.object({ code: code(40), customer_id: z.uuid() })).max(2000),
  default_hourly_rate: rate,
})

const entrySchema = z.object({
  entry_date: isoDate,
  consultant: code(20),
  customer_id: z.uuid(),
  project_code: code(40).nullable().optional(),
  activity_code: code(20).nullable().optional(),
  hours,
  comment: z.string().trim().max(1000).nullable().optional(),
  is_billable: z.boolean().optional(),
})

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  customer_id: z.uuid().optional(),
  customer_code: code(40).optional(),
  consultant: code(20).optional(),
  uninvoiced: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(TIME_ENTRY_LIST_LIMIT_MAX).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const periodQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  customer_id: z.uuid().optional(),
  customer_code: code(40).optional(),
  uninvoiced: z.enum(['true', 'false']).optional(),
})

const customerLinkSchema = z.object({ code: code(40), customer_id: z.uuid().nullable() })

const markInvoicedSchema = z.object({
  entry_ids: z.array(z.uuid()).min(1).max(1000),
  invoice_id: z.uuid().nullable(),
})

const importOptionsSchema = z.object({
  from_date: isoDate.nullable().optional(),
  links: z.array(z.object({ code: code(40), customer_id: z.uuid() })).max(2000).optional(),
})

function requireCtx(ctx: ExtensionContext | undefined): ExtensionContext | NextResponse {
  if (!ctx?.companyId || !ctx.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return ctx
}

async function loadSettings(ctx: ExtensionContext): Promise<TimeTrackingSettings> {
  const stored = await ctx.settings.get<Partial<TimeTrackingSettings>>(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
}

async function customerBelongsToCompany(ctx: ExtensionContext, customerId: string): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return Boolean(data)
}

/** A project code must be a value of the company's SIE dimension 6 (Projekt). */
async function projectExists(ctx: ExtensionContext, projectCode: string): Promise<boolean> {
  const { data } = await ctx.supabase
    .from('dimension_values')
    .select('id, dimensions!inner(sie_dim_no)')
    .eq('company_id', ctx.companyId)
    .eq('code', projectCode)
    .eq('dimensions.sie_dim_no', 6)
    .limit(1)
  return Boolean(data && data.length > 0)
}

async function validateEntryRefs(
  ctx: ExtensionContext,
  entry: { customer_id?: string; project_code?: string | null },
): Promise<NextResponse | null> {
  if (entry.customer_id && !(await customerBelongsToCompany(ctx, entry.customer_id))) {
    return NextResponse.json({ error: 'Kunden finns inte.' }, { status: 400 })
  }
  if (entry.project_code && !(await projectExists(ctx, entry.project_code))) {
    return NextResponse.json(
      { error: `Projektet ${entry.project_code} finns inte. Lägg upp det under Inställningar, Dimensioner.` },
      { status: 400 },
    )
  }
  return null
}

function entryIdOf(request: Request): string | null {
  const id = new URL(request.url).searchParams.get('_id')
  return id && z.uuid().safeParse(id).success ? id : null
}

/** Load an entry of this company that may still change: 404 when absent, 409 when invoiced. */
async function loadEditableEntry(
  ctx: ExtensionContext,
  id: string,
  verb: 'ändras' | 'tas bort',
): Promise<NextResponse | null> {
  const { data: existing } = await ctx.supabase
    .from('time_entries')
    .select('id, invoice_id')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Tidraden finns inte.' }, { status: 404 })
  if (existing.invoice_id) {
    return NextResponse.json({ error: `Tidraden är fakturerad och kan inte ${verb}.` }, { status: 409 })
  }
  return null
}

function periodFilters({ uninvoiced, ...rest }: z.infer<typeof periodQuery>) {
  return { ...rest, uninvoiced: uninvoiced === 'true' }
}

async function readUploadedWorkbook(
  request: Request,
): Promise<{ parsed: ParsedTimeWorkbook; form: FormData } | NextResponse> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Ingen fil skickades.' }, { status: 400 })
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Ingen fil skickades.' }, { status: 400 })
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return NextResponse.json(
      { error: `Filen är för stor. Maxstorlek är ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB.` },
      { status: 413 },
    )
  }
  if (!/\.(xlsx|xls|ods|csv)$/i.test(file.name)) {
    return NextResponse.json({ error: 'Filtypen stöds inte. Ladda upp en Excel-fil (.xlsx).' }, { status: 400 })
  }
  try {
    const workbook = readWorkbookFromBuffer(await file.arrayBuffer(), file.name)
    return { parsed: parseTimeWorkbook(workbook), form }
  } catch (error) {
    if (error instanceof TimeWorkbookError) {
      return NextResponse.json(
        { error: 'Hittade ingen tidtabell i filen. Den behöver kolumnerna Datum, Medarb, Kund och Timmar.' },
        { status: 422 },
      )
    }
    return NextResponse.json({ error: 'Filen kunde inte läsas som ett kalkylark.' }, { status: 422 })
  }
}

/** Codes from the workbook that are not yet in settings, appended in workbook order. */
function mergeByCode<T extends { code: string }>(existing: T[], incoming: T[]): T[] {
  const known = new Set(existing.map((x) => x.code))
  return [...existing, ...incoming.filter((x) => !known.has(x.code))]
}

const round2 = (x: number) => Math.round(x * 100) / 100

export const timeTrackingApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/settings',
    handler: async (_request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      return NextResponse.json({ data: await loadSettings(ctx) })
    },
  },
  {
    method: 'PUT',
    path: '/settings',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const body = await validateBody(request, settingsSchema)
      if (!body.success) return body.response
      await ctx.settings.set(SETTINGS_KEY, body.data)
      return NextResponse.json({ data: body.data })
    },
  },
  {
    method: 'GET',
    path: '/entries',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const q = validateQuery(request, listQuery)
      if (!q.success) return q.response
      const { uninvoiced, ...filters } = q.data
      const outcome = await listTimeEntries(ctx, { ...filters, uninvoiced: uninvoiced === 'true' })
      if (!outcome.ok || outcome.dryRun) {
        return NextResponse.json({ error: 'Tidraderna kunde inte hämtas.' }, { status: 500 })
      }
      const { entries, ...page } = outcome.data
      return NextResponse.json({ data: entries, ...page })
    },
  },
  {
    method: 'POST',
    path: '/entries',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const body = await validateBody(request, entrySchema)
      if (!body.success) return body.response
      const invalid = await validateEntryRefs(ctx, body.data)
      if (invalid) return invalid

      const { data, error } = await ctx.supabase
        .from('time_entries')
        .insert({
          company_id: ctx.companyId,
          user_id: ctx.userId,
          entry_date: body.data.entry_date,
          consultant: body.data.consultant.toUpperCase(),
          customer_id: body.data.customer_id,
          project_code: body.data.project_code ?? null,
          activity_code: body.data.activity_code ?? null,
          hours: body.data.hours,
          comment: body.data.comment || null,
          is_billable: body.data.is_billable ?? true,
          source: 'manual',
        })
        .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, source, import_key, created_at, updated_at, customers(name)')
        .single()
      if (error || !data) {
        ctx.log.error('time_entries insert failed', error)
        return NextResponse.json({ error: 'Tidraden kunde inte sparas.' }, { status: 500 })
      }
      return NextResponse.json({ data: withCustomerName(data as unknown as TimeEntryRow) }, { status: 201 })
    },
  },
  {
    method: 'PATCH',
    path: '/entries/:id',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const id = entryIdOf(request)
      if (!id) return NextResponse.json({ error: 'Tidraden finns inte.' }, { status: 404 })
      // Full replacement, not a partial merge: the editor always sends the whole row.
      const body = await validateBody(request, entrySchema)
      if (!body.success) return body.response
      const blocked = await loadEditableEntry(ctx, id, 'ändras')
      if (blocked) return blocked
      const invalid = await validateEntryRefs(ctx, body.data)
      if (invalid) return invalid

      const { data, error } = await ctx.supabase
        .from('time_entries')
        .update({
          entry_date: body.data.entry_date,
          consultant: body.data.consultant.toUpperCase(),
          customer_id: body.data.customer_id,
          project_code: body.data.project_code ?? null,
          activity_code: body.data.activity_code ?? null,
          hours: body.data.hours,
          comment: body.data.comment || null,
          is_billable: body.data.is_billable ?? true,
        })
        .eq('id', id)
        .eq('company_id', ctx.companyId)
        .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, source, import_key, created_at, updated_at, customers(name)')
        .single()
      if (error || !data) {
        ctx.log.error('time_entries update failed', error)
        return NextResponse.json({ error: 'Tidraden kunde inte sparas.' }, { status: 500 })
      }
      return NextResponse.json({ data: withCustomerName(data as unknown as TimeEntryRow) })
    },
  },
  {
    method: 'DELETE',
    path: '/entries/:id',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const id = entryIdOf(request)
      if (!id) return NextResponse.json({ error: 'Tidraden finns inte.' }, { status: 404 })
      const blocked = await loadEditableEntry(ctx, id, 'tas bort')
      if (blocked) return blocked
      const { error } = await ctx.supabase.from('time_entries').delete().eq('id', id).eq('company_id', ctx.companyId)
      if (error) {
        ctx.log.error('time_entries delete failed', error)
        return NextResponse.json({ error: 'Tidraden kunde inte tas bort.' }, { status: 500 })
      }
      return NextResponse.json({ data: { id } })
    },
  },
  {
    method: 'POST',
    path: '/entries/mark-invoiced',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const body = await validateBody(request, markInvoicedSchema)
      if (!body.success) return body.response
      if (body.data.invoice_id) {
        const { data: invoice } = await ctx.supabase
          .from('invoices')
          .select('id')
          .eq('id', body.data.invoice_id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()
        if (!invoice) return NextResponse.json({ error: 'Fakturan finns inte.' }, { status: 404 })
      }
      const { data, error } = await ctx.supabase
        .from('time_entries')
        .update({ invoice_id: body.data.invoice_id })
        .in('id', body.data.entry_ids)
        .eq('company_id', ctx.companyId)
        .select('id')
      if (error) {
        ctx.log.error('time_entries mark-invoiced failed', error)
        return NextResponse.json({ error: 'Tidraderna kunde inte uppdateras.' }, { status: 500 })
      }
      return NextResponse.json({ data: { updated: data?.length ?? 0 } })
    },
  },
  {
    method: 'GET',
    path: '/summary',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const q = validateQuery(request, periodQuery)
      if (!q.success) return q.response
      try {
        const [entries, settings] = await Promise.all([fetchAllTimeEntries(ctx, periodFilters(q.data)), loadSettings(ctx)])
        return NextResponse.json({ data: summarizeByCustomerMonth(entries, settings) })
      } catch (error) {
        ctx.log.error('time_entries summary failed', error)
        return NextResponse.json({ error: 'Sammanställningen kunde inte hämtas.' }, { status: 500 })
      }
    },
  },
  {
    method: 'GET',
    path: '/export',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const q = validateQuery(request, periodQuery)
      if (!q.success) return q.response
      try {
        const [entries, settings] = await Promise.all([fetchAllTimeEntries(ctx, periodFilters(q.data)), loadSettings(ctx)])
        const csv = buildInvoiceBasisCsv(entries, settings)
        const name = `fakturaunderlag_${q.data.from ?? 'start'}_${q.data.to ?? 'idag'}.csv`
        return new Response(csv, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name}"`,
          },
        })
      } catch (error) {
        ctx.log.error('time_entries export failed', error)
        return NextResponse.json({ error: 'Exporten kunde inte skapas.' }, { status: 500 })
      }
    },
  },
  {
    method: 'PUT',
    path: '/customer-links',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const body = await validateBody(request, customerLinkSchema)
      if (!body.success) return body.response
      const linkCode = body.data.code.toUpperCase()
      if (body.data.customer_id && !(await customerBelongsToCompany(ctx, body.data.customer_id))) {
        return NextResponse.json({ error: 'Kunden finns inte.' }, { status: 400 })
      }

      const { data, error } = await ctx.supabase
        .from('time_entries')
        .update({ customer_id: body.data.customer_id })
        .eq('company_id', ctx.companyId)
        .eq('customer_code', linkCode)
        .select('id')
      if (error) {
        ctx.log.error('time_entries link failed', error)
        return NextResponse.json({ error: 'Kopplingen kunde inte sparas.' }, { status: 500 })
      }
      const settings = await loadSettings(ctx)
      const others = settings.customer_links.filter((l) => l.code !== linkCode)
      const customer_links = body.data.customer_id
        ? [...others, { code: linkCode, customer_id: body.data.customer_id }]
        : others
      await ctx.settings.set(SETTINGS_KEY, { ...settings, customer_links })
      return NextResponse.json({
        data: { code: linkCode, customer_id: body.data.customer_id, updated: data?.length ?? 0 },
      })
    },
  },
  {
    method: 'POST',
    path: '/import/preview',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const rl = await checkRateLimit({ prefix: 'time-tracking:import', identifier: ctx.userId, ...RATE_LIMIT_IMPORT })
      if (!rl.ok) return rl.response!
      const upload = await readUploadedWorkbook(request)
      if (upload instanceof NextResponse) return upload
      const { parsed } = upload
      const settings = await loadSettings(ctx)

      const { data: customers } = await ctx.supabase
        .from('customers')
        .select('id, name')
        .eq('company_id', ctx.companyId)
      const byName = new Map(
        ((customers ?? []) as Array<{ id: string; name: string }>).map((c) => [c.name.trim().toLowerCase(), c.id]),
      )
      const registerName = new Map(parsed.customers.map((c) => [c.code, c.name]))
      const linked = new Map(settings.customer_links.map((l) => [l.code, l.customer_id]))

      const perCustomer = new Map<string, { rows: number; hours: number; first: string; last: string }>()
      for (const row of parsed.rows) {
        const agg = perCustomer.get(row.customer_code) ?? { rows: 0, hours: 0, first: row.entry_date, last: row.entry_date }
        agg.rows += 1
        agg.hours += row.hours
        if (row.entry_date < agg.first) agg.first = row.entry_date
        if (row.entry_date > agg.last) agg.last = row.entry_date
        perCustomer.set(row.customer_code, agg)
      }

      const dates = parsed.rows.map((r) => r.entry_date).sort()
      return NextResponse.json({
        data: {
          row_count: parsed.rows.length,
          total_hours: round2(parsed.rows.reduce((s, r) => s + r.hours, 0)),
          first_date: dates[0] ?? null,
          last_date: dates.at(-1) ?? null,
          consultants: parsed.consultants,
          activity_codes: parsed.activity_codes,
          skipped: parsed.skipped,
          customers: [...perCustomer.entries()]
            .map(([customerCode, agg]) => {
              const name = registerName.get(customerCode) ?? null
              return {
                code: customerCode,
                name,
                rows: agg.rows,
                hours: round2(agg.hours),
                first_date: agg.first,
                last_date: agg.last,
                suggested_customer_id:
                  linked.get(customerCode) ?? (name ? byName.get(name.trim().toLowerCase()) ?? null : null),
              }
            })
            .sort((a, b) => b.last_date.localeCompare(a.last_date)),
        },
      })
    },
  },
  {
    method: 'POST',
    path: '/import/commit',
    handler: async (request, rawCtx) => {
      const ctx = requireCtx(rawCtx)
      if (ctx instanceof NextResponse) return ctx
      const rl = await checkRateLimit({ prefix: 'time-tracking:import', identifier: ctx.userId, ...RATE_LIMIT_IMPORT })
      if (!rl.ok) return rl.response!
      const upload = await readUploadedWorkbook(request)
      if (upload instanceof NextResponse) return upload
      const { parsed, form } = upload

      let rawOptions: unknown
      try {
        rawOptions = JSON.parse(String(form.get('options') ?? '{}'))
      } catch {
        rawOptions = null
      }
      const options = importOptionsSchema.safeParse(rawOptions)
      if (!options.success) {
        return NextResponse.json({ error: 'Ogiltiga importinställningar.' }, { status: 400 })
      }

      const settings = await loadSettings(ctx)
      const links = new Map(settings.customer_links.map((l) => [l.code, l.customer_id]))
      for (const l of options.data.links ?? []) links.set(l.code.toUpperCase(), l.customer_id)

      // Drop links to customers outside this company before they reach a row.
      const linkedIds = [...new Set(links.values())]
      if (linkedIds.length > 0) {
        const { data: owned } = await ctx.supabase
          .from('customers')
          .select('id')
          .eq('company_id', ctx.companyId)
          .in('id', linkedIds)
        const ownedIds = new Set(((owned ?? []) as Array<{ id: string }>).map((c) => c.id))
        for (const [linkCode, id] of links) if (!ownedIds.has(id)) links.delete(linkCode)
      }

      const registerName = new Map(parsed.customers.map((c) => [c.code, c.name]))
      const fromDate = options.data.from_date ?? null
      const rows = parsed.rows
        .filter((r) => !fromDate || r.entry_date >= fromDate)
        .map((r) => ({
          company_id: ctx.companyId,
          user_id: ctx.userId,
          entry_date: r.entry_date,
          consultant: r.consultant,
          customer_id: links.get(r.customer_code) ?? null,
          customer_code: r.customer_code,
          customer_name: registerName.get(r.customer_code) ?? null,
          project_code: r.project_code,
          activity_code: r.activity_code,
          hours: r.hours,
          comment: r.comment,
          is_billable: true,
          source: 'import' as const,
          import_key: r.import_key,
        }))

      let inserted = 0
      for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
        const { data, error } = await ctx.supabase
          .from('time_entries')
          .upsert(rows.slice(i, i + IMPORT_CHUNK), { onConflict: 'company_id,import_key', ignoreDuplicates: true })
          .select('id')
        if (error) {
          ctx.log.error('time_entries import failed', error)
          return NextResponse.json(
            {
              error: 'Importen avbröts. Raderna före felet är sparade; importera filen igen för att fortsätta.',
              inserted,
            },
            { status: 500 },
          )
        }
        inserted += data?.length ?? 0
      }

      await ctx.settings.set(SETTINGS_KEY, {
        ...settings,
        consultants: mergeByCode(settings.consultants, parsed.consultants),
        activity_codes: mergeByCode(settings.activity_codes, parsed.activity_codes),
        customer_links: [...links.entries()].map(([linkCode, customer_id]) => ({ code: linkCode, customer_id })),
      })

      return NextResponse.json({
        data: {
          considered: rows.length,
          inserted,
          already_imported: rows.length - inserted,
          skipped: parsed.skipped.length,
        },
      })
    },
  },
]
