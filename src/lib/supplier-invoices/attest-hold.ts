/**
 * Whether the attest policy holds a supplier invoice back from payment
 * (paymentWaitsForAttest, the payment file's attest_required), read once for a
 * list of one company's invoices: the Att betala tab and status=to_pay leave
 * those out (lib/supplier-invoices/to-pay.ts).
 *
 * A failed read answers "not held" and logs it: a list a person looks at
 * still shows, and every payment path reads the policy again and refuses on
 * its own. With `strict` it throws instead, for a door whose answer is the
 * population itself: an agent told that a held invoice waits to be paid
 * (MCP status=to_pay) acts on it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { paymentWaitsForAttest, type AttestInvoiceFacts } from './attest-policy'
import { loadAttestPolicy } from './attest-policy-read'

const log = createLogger('supplier-invoices/attest-hold')

export type AttestHold = (invoice: AttestInvoiceFacts & { approved_at: string | null }) => boolean

export async function readAttestHold(
  supabase: SupabaseClient,
  companyId: string,
  options: { strict?: boolean } = {},
): Promise<AttestHold> {
  try {
    const [policy, { data: settings, error }] = await Promise.all([
      loadAttestPolicy(supabase, companyId),
      supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
    ])
    if (error) throw error
    const accountingMethod = ((settings as { accounting_method?: string | null } | null)?.accounting_method) ?? null
    return (invoice) => paymentWaitsForAttest(policy, accountingMethod, invoice)
  } catch (err) {
    if (options.strict) throw err
    log.warn('attest policy read for a supplier invoice list failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return () => false
  }
}
