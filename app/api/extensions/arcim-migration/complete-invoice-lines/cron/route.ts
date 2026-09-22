import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { runInvoiceCompletion } from '@/extensions/general/arcim-migration/lib/invoice-completion-worker'
import { runBokioSupplierCompletion } from '@/extensions/general/arcim-migration/lib/complete-bokio-supplier-invoices'

export const maxDuration = 300
const RUN_BUDGET_MS = 240_000

export const GET = withCronContext('cron.arcim_migration_complete_invoice_lines', async (_request, ctx) => {
  // Include discovery, credential refresh, provider reads, persistence and
  // reporting in one absolute window, with headroom below the platform limit.
  const deadline = Date.now() + RUN_BUDGET_MS
  loadExtensions()
  if (!extensionRegistry.get('arcim-migration')) {
    return NextResponse.json(
      { error: 'Migration extension is not enabled', code: 'EXTENSION_DISABLED' }, { status: 503 },
    )
  }
  const supabase = createServiceClientNoCookies()
  const supplierCompletion = await runBokioSupplierCompletion(supabase, Math.min(deadline, Date.now() + 90_000)).catch(() => {
    ctx.log.warn('Bokio supplier completion deferred')
    return { failed: true }
  })
  const summary = await runInvoiceCompletion(supabase, deadline)
  ctx.log.info('complete-invoice-lines run finished', summary)
  return NextResponse.json({ data: summary, supplierCompletion })
})
