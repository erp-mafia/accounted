import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteSession } from './api-client'

/** The database claim commits before provider HTTP so a new sharer cannot
 * attach the consent between the last-holder check and the external DELETE.
 * The caller must first commit its own connection release. */
export async function revokeUnusedSession(
  serviceSupabase: SupabaseClient,
  sessionId: string,
): Promise<{ revoked: boolean; reason?: string }> {
  const identity = { p_provider: 'enablebanking', p_session_id: sessionId }
  const { data: claim, error: claimError } = await serviceSupabase.rpc('claim_bank_session_revocation', identity)
  if (claimError) throw Object.assign(new Error(claimError.message), { code: claimError.code })
  if (claim?.claimed === false) return { revoked: claim.reason === 'already-revoked', reason: claim.reason }
  if (claim?.claimed !== true || typeof claim.token !== 'string') throw new Error('Bank session revocation claim missing')

  let succeeded = false
  let failure: unknown
  try {
    await deleteSession(sessionId)
    succeeded = true
  } catch (error) {
    failure = error
  }
  const { data: finished, error: finishError } = await serviceSupabase.rpc('finish_bank_session_revocation', {
    ...identity, p_claim_token: claim.token, p_succeeded: succeeded,
  })
  if (!succeeded) throw failure ?? new Error('Bank session revocation failed')
  if (finishError) throw Object.assign(new Error(finishError.message), { code: finishError.code })
  if (finished !== true) throw new Error('Bank session revocation completion changed')
  return { revoked: true }
}
