import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runInvoiceCompletion } from '@/extensions/general/arcim-migration/lib/invoice-completion-worker'
import { runBokioSupplierCompletion } from '@/extensions/general/arcim-migration/lib/complete-bokio-supplier-invoices'

export const maxDuration = 300
const RUN_BUDGET_MS = 240_000

export const GET = withCronContext('cron.arcim_migration_complete_invoice_lines', async (_request, ctx) => {
  // Include extension initialization (the wrapper's gate), discovery,
  // credential refresh, provider reads, persistence and reporting in one
  // absolute window, with headroom below the platform limit.
  const deadline = ctx.startedAt + RUN_BUDGET_MS
  const supabase = createServiceClientNoCookies()
  const supplierCompletion = await runBokioSupplierCompletion(supabase, Math.min(deadline, Date.now() + 90_000)).catch((error: unknown) => {
    // The whole pass failed before any company ran: its queue could not be
    // read. This was a warning with no error in it, which reaches nobody.
    // Out of time is the one deferral.
    const reason = error instanceof Error ? error.message : String(error)
    if (reason === 'MIGRATION_DEADLINE') ctx.log.warn('Bokio supplier completion deferred: out of time')
    else ctx.log.error('Bokio supplier completion failed', error as Error, { code: (error as { code?: unknown } | null)?.code ?? reason })
    return { failed: true }
  })
  const summary = await runInvoiceCompletion(supabase, deadline)
  ctx.log.info('complete-invoice-lines run finished', summary)
  return NextResponse.json({ data: summary, supplierCompletion })
}, { requireExtension: 'arcim-migration' })
