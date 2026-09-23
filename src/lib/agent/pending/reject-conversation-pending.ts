import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Reject every still-pending proposal the assistant staged in one conversation.
 *
 * When the assistant proposes several verifikat and the user approves only some,
 * the rest linger as pending_operations in Granskning until the 30-day expiry —
 * the "manually clean up afterward" friction users reported. This clears the
 * leftovers in one shot: the chat's "clear the rest" button and the auto-clean
 * on conversation archive both call it.
 *
 * Only `status = 'pending'` rows are touched (never a committing/committed one,
 * which would stamp 'rejected' over a posted verifikat — the same guard the
 * single/bulk reject routes use). Company-scoped. Returns how many were cleared.
 */
export async function rejectPendingForConversation(
  supabase: SupabaseClient,
  companyId: string,
  conversationId: string,
): Promise<number> {
  const { data } = await supabase
    .from('pending_operations')
    .update({
      status: 'rejected',
      resolved_at: new Date().toISOString(),
      rejection_reason: 'Ej godkänd i assistenten',
    })
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .eq('agent_metadata->>conversation_id', conversationId)
    .select('id')
  return data?.length ?? 0
}
