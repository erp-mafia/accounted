import type { SupabaseClient } from '@supabase/supabase-js'
import { parseAccountKey } from '@/lib/reconciliation/schemas'
import { listReconciliationAccounts } from '@/lib/reconciliation/service'
import { findCompanyTokenUser } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { createLogger } from '@/lib/logger'

const log = createLogger('mcp-server:reconciliation-key-error')

export const SKATTEKONTO_NOT_CONNECTED_MESSAGE =
  'Skattekontot är inte kopplat för bolaget. Koppla Skatteverket under Inställningar (eller gnubok_connect_skatteverket) så finns account_key skattekonto.'

export const SKATTEKONTO_NOT_SYNCED_MESSAGE =
  'Skatteverket är kopplat men inga skattekontohändelser har hämtats ännu. account_key skattekonto finns när den första hämtningen är klar.'

/**
 * The reconciliation services answer null for an account key the company
 * cannot resolve. For "skattekonto" that null has one cause the agent can act
 * on (no Skatteverket data yet), so name it; for every other key, list the keys
 * that do exist so the next call is a pick, not a guess.
 */
export async function unknownAccountKeyError(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
): Promise<Error> {
  const parsed = parseAccountKey(accountKey)
  if (parsed?.kind === 'skattekonto') {
    let connected = false
    try {
      connected = (await findCompanyTokenUser(supabase, companyId)) !== null
    } catch (err) {
      // A lookup failure must not hide the original "unknown key" answer, but
      // it is not the same as "not connected" either, so it leaves a trace.
      log.warn('skatteverket connection lookup failed while explaining account_key', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      connected = false
    }
    return new Error(connected ? SKATTEKONTO_NOT_SYNCED_MESSAGE : SKATTEKONTO_NOT_CONNECTED_MESSAGE)
  }

  let known: string[] = []
  try {
    const accounts = await listReconciliationAccounts(supabase, companyId, { withStatus: false })
    known = (accounts ?? []).map((account) => account.account_key)
  } catch (err) {
    log.warn('reconciliation account listing failed while explaining account_key', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    known = []
  }
  const format = parsed ? '' : ' Format: "skattekonto", "bank:<cash_account_id>" or "manual:<BAS>".'
  const keys = known.length > 0
    ? ` Known keys: ${known.join(', ')}.`
    : ' No reconciliation accounts yet: connect a bank or Skatteverket, or use manual:<BAS>.'
  return new Error(`Unknown account_key "${accountKey}" for this company.${format}${keys}`)
}
