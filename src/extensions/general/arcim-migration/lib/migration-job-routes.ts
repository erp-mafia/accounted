import { readMigrationSkipReasons, readPendingImportPayables } from './migration-result-details'
import { requireWritePermission } from '@/lib/auth/require-write'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateBody } from '@/lib/api/validate'
import { MIGRATION_RESOURCES, type ProviderMigrationJob, type ProviderMigrationStatus, type MigrationResourceCounts } from '@/lib/providers/migration-contract'
import { runProviderMigrationWorker, failureCode } from './migration-job-worker'
import { fiscalYearScopeFromImports } from './invoice-scope'
import { ensureConsentSourceIdentity, ProviderCompanyMismatchError } from './provider-client'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const CreateSchema = z.object({ consentId: z.uuid(), resources: z.array(z.enum(MIGRATION_RESOURCES)).min(1).max(4), years:z.array(z.number().int().min(1900).max(2200)).min(1).max(301).optional() }).strict()
const PreflightSchema = z.object({ resources: z.array(z.enum(MIGRATION_RESOURCES)).max(4) }).strict()
const FinishSchema = z.object({ jobId: z.uuid() }).strict()
const JobSchema = z.object({ jobId: z.uuid(), consentId: z.uuid().optional() }).strict()

function error(code: string, status: number) {
  return NextResponse.json({ error: { code, message: 'Importen kunde inte fortsätta. Dina sparade framsteg finns kvar.',
    message_en: 'The import could not continue. Your saved progress is preserved.' } }, { status })
}

/** Shared by the wizard preflight and direct job admission/retry. Never exposes the key. */
function encryptionRefusal(ctx: ExtensionContext): NextResponse | null {
  if (process.env.PERSONNUMMER_ENCRYPTION_KEY?.trim()) return null
  return errorResponseFromCode('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED', ctx.log, {
    messageSv: 'Registerimporten kan inte starta: servern saknar krypteringsnyckeln PERSONNUMMER_ENCRYPTION_KEY. Administratören behöver konfigurera den innan du försöker igen.',
    messageEn: 'Register import cannot start: the server is missing PERSONNUMMER_ENCRYPTION_KEY. An administrator must configure it before you retry.',
  })
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
      return errorResponseFromCode('PROVIDER_COMPANY_MISMATCH', ctx.log, {
        details: { expectedOrgNumber: e.expectedOrgNumber, actualOrgNumber: e.actualOrgNumber, actualCompanyName: e.actualCompanyName },
      })
    }
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
function requireContext(ctx?: ExtensionContext): ctx is ExtensionContext { return !!ctx?.companyId && !!ctx.userId }

export async function readMigrationStatus(ctx: ExtensionContext, jobId?: string): Promise<ProviderMigrationStatus | null> {
  let query = ctx.supabase.from('migration_jobs').select('*').eq('company_id', ctx.companyId)
  if (jobId) query = query.eq('id', jobId)
  const { data: job, error: readError } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!job) return null
  const [{ data: counts, error: countError }, { data: issues, error: issueError }, {data: changes, error: changesError}] = await Promise.all([
    ctx.supabase.rpc('provider_migration_counts', { p_job_id: job.id }),
    ctx.supabase.from('migration_job_chunks').select('id,resource,source_id,error_code,payload,target_id,error_phase')
      .eq('company_id', ctx.companyId).eq('job_id', job.id).eq('state', 'needs_attention').order('id').limit(100),
    ctx.supabase.from('migration_job_chunks').select('id,resource,source_id,target_id,payload,receipt')
      .eq('company_id',ctx.companyId).eq('job_id',job.id).not('target_id','is',null)
      .or('receipt->>imported.eq.true,receipt->>reason.eq.source_changed').order('resource_order').order('id').limit(100),
  ])
  if (countError || issueError || changesError) throw new Error(countError?.message ?? issueError?.message ?? changesError?.message)
  const described = (Array.isArray(issues) ? issues : []).map(row => {
    let invoice: Partial<SalesInvoiceDto> | null = null
    if (row.payload && ['salesInvoices', 'supplierInvoices'].includes(row.resource)) {
      // Labels are best effort; a damaged snapshot must not hide the job's issue.
      try { invoice = openMigrationPayload<Partial<SalesInvoiceDto>>(row.payload) } catch { /* Keep the source ID as fallback. */ }
    }
    const amount = invoice?.legalMonetaryTotal?.payableAmount?.value
    return { id: row.id, resource: row.resource, source_id: row.source_id, error_code: row.error_code,
      targetId: row.target_id ?? null, errorPhase: row.error_phase ?? null,
      ...(typeof invoice?.invoiceNumber === 'string' && invoice.invoiceNumber ? { invoiceNumber: invoice.invoiceNumber } : {}),
      ...(typeof invoice?.issueDate === 'string' && invoice.issueDate ? { invoiceDate: invoice.issueDate } : {}),
      ...(typeof amount === 'number' && Number.isFinite(amount) ? { amount } : {}),
      ...(typeof invoice?.currencyCode === 'string' ? { currency: invoice.currencyCode } : {}) }
  })
  const describedChanges = (Array.isArray(changes) ? changes : []).map(row => {
    let label = row.source_id as string
    if (row.payload) try {
      const value = openMigrationPayload<{invoiceNumber?:string;party?:{name?:string}}>(row.payload)
      label = value.invoiceNumber || value.party?.name || label
    } catch { /* A source ID remains a safe fallback. */ }
    return {id:row.id,resource:row.resource,source_id:row.source_id,targetId:row.target_id,label,
      kind:row.receipt?.reason==='source_changed' ? 'changed' as const : 'new' as const}
  })
  const [skipReasons,paymentsAwaitingDueDate]=job.phase==='completed'
    ? await Promise.all([readMigrationSkipReasons(ctx.supabase,ctx.companyId,job.id),
      readPendingImportPayables(ctx.supabase,ctx.companyId,job.id)]) : [{},undefined]
  return { job: job as ProviderMigrationJob, counts: (counts ?? []).map((row:MigrationResourceCounts)=>({...row,skipReasons:skipReasons[row.resource as keyof typeof skipReasons]})),
    issues: described, changes:describedChanges,paymentsAwaitingDueDate }
}

export const migrationJobRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET', path: '/migration-jobs/reviews',
    handler: async (_request, ctx) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const { data, error: readError } = await ctx.supabase.from('migration_jobs')
        .select('id,review_deferred_at,state').eq('company_id', ctx.companyId)
        .not('review_deferred_at', 'is', null).order('review_deferred_at', { ascending: false }).limit(50)
      if (readError) return error('MIGRATION_LOOKUP_FAILED', 500)
      return NextResponse.json({ data: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  {
    method: 'POST', path: '/migration-jobs/finish-with-review',
    handler: async (request, ctx) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const body = await validateBody(request, FinishSchema)
      if (!body.success) return body.response
      const write = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
      if (!write.ok) return write.response
      const { data, error: finishError } = await createServiceClientNoCookies().rpc('finish_provider_migration_with_review', {
        p_job_id: body.data.jobId, p_company_id: ctx.companyId, p_user_id: ctx.userId,
      })
      if (finishError) return error('MIGRATION_REVIEW_NOT_FINISHABLE', 409)
      return NextResponse.json({ data: { remaining: data } })
    },
  },
  {
    method: 'POST', path: '/migration-jobs/preflight',
    handler: async (request, ctx) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const body = await validateBody(request, PreflightSchema)
      if (!body.success) return body.response
      if (body.data.resources.length) {
        const refusal = encryptionRefusal(ctx)
        if (refusal) return refusal
      }
      return NextResponse.json({ data: { ready: true } }, { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  {
    method: 'POST', path: '/migration-jobs',
    handler: async (request, ctx) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const body = await validateBody(request, CreateSchema)
      if (!body.success) return body.response
      const resources = MIGRATION_RESOURCES.filter(resource => body.data.resources.includes(resource))
      const configurationRefusal = encryptionRefusal(ctx)
      if (configurationRefusal) return configurationRefusal
      const { data: consent, error: consentError } = await ctx.supabase.from('provider_consents').select('id')
        .eq('id', body.data.consentId).eq('company_id', ctx.companyId).in('status', [0, 1]).maybeSingle()
      if (consentError) return error('MIGRATION_LOOKUP_FAILED', 500)
      if (!consent) return error('PROVIDER_CONSENT_NOT_FOUND', 404)
      const { data: imports, error: importsError } = await ctx.supabase.from('sie_imports')
        .select('fiscal_year_start,fiscal_year_end').eq('company_id', ctx.companyId).eq('status', 'completed')
      if (importsError) return error('MIGRATION_LOOKUP_FAILED', 500)
      if (!imports?.length) return error('PROVIDER_SIE_IMPORT_REQUIRED', 400)
      if (body.data.years?.some(year => !imports.some(row => Number(row.fiscal_year_start?.slice(0,4))===year))) return error('PROVIDER_SIE_IMPORT_REQUIRED',400)
      const scope = fiscalYearScopeFromImports(imports,{years:body.data.years})
      if (body.data.years && !scope) return error('PROVIDER_SIE_IMPORT_REQUIRED',400)
      const refusal = await sourceIdentityRefusal(ctx, body.data.consentId)
      if (refusal) return refusal
      const { data: job, error: createError } = await createServiceClientNoCookies().rpc('create_provider_migration_job', {
        p_company_id: ctx.companyId, p_user_id: ctx.userId, p_consent_id: body.data.consentId,
        p_resources: resources, p_scope: scope,
      })
      if (createError) {
        logRefusal(ctx, createError, body.data.consentId)
        return error(failureCode(new Error(createError.message)), 409)
      }
      after(async () => { await runProviderMigrationWorker({ jobId: job.id }).catch(e => ctx.log.error('provider worker nudge failed', e)) })
      return NextResponse.json({ data: { jobId: job.id } }, { status: 202 })
    },
  },
  {
    method: 'GET', path: '/migration-jobs',
    handler: async (request, ctx) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const id = new URL(request.url).searchParams.get('jobId') ?? undefined
      if (id && !z.uuid().safeParse(id).success) return error('VALIDATION_ERROR', 400)
      const result = await readMigrationStatus(ctx, id)
      if (!result && id) return error('NOT_FOUND', 404)
      return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  ...(['run', 'retry'] as const).map(action => ({
    method: 'POST' as const, path: `/migration-jobs/${action}`,
    handler: async (request: Request, ctx?: ExtensionContext) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const body = await validateBody(request, JobSchema)
      if (!body.success) return body.response
      const status = await readMigrationStatus(ctx, body.data.jobId)
      if (!status) return error('NOT_FOUND', 404)
      const configurationRefusal = encryptionRefusal(ctx)
      if (configurationRefusal) return configurationRefusal
      if (action === 'retry') {
        if (!['needs_attention', 'retry_wait'].includes(status.job.state) && !(status.job.state === 'completed' && status.job.review_deferred_at && status.issues.length)) return error('MIGRATION_NOT_RETRYABLE', 409)
        if (body.data.consentId) {
          const refusal = await sourceIdentityRefusal(ctx, body.data.consentId)
          if (refusal) return refusal
          const { error: reconnectError } = await createServiceClientNoCookies().rpc('create_provider_migration_job', {
            p_company_id: ctx.companyId, p_user_id: ctx.userId, p_consent_id: body.data.consentId,
            p_resources: status.job.resources, p_scope: status.job.fiscal_year_scope,
          })
          if (reconnectError) {
            logRefusal(ctx, reconnectError, body.data.consentId)
            return error('MIGRATION_RECONNECT_MISMATCH', 409)
          }
        }
        const { error: retryError } = await createServiceClientNoCookies().rpc('retry_provider_migration_job', {
          p_job_id: status.job.id, p_company_id: ctx.companyId, p_user_id: ctx.userId,
        })
        if (retryError) return error('MIGRATION_RETRY_FAILED', 409)
      }
      after(async () => { await runProviderMigrationWorker({ jobId: status.job.id }).catch(e => ctx.log.error('provider worker nudge failed', e)) })
      return NextResponse.json({ data: { jobId: status.job.id } }, { status: 202 })
    },
  })),
]
