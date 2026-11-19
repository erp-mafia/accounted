import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingRpcSignature } from '@/lib/bookkeeping/actor-rpc'
import { toError } from '@/lib/errors/to-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('extensions/arcim-migration/replaced-copy-underlag')

/**
 * How many live verifikat lack the underlag an earlier "Hämta underlag" left
 * on the copy a re-run migration then reversed (#51).
 *
 * A re-run (an SIE re-sync of a year) reverses every verifikat the earlier
 * import brought in and imports the year again; documents stay on the
 * reversed copy, because a document linked to a posted verifikat is never
 * moved or deleted. The underlag sweep links to the live copy only, so the
 * same "Hämta underlag" run gives each live copy its own document. The
 * migration workspace offers that run while this is above zero.
 *
 * One read: the underlag_left_on_replaced_copies RPC (migration
 * 20261110090000), which counts open years only, since a closed or locked
 * year refuses the link. Any failure answers 0, so the offer stays away
 * instead of the page breaking, as the worklist counts do.
 */
export async function countUnderlagOnReplacedCopies(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('underlag_left_on_replaced_copies', {
      p_company_id: companyId,
    })
    if (error) {
      // The minutes between a deploy and its migration: clears itself.
      if (isMissingRpcSignature(error)) {
        log.warn('replaced-copy underlag count skipped, function not migrated yet', { companyId, code: error.code })
      } else {
        log.error('replaced-copy underlag count failed', toError(error), { companyId })
      }
      return 0
    }
    return typeof data === 'number' && Number.isInteger(data) && data > 0 ? data : 0
  } catch (err) {
    log.error('replaced-copy underlag count failed', toError(err), { companyId })
    return 0
  }
}
