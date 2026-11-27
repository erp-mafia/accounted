import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateBody } from '@/lib/api/validate'
import {
  MIGRATION_RESOURCES, isTransientIssueCode,
  type MigrationIssueLabel, type MigrationIssuePhase, type MigrationIssueReview, type MigrationResource,
  type MigrationResourceCounts, type ProviderMigrationIssue, type ProviderMigrationJob, type ProviderMigrationStatus,
} from '@/lib/providers/migration-contract'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import type { MigrationDto } from '@/lib/providers/provider-data-fetcher'
import type { CustomerDto, SalesInvoiceDto, SupplierDto, SupplierInvoiceDto } from '@/lib/providers/dto'
import { runProviderMigrationWorker, failureCode } from './migration-job-worker'
import { fiscalYearScopeFromImports } from './invoice-scope'
import { ensureConsentSourceIdentity, ProviderCompanyMismatchError } from './provider-client'
import { companyMismatchMessages } from './company-mismatch-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { subscriptionRefusal } from '@/lib/providers/with-provider-call'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { whereSieImportInPlace } from '@/lib/bookkeeping/sie-import-in-place'

const CreateSchema = z.object({
  consentId: z.uuid(), resources: z.array(z.enum(MIGRATION_RESOURCES)).min(1).max(4),
  /** Fortnox's paid supplier invoices too, for this sync only. */
  allSupplierInvoices: z.boolean().optional(),
}).strict()
const JobSchema = z.object({ jobId: z.uuid(), consentId: z.uuid().optional() }).strict()
const AcceptSchema = z.object({ jobId: z.uuid() }).strict()

/** Records listed for review per read; the counts cover the rest. */
const ISSUE_LIMIT = 500
/** Source snapshots opened per read to name the listed records. */
const LABEL_LIMIT = 200

const CONTINUE_FAILED = { message: 'Importen kunde inte fortsätta. Dina sparade framsteg finns kvar.',
  message_en: 'The import could not continue. Your saved progress is preserved.' }
const ACCEPT_FAILED = { message: 'Importen kunde inte godkännas. Inget har ändrats, försök igen.',
  message_en: 'The import could not be accepted. Nothing has changed, try again.' }

function error(code: string, status: number, text = CONTINUE_FAILED) {
  return NextResponse.json({ error: { code, ...text } }, { status })
}

/**
 * A refusal of a register fetch, in the registry's words when the code has an
 * entry there: why, and what to do. The route's own sentence ("Importen kunde
 * inte fortsätta...") is for its operational failures; answering every
 * refusal with it hid the reason. A company without an imported ledger read
 * it nine times in 50 minutes and never imported anything (2026-11-09), and
 * six Visma companies whose company identity the provider withheld read it
 * once each and never got their registers (5 to 11 Nov).
 */
function registryRefusal(code: string, status: number) {
  const entry = getErrorEntry(code)
  return error(code, status, entry ? { message: entry.message_sv, message_en: entry.message_en } : CONTINUE_FAILED)
}

/**
 * Fill the consent's durable source identity from the provider before the RPC
 * needs it (see ensureConsentSourceIdentity). Returns a response only when the
 * credentials open a different company than the one being imported into.
 */
async function sourceIdentityRefusal(ctx: ExtensionContext, consentId: string): Promise<NextResponse | null> {
  try {
    const outcome = await ensureConsentSourceIdentity(ctx.companyId, consentId)
    if (outcome !== 'present') ctx.log.info('provider migration source identity', { consentId, outcome })
    return null
  } catch (e) {
    if (e instanceof ProviderCompanyMismatchError) {
      const message = companyMismatchMessages(e)
      return errorResponseFromCode('PROVIDER_COMPANY_MISMATCH', ctx.log, {
        messageSv: message.sv, messageEn: message.en,
        details: { expectedOrgNumber: e.expectedOrgNumber, actualOrgNumber: e.actualOrgNumber, actualCompanyName: e.actualCompanyName },
      })
    }
    // The customer's subscription at the provider refuses (no API module, no
    // licence, a plan without API access): every register call would answer
    // the same, and that code's sentence says what to change.
    const refused = subscriptionRefusal(e)
    if (refused) return errorResponseFromCode(refused, ctx.log, { details: { consentId } })
    // Anything else is left for the RPC to judge; it names what is missing.
    ctx.log.warn('provider migration source identity lookup failed', { consentId, reason: e instanceof Error ? e.message : 'unknown' })
    return null
  }
}

/** The RPC raises bare codes; log which one so a 409 is never anonymous again. */
function logRefusal(ctx: ExtensionContext, rpcError: { code?: string; message: string }, consentId: string) {
  ctx.log.warn('create_provider_migration_job refused', {
    consentId, failure: failureCode(new Error(rpcError.message)), pgCode: rpcError.code ?? null,
  })
}

/** Extension dispatcher supplies MFA, company context and the write-role gate. */

interface IssueRow {
  id: string
  resource: MigrationResource
  source_id: string
  error_code: string | null
  error_phase: string | null
  target_id: string | null
  receipt: {
    link?: { invoiceNumber?: string | null; invoiceDate?: string | null; totalSek?: number | null
      sourceVoucher?: { series?: string | null; number?: number } | null } | null
    review?: MigrationIssueReview | null
    /** Written by retry_provider_migration_job (migration 20261005193000). */
    previous_error_code?: string | null
  } | null
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Name a record from its own source snapshot: the number, date, amount and
 * party the user knows it by in the source system. Read only for display;
 * nothing is stored. A snapshot that cannot be opened names nothing.
 */
function labelFromSnapshot(resource: MigrationResource, payload: string): MigrationIssueLabel | null {
  let dto: MigrationDto & { migrationError?: string }
  try { dto = openMigrationPayload<MigrationDto & { migrationError?: string }>(payload) } catch { return null }
  if (resource === 'customers' || resource === 'suppliers') {
    const party = dto as CustomerDto | SupplierDto
    const number = resource === 'customers' ? (party as CustomerDto).customerNumber : (party as SupplierDto).supplierNumber
    return { number: number || null, date: null, amount: null, currency: null, party: party.party?.name || null }
  }
  const invoice = dto as SalesInvoiceDto | SupplierInvoiceDto
  const party = resource === 'salesInvoices' ? (invoice as SalesInvoiceDto).customer : (invoice as SupplierInvoiceDto).supplier
  return {
    number: invoice.invoiceNumber || null,
    date: typeof invoice.issueDate === 'string' && invoice.issueDate ? invoice.issueDate.slice(0, 10) : null,
    // An invoice with no total in its own currency carries a placeholder 0.
    amount: (invoice as SalesInvoiceDto).totalUnresolved ? null : finite(invoice.legalMonetaryTotal?.payableAmount?.value),
    currency: invoice.currencyCode || null,
    party: party?.name || null,
  }
}

/** Without a snapshot label, an imported record still has its receipt. */
function labelFromReceipt(row: IssueRow): MigrationIssueLabel | null {
  const link = row.receipt?.link
  if (!link) return null
  return { number: link.invoiceNumber || null, date: link.invoiceDate || null,
    amount: finite(link.totalSek), currency: finite(link.totalSek) === null ? null : 'SEK', party: null }
}

const ISSUE_PHASES: readonly string[] = ['import', 'link', 'reconcile', 'settle'] satisfies MigrationIssuePhase[]

/** The last retry ended with the code the record already had. */
function repeatedCode(row: Pick<IssueRow, 'error_code' | 'receipt'>): boolean {
  const previous = row.receipt?.previous_error_code
  return !!previous && previous === (row.error_code ?? 'MIGRATION_RETRY')
}

/**
 * Whether every record that needs attention, listed or not, failed again the
 * same way and none for a passing reason. Read only for a review with more
 * records than it lists: the listed ones alone cannot say that a further
 * retry would repeat the whole outcome, and leaving the retry on offer there
 * is the loop the review exists to end.
 */
async function everyRecordRepeated(ctx: ExtensionContext, jobId: string): Promise<boolean> {
  const rows = await fetchAllRows<Pick<IssueRow, 'id' | 'error_code' | 'receipt'>>(({ from, to }) =>
    ctx.supabase.from('migration_job_chunks').select('id,error_code,receipt')
      .eq('company_id', ctx.companyId).eq('job_id', jobId).eq('state', 'needs_attention')
      .order('id').range(from, to))
  return rows.length > 0 && rows.every(row => repeatedCode(row) && !isTransientIssueCode(row.error_code))
}

function toIssue(row: IssueRow, label: MigrationIssueLabel | null): ProviderMigrationIssue {
  const code = row.error_code ?? 'MIGRATION_RETRY'
  const voucher = row.receipt?.link?.sourceVoucher
  const review = row.receipt?.review
  return {
    id: row.id, resource: row.resource, source_id: row.source_id, error_code: code,
    error_phase: row.error_phase && ISSUE_PHASES.includes(row.error_phase) ? row.error_phase as MigrationIssuePhase : null,
    // A record that failed after its import phase is in Accounted already.
    imported: row.target_id !== null,
    target_id: row.target_id,
    repeated: repeatedCode(row),
    label: label ?? labelFromReceipt(row),
    voucher: voucher && typeof voucher.number === 'number' ? { series: voucher.series ?? null, number: voucher.number } : null,
    review: review && typeof review === 'object' ? review : null,
  }
}

/** The company's job by id, or its latest job. */
async function readJob(ctx: ExtensionContext, jobId?: string): Promise<ProviderMigrationJob | null> {
  let query = ctx.supabase.from('migration_jobs').select('*').eq('company_id', ctx.companyId)
  if (jobId) query = query.eq('id', jobId)
  const { data: row, error: readError } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (readError) throw new Error(readError.message)
  return (row as ProviderMigrationJob | null) ?? null
}

export async function readMigrationStatus(ctx: ExtensionContext, jobId?: string): Promise<ProviderMigrationStatus | null> {
  const job = await readJob(ctx, jobId)
  if (!job) return null
  // Records are reviewed only once the job has stopped: a paused job shows
  // what failed so far, a finished one what the user is asked to accept.
  const reviewable = job.state === 'needs_attention' || job.state === 'completed'
  const chunks = () => ctx.supabase.from('migration_job_chunks')
  const [{ data: counts, error: countError }, issueRead, payloadRead] = await Promise.all([
    ctx.supabase.rpc('provider_migration_counts', { p_job_id: job.id }),
    reviewable
      ? chunks().select('id,resource,source_id,error_code,error_phase,target_id,receipt')
        .eq('company_id', ctx.companyId).eq('job_id', job.id).eq('state', 'needs_attention')
        .order('resource_order').order('id').limit(ISSUE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    reviewable
      ? chunks().select('id,payload')
        .eq('company_id', ctx.companyId).eq('job_id', job.id).eq('state', 'needs_attention')
        .order('resource_order').order('id').limit(LABEL_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])
  const failure = countError ?? issueRead.error ?? payloadRead.error
  if (failure) throw new Error(failure.message)
  const rows = (issueRead.data ?? []) as IssueRow[]
  const payloads = new Map(((payloadRead.data ?? []) as { id: string; payload: string }[]).map(p => [p.id, p.payload]))
  const issues = rows.map(r => toIssue(r, payloads.has(r.id) ? labelFromSnapshot(r.resource, payloads.get(r.id)!) : null))
  const resourceCounts = (counts ?? []) as MigrationResourceCounts[]
  const total = resourceCounts.reduce((n, c) => n + Number(c.needs_attention ?? 0), 0)
  const acceptable = job.phase === 'completed' && job.state === 'needs_attention'
  const truncated = reviewable && issues.length < total
  // Invoices declined as outside the imported years before more years were
  // imported: a retry judges them again (crm#2002).
  const staleOutsideYears = resourceCounts.reduce((n, c) => n + Number(c.outside_years_stale ?? 0), 0)
  // Nothing changed: every record failed again the same way, and none for a
  // passing reason, and no declined invoice has years to be judged against
  // anew. Another retry would only repeat this outcome. The listed records
  // decide first; the rest are read only when those all repeated.
  const unchanged = acceptable && total > 0 && staleOutsideYears === 0
    && issues.every(issue => issue.repeated && !isTransientIssueCode(issue.error_code))
    && (!truncated || await everyRecordRepeated(ctx, job.id))
  return { job, counts: resourceCounts, issues, review: { total, acceptable, truncated, unchanged, staleOutsideYears } }
}

export const migrationJobRoutes: ApiRouteDefinition[] = [
  {
    method: 'POST', path: '/migration-jobs',
    handler: async (request, ctx) => {
      const body = await validateBody(request, CreateSchema)
      if (!body.success) return body.response
      const resources = MIGRATION_RESOURCES.filter(resource => body.data.resources.includes(resource))
      const { data: consent, error: consentError } = await ctx.supabase.from('provider_consents').select('id')
        .eq('id', body.data.consentId).eq('company_id', ctx.companyId).in('status', [0, 1]).maybeSingle()
      if (consentError) return error('MIGRATION_LOOKUP_FAILED', 500)
      if (!consent) return registryRefusal('PROVIDER_CONSENT_NOT_FOUND', 404)
      const { data: imports, error: importsError } = await whereSieImportInPlace(ctx.supabase.from('sie_imports')
        .select('fiscal_year_start,fiscal_year_end').eq('company_id', ctx.companyId))
      if (importsError) return error('MIGRATION_LOOKUP_FAILED', 500)
      if (!imports?.length) return registryRefusal('PROVIDER_SIE_IMPORT_REQUIRED', 400)
      const refusal = await sourceIdentityRefusal(ctx, body.data.consentId)
      if (refusal) return refusal
      // The request for paid supplier invoices rides on the job's own scope,
      // so a resumed or reconnected job keeps it and the next sync starts
      // without it (crm#1114).
      const scope = fiscalYearScopeFromImports(imports)
      const allSupplierInvoices = body.data.allSupplierInvoices === true && resources.includes('supplierInvoices')
      const { data: job, error: createError } = await createServiceClientNoCookies().rpc('create_provider_migration_job', {
        p_company_id: ctx.companyId, p_user_id: ctx.userId, p_consent_id: body.data.consentId,
        p_resources: resources, p_scope: allSupplierInvoices ? { ...scope, allSupplierInvoices: true } : scope,
      })
      if (createError) {
        logRefusal(ctx, createError, body.data.consentId)
        return registryRefusal(failureCode(new Error(createError.message)), 409)
      }
      after(async () => { await runProviderMigrationWorker({ jobId: job.id }).catch(e => ctx.log.error('provider worker nudge failed', e)) })
      return NextResponse.json({ data: { jobId: job.id } }, { status: 202 })
    },
  },
  {
    method: 'GET', path: '/migration-jobs',
    handler: async (request, ctx) => {
      const id = new URL(request.url).searchParams.get('jobId') ?? undefined
      if (id && !z.uuid().safeParse(id).success) return error('VALIDATION_ERROR', 400)
      const result = await readMigrationStatus(ctx, id)
      if (!result && id) return error('NOT_FOUND', 404)
      return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  ...(['run', 'retry'] as const).map(action => ({
    method: 'POST' as const, path: `/migration-jobs/${action}`,
    handler: async (request: Request, ctx: ExtensionContext) => {
      const body = await validateBody(request, JobSchema)
      if (!body.success) return body.response
      const job = await readJob(ctx, body.data.jobId)
      if (!job) return error('NOT_FOUND', 404)
      if (action === 'retry') {
        if (!['needs_attention', 'retry_wait'].includes(job.state)) return error('MIGRATION_NOT_RETRYABLE', 409)
        if (body.data.consentId) {
          const refusal = await sourceIdentityRefusal(ctx, body.data.consentId)
          if (refusal) return refusal
          const { error: reconnectError } = await createServiceClientNoCookies().rpc('create_provider_migration_job', {
            p_company_id: ctx.companyId, p_user_id: ctx.userId, p_consent_id: body.data.consentId,
            p_resources: job.resources, p_scope: job.fiscal_year_scope,
          })
          if (reconnectError) {
            logRefusal(ctx, reconnectError, body.data.consentId)
            return error('MIGRATION_RECONNECT_MISMATCH', 409)
          }
        }
        const { error: retryError } = await createServiceClientNoCookies().rpc('retry_provider_migration_job', {
          p_job_id: job.id, p_company_id: ctx.companyId, p_user_id: ctx.userId,
        })
        if (retryError) return error('MIGRATION_RETRY_FAILED', 409)
      }
      after(async () => { await runProviderMigrationWorker({ jobId: job.id }).catch(e => ctx.log.error('provider worker nudge failed', e)) })
      return NextResponse.json({ data: { jobId: job.id } }, { status: 202 })
    },
  })),
  {
    // Finish a job whose every record has an outcome, with the records that
    // still need attention. They keep their state and reason, so the result
    // goes on listing them; nothing is dropped, rewritten or retried.
    method: 'POST', path: '/migration-jobs/accept',
    handler: async (request, ctx) => {
      const body = await validateBody(request, AcceptSchema)
      if (!body.success) return body.response
      const { data: job, error: readError } = await ctx.supabase.from('migration_jobs').select('id,phase,state')
        .eq('company_id', ctx.companyId).eq('id', body.data.jobId).maybeSingle()
      if (readError) return error('MIGRATION_LOOKUP_FAILED', 500, ACCEPT_FAILED)
      if (!job) return error('NOT_FOUND', 404, ACCEPT_FAILED)
      // A repeated click (or a lost response) finds the job already finished.
      if (job.state === 'completed') return NextResponse.json({ data: { jobId: job.id } })
      // A job paused mid-run still has records without an outcome: it is
      // resumed, never accepted, or those records would vanish unseen.
      if (job.phase !== 'completed' || job.state !== 'needs_attention') return error('MIGRATION_NOT_ACCEPTABLE', 409, ACCEPT_FAILED)
      const { error: acceptError } = await createServiceClientNoCookies().rpc('accept_provider_migration_job', {
        p_job_id: job.id, p_company_id: ctx.companyId, p_user_id: ctx.userId,
      })
      if (acceptError) {
        ctx.log.warn('accept_provider_migration_job refused', { jobId: job.id,
          failure: failureCode(new Error(acceptError.message)), pgCode: acceptError.code ?? null })
        return error('MIGRATION_ACCEPT_FAILED', 409, ACCEPT_FAILED)
      }
      return NextResponse.json({ data: { jobId: job.id } })
    },
  },
]
