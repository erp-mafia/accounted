import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import type { SupplierInvoiceDto } from '@/lib/providers/dto'
import { MigrationInvoiceCorrectionSchema, resolveMigrationSupplierInvoiceNumber } from '@/lib/providers/migration-corrections'
import { openMigrationPayload, sealMigrationPayload } from '@/lib/providers/migration-payload'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'

const QuerySchema = z.object({ jobId: z.uuid(), after: z.uuid().optional() })
const SaveSchema = z.object({ jobId: z.uuid(), chunkId: z.uuid(), correction: MigrationInvoiceCorrectionSchema }).strict()
const editableErrors = ['23502', 'MIGRATION_INVOICE_NUMBER_REQUIRED']
function refusal(status: number) {
  return NextResponse.json({ error: { code: status === 409 ? 'MIGRATION_CORRECTION_CONFLICT' : 'MIGRATION_CORRECTION_REFUSED',
    message: 'Kompletteringen kunde inte sparas eller läsas. Uppdatera importen och kontrollera posten.',
    message_en: 'The correction could not be saved or loaded. Refresh the import and check the record.' } }, { status })
}
function hasContext(ctx?: ExtensionContext): ctx is ExtensionContext { return !!ctx?.companyId && !!ctx.userId }

/** Corrections belong to the staged record, never the immutable source or posted invoice. */
export const migrationCorrectionRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET', path: '/migration-jobs/missing-fields',
    handler: async (request, ctx) => {
      if (!hasContext(ctx)) return refusal(401)
      const url = new URL(request.url)
      const parsed = QuerySchema.safeParse({ jobId: url.searchParams.get('jobId'), after: url.searchParams.get('after') ?? undefined })
      if (!parsed.success) return refusal(400)
      const { data: job, error: jobError } = await ctx.supabase.from('migration_jobs').select('id,state')
        .eq('company_id', ctx.companyId).eq('id', parsed.data.jobId).maybeSingle()
      if (jobError) return refusal(500)
      if (!job) return refusal(404)
      if (job.state !== 'needs_attention') return NextResponse.json({ data: { records: [], next: null } })
      let query = ctx.supabase.from('migration_job_chunks').select('id,payload,source_id')
        .eq('company_id', ctx.companyId).eq('job_id', job.id).eq('resource', 'supplierInvoices')
        .eq('state', 'needs_attention').is('target_id', null).in('error_code', editableErrors)
        .is('receipt->userCorrection', null).order('id').limit(21)
      if (parsed.data.after) query = query.gt('id', parsed.data.after)
      const { data, error } = await query
      if (error) return refusal(500)
      const page = (data ?? []).slice(0, 20)
      const records = page.flatMap(row => {
        const dto = openMigrationPayload<SupplierInvoiceDto>(row.payload)
        if (resolveMigrationSupplierInvoiceNumber(dto)) return []
        return [{ id: row.id, sourceId: row.source_id, supplier: dto.supplier.name, date: dto.issueDate,
          total: dto.legalMonetaryTotal.payableAmount.value, currency: dto.currencyCode }]
      })
      return NextResponse.json({ data: { records, next: (data?.length ?? 0) > 20 ? page.at(-1)?.id : null } },
        { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  {
    method: 'POST', path: '/migration-jobs/missing-fields',
    handler: async (request, ctx) => {
      if (!hasContext(ctx)) return refusal(401)
      const body = await validateBody(request, SaveSchema)
      if (!body.success) return body.response
      const write = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
      if (!write.ok) return write.response
      const { data: job, error: jobError } = await ctx.supabase.from('migration_jobs').select('id,state')
        .eq('company_id', ctx.companyId).eq('id', body.data.jobId).maybeSingle()
      if (jobError) return refusal(500)
      if (!job) return refusal(404)
      if (job.state !== 'needs_attention') return refusal(409)
      const { data: chunk, error: readError } = await ctx.supabase.from('migration_job_chunks')
        .select('id,payload,receipt,updated_at').eq('company_id', ctx.companyId).eq('job_id', job.id)
        .eq('id', body.data.chunkId).eq('resource', 'supplierInvoices').eq('state', 'needs_attention')
        .is('target_id', null).in('error_code', editableErrors).maybeSingle()
      if (readError) return refusal(500)
      if (!chunk) return refusal(409)
      const dto = openMigrationPayload<SupplierInvoiceDto>(chunk.payload)
      if (resolveMigrationSupplierInvoiceNumber(dto)) return refusal(409)
      const receipt = { ...chunk.receipt, userCorrection: sealMigrationPayload(body.data.correction).payload,
        correctedBy: ctx.userId, correctedAt: new Date().toISOString() }
      // State/version checks reject a concurrent retry or correction. Source payload stays untouched.
      const { data: updated, error } = await createServiceClientNoCookies().from('migration_job_chunks')
        .update({ receipt, updated_at: receipt.correctedAt }).eq('company_id', ctx.companyId).eq('job_id', job.id)
        .eq('id', chunk.id).eq('state', 'needs_attention').is('target_id', null)
        .eq('updated_at', chunk.updated_at).select('id').maybeSingle()
      if (error) return refusal(500)
      if (!updated) return refusal(409)
      return NextResponse.json({ data: { saved: true } })
    },
  },
]
