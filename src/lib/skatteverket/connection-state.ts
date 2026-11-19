import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { hasSkatteverketOmbudReadAccess } from './ombud-access'

const log = createLogger('skatteverket-connection-state')

/**
 * Whether the company has a Skatteverket connection, by the rule the
 * skattekonto page's saldo route uses (GET /skattekonto/saldo in the
 * skatteverket extension answers NOT_CONNECTED otherwise): a token row from
 * any member, whatever its status (a row that needs a new BankID login still
 * shows its last saldo, with its date), or Accounted's verified ombud grant.
 *
 * The saldo snapshot outlives a disconnect, so without this the
 * reconciliation compared the books with a saldo the company no longer
 * reads (crm#1701). 'unknown' when the token read fails: a failed read never
 * says "not connected".
 */
export type SkatteverketConnectionState = 'connected' | 'not_connected' | 'unknown'

export async function readSkatteverketConnection(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SkatteverketConnectionState> {
  const { data, error } = await supabase
    .from('skatteverket_tokens')
    .select('id')
    .eq('company_id', companyId)
    .limit(1)
  if (error) {
    log.warn('skatteverket token read failed', { companyId, error: error.message })
    return 'unknown'
  }
  if ((data ?? []).length > 0) return 'connected'
  return (await hasSkatteverketOmbudReadAccess(companyId)) ? 'connected' : 'not_connected'
}
