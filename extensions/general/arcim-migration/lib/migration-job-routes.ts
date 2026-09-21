import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateBody } from '@/lib/api/validate'
import { MIGRATION_RESOURCES, type ProviderMigrationJob, type ProviderMigrationStatus } from '@/lib/providers/migration-contract'
import { runProviderMigrationWorker, failureCode } from './migration-job-worker'
import { fiscalYearScopeFromImports } from './invoice-scope'

const CreateSchema = z.object({ consentId: z.uuid(), resources: z.array(z.enum(MIGRATION_RESOURCES)).min(1).max(4) }).strict()
const JobSchema = z.object({ jobId: z.uuid(), consentId: z.uuid().optional() }).strict()

function error(code: string, status: number) {
  return NextResponse.json({ error: { code, message: 'Importen kunde inte fortsätta. Dina sparade framsteg finns kvar.',
    message_en: 'The import could not continue. Your saved progress is preserved.' } }, { status })
}

/** Extension dispatcher supplies MFA, company context and the write-role gate. */
function requireContext(ctx?: ExtensionContext): ctx is ExtensionContext { return !!ctx?.companyId && !!ctx.userId }

export async function readMigrationStatus(ctx: ExtensionContext, jobId?: string): Promise<ProviderMigrationStatus | null> {
  let query = ctx.supabase.from('migration_jobs').select('*').eq('company_id', ctx.companyId)
  if (jobId) query = query.eq('id', jobId)
  const { data: job, error: readError } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (readError) throw new Error(readError.message)
  if (!job) return null
  const [{ data: counts, error: countError }, { data: issues, error: issueError }] = await Promise.all([
    ctx.supabase.rpc('provider_migration_counts', { p_job_id: job.id }),
    ctx.supabase.from('migration_job_chunks').select('id,resource,source_id,error_code')
      .eq('company_id', ctx.companyId).eq('job_id', job.id).eq('state', 'needs_attention').order('id').limit(100),
  ])
  if (countError || issueError) throw new Error(countError?.message ?? issueError?.message)
  return { job: job as ProviderMigrationJob, counts: counts ?? [], issues: issues ?? [] }
}

export const migrationJobRoutes: ApiRouteDefinition[] = [
  {
    method: 'POST', path: '/migration-jobs',
    handler: async (request, ctx) => {
      if (!requireContext(ctx)) return error('UNAUTHORIZED', 401)
      const body = await validateBody(request, CreateSchema)
      if (!body.success) return body.response
      const resources = MIGRATION_RESOURCES.filter(resource => body.data.resources.includes(resource))
      const { data: consent, error: consentError } = await ctx.supabase.from('provider_consents').select('id')
        .eq('id', body.data.consentId).eq('company_id', ctx.companyId).in('status', [0, 1]).maybeSingle()
      if (consentError) return error('MIGRATION_LOOKUP_FAILED', 500)
      if (!consent) return error('PROVIDER_CONSENT_NOT_FOUND', 404)
      const { data: imports, error: importsError } = await ctx.supabase.from('sie_imports')
        .select('fiscal_year_start,fiscal_year_end').eq('company_id', ctx.companyId).eq('status', 'completed')
      if (importsError) return error('MIGRATION_LOOKUP_FAILED', 500)
      if (!imports?.length) return error('PROVIDER_SIE_IMPORT_REQUIRED', 400)
      const { data: job, error: createError } = await createServiceClientNoCookies().rpc('create_provider_migration_job', {
        p_company_id: ctx.companyId, p_user_id: ctx.userId, p_consent_id: body.data.consentId,
        p_resources: resources, p_scope: fiscalYearScopeFromImports(imports),
      })
      if (createError) return error(failureCode(new Error(createError.message)), 409)
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
      if (action === 'retry') {
        if (!['needs_attention', 'retry_wait'].includes(status.job.state)) return error('MIGRATION_NOT_RETRYABLE', 409)
        if (body.data.consentId) {
          const { error: reconnectError } = await createServiceClientNoCookies().rpc('create_provider_migration_job', {
            p_company_id: ctx.companyId, p_user_id: ctx.userId, p_consent_id: body.data.consentId,
            p_resources: status.job.resources, p_scope: status.job.fiscal_year_scope,
          })
          if (reconnectError) return error('MIGRATION_RECONNECT_MISMATCH', 409)
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
