import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ExtensionContext, ApiRouteDefinition } from '@/lib/extensions/types'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { openMigrationPayload } from '@/lib/providers/migration-payload'
import { findHistoricalReceivableCandidates, pageHistoricalReceivableFindings, type HistoricalInvoiceSource, type HistoricalPaymentEntry } from '@/lib/providers/historical-receivable-findings'

const Cursor = z.object({ date: z.iso.date(), id: z.uuid() })
const Query = z.object({ jobId: z.uuid(), after: z.string().max(64).optional() })
const Approve = z.object({ jobId: z.uuid(), paymentEntryId: z.uuid() }).strict()
function failure(status: number) {
  return NextResponse.json({ error: { code: 'HISTORICAL_RECEIVABLE_REVIEW',
    message: 'Fyndet kunde inte läsas eller godkännas. Läs in granskningen igen; underlaget kan ha ändrats.',
    message_en: 'The finding could not be loaded or approved. Reload the review; the evidence may have changed.' } }, { status })
}
function context(ctx?: ExtensionContext): ctx is ExtensionContext { return !!ctx?.companyId && !!ctx.userId }

/** Read-only discovery. Descriptions are hints, amounts and ledger direction corroborate them. */
export async function loadHistoricalReceivableFindings(ctx: ExtensionContext, jobId: string) {
  const { data: job, error } = await ctx.supabase.from('migration_jobs').select('id,provider,account_key,state,fiscal_year_scope')
    .eq('id', jobId).eq('company_id', ctx.companyId).maybeSingle()
  if (error) throw new Error('Historical job lookup failed')
  if (!job) return null
  if (job.provider !== 'bokio' || !['needs_attention', 'completed'].includes(job.state)) return { findings: [], reviewed: [] }
  type Entry = { id: string; entry_date: string; description: string; source_voucher_series: string | null; source_voucher_number: number | null }
  type Source = { id: string; source_id: string; payload: string; payload_hash: string; target_id: string | null; state: string; error_code: string | null }
  type Reviewed = { id: string; payment_journal_entry_id: string; invoice_number: string; payment_date: string; payment_amount_sek: number; customer_name: string; decision: string; origin: string }
  const [entries, chunks, invoices, reviewed] = await Promise.all([
    fetchAllRows<Entry>(({ from, to }) => {
      let query = ctx.supabase.from('journal_entries').select('id,entry_date,description,source_voucher_series,source_voucher_number')
        .eq('company_id', ctx.companyId).eq('status', 'posted').is('reversed_by_id', null)
        .or('description.ilike.Faktura%,description.ilike.Kundbet%')
      if (job.fiscal_year_scope) query = query.gte('entry_date', job.fiscal_year_scope.start).lte('entry_date', job.fiscal_year_scope.end)
      return query.order('id').range(from, to)
    }),
    fetchAllRows<Source>(({ from, to }) => ctx.supabase.from('migration_job_chunks')
      .select('id,source_id,payload,payload_hash,target_id,state,error_code').eq('company_id', ctx.companyId)
      .eq('job_id', job.id).eq('resource', 'salesInvoices').order('id').range(from, to)),
    fetchAllRows<{ invoice_number: string | null }>(({ from, to }) => ctx.supabase.from('invoices')
      .select('invoice_number').eq('company_id', ctx.companyId).order('id').range(from, to)),
    fetchAllRows<Reviewed>(({ from, to }) => ctx.supabase.from('historical_receivable_references')
      .select('id,payment_journal_entry_id,invoice_number,payment_date,payment_amount_sek,customer_name,decision,origin')
      .eq('company_id', ctx.companyId).order('id').range(from, to)),
  ])
  const decided = new Set(reviewed.map(row => row.payment_journal_entry_id))
  const eligible = entries.filter(row => !decided.has(row.id))
  const lines = await fetchLinesByEntryIds<{ id: string; journal_entry_id: string; account_number: string; debit_amount: number; credit_amount: number }>(
    ctx.supabase, eligible.map(row => row.id), 'journal_entry_id,account_number,debit_amount,credit_amount')
  const totals = new Map<string, { ar: number; bank: number }>()
  for (const line of lines) {
    const row = totals.get(line.journal_entry_id) ?? { ar: 0, bank: 0 }
    if (line.account_number.startsWith('15')) row.ar += Number(line.credit_amount) - Number(line.debit_amount)
    if (line.account_number.startsWith('19')) row.bank += Number(line.debit_amount) - Number(line.credit_amount)
    totals.set(line.journal_entry_id, row)
  }
  const payments: HistoricalPaymentEntry[] = eligible.map(row => ({ id: row.id, date: row.entry_date,
    description: row.description, series: row.source_voucher_series, number: row.source_voucher_number,
    receivableCredit: totals.get(row.id)?.ar ?? 0, bankDebit: totals.get(row.id)?.bank ?? 0 }))
  const sources: HistoricalInvoiceSource[] = chunks.map(row => ({ chunkId: row.id, sourceId: row.source_id,
    payloadHash: row.payload_hash, invoice: openMigrationPayload<SalesInvoiceDto>(row.payload), imported: !!row.target_id,
    reviewable: row.state === 'needs_attention' && row.error_code === 'MIGRATION_SOURCE_LINES_MISSING' }))
  const findings = findHistoricalReceivableCandidates(payments, sources, new Set(invoices.flatMap(row => row.invoice_number ? [row.invoice_number] : [])))
  return { findings, reviewed: reviewed.filter(row => row.decision === 'approved').sort((a, b) => {
    const left = `${a.payment_date}|${a.id}`, right = `${b.payment_date}|${b.id}`
    return left < right ? -1 : left > right ? 1 : 0
  }) }
}

export const historicalReceivableRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET', path: '/migration-jobs/historical-findings',
    handler: async (request, ctx) => {
      if (!context(ctx)) return failure(401)
      const url = new URL(request.url)
      const query = Query.safeParse({ jobId: url.searchParams.get('jobId'), after: url.searchParams.get('after') ?? undefined })
      if (!query.success) return failure(400)
      if (query.data.after) {
        const parts = query.data.after.split('|')
        if (parts.length !== 2 || !Cursor.safeParse({ date: parts[0], id: parts[1] }).success) return failure(400)
      }
      const result = await loadHistoricalReceivableFindings(ctx, query.data.jobId)
      if (!result) return failure(404)
      const page = pageHistoricalReceivableFindings(result.findings, query.data.after)
      return NextResponse.json({ data: { findings: page.findings.map(({ payloadHash: _hash, ...row }) => row),
        next: page.next, reviewed: result.reviewed, total: result.findings.length } },
      { headers: { 'Cache-Control': 'no-store' } })
    },
  },
  {
    method: 'POST', path: '/migration-jobs/historical-findings/approve',
    handler: async (request, ctx) => {
      if (!context(ctx)) return failure(401)
      const body = await validateBody(request, Approve)
      if (!body.success) return body.response
      const permission = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
      if (!permission.ok) return permission.response
      // Re-discover from the source snapshot and current live ledger. The client
      // supplies only IDs, never a trusted amount, description or approval actor.
      const current = await loadHistoricalReceivableFindings(ctx, body.data.jobId)
      if (!current) return failure(404)
      const prior = current.reviewed.find(row => row.payment_journal_entry_id === body.data.paymentEntryId)
      if (prior) return NextResponse.json({ data: { id: prior.id, alreadyApproved: true } })
      const finding = current.findings.find(row => row.paymentEntryId === body.data.paymentEntryId)
      if (!finding) return failure(409)
      const { data, error } = await createServiceClientNoCookies().rpc('review_historical_receivable', {
        p_company_id: ctx.companyId, p_user_id: ctx.userId, p_job_id: body.data.jobId,
        p_payment_id: finding.paymentEntryId, p_decision: 'approved', p_finding: finding,
      })
      if (error) return failure(error.code === '42501' ? 403 : 409)
      return NextResponse.json({ data: { id: data } })
    },
  },
]
