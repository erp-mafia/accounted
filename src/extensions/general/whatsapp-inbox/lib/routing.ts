/**
 * Which company a conversation is routed to right now: the one a receipt
 * sent this moment would be filed into. Read-only, so the receipt worker
 * (process-inbound.ts) and anything else that asks get the same answer.
 *
 * The ladder: the conversation's pin (live, and the sender still a member),
 * then the link's default company (still a member), then the sender's only
 * membership. Every membership here means a company that is not archived and
 * a role that takes receipts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { WhatsAppConversation, WhatsAppPhoneLink } from '@/types'
import { hasLivePin } from './conversation'

const log = createLogger('whatsapp-inbox/routing')

export interface RoutedCompany {
  companyId: string
  /** The step of the ladder that answered. */
  via: 'pin' | 'default' | 'single'
}

/** Live membership: a pin or default pointing at an ARCHIVED company must not
 *  receive receipts (same filter shape as lib/supabase/middleware.ts). */
export async function isMember(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    // An invoicing-only membership (lib/auth/invoicer-role.ts) takes no receipts.
    .neq('role', 'invoicer')
    .is('companies.archived_at', null)
    .limit(1)
    .maybeSingle()
  return data != null
}

/**
 * The company the conversation is routed to, null when there is none (the
 * sender has several companies and neither a pin nor a default), or
 * 'transient_error' when the membership query FAILED: a DB blip must not
 * read as "no memberships".
 */
export async function resolveRoutedCompany(
  supabase: SupabaseClient,
  link: Pick<WhatsAppPhoneLink, 'user_id' | 'default_company_id'>,
  conversation: WhatsAppConversation | null,
  now: Date = new Date(),
): Promise<RoutedCompany | null | 'transient_error'> {
  if (conversation && hasLivePin(conversation, now) && conversation.company_id) {
    if (await isMember(supabase, link.user_id, conversation.company_id)) {
      return { companyId: conversation.company_id, via: 'pin' }
    }
  }

  if (link.default_company_id && (await isMember(supabase, link.user_id, link.default_company_id))) {
    return { companyId: link.default_company_id, via: 'default' }
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from('company_members')
    .select('company_id, companies!inner(archived_at)')
    .eq('user_id', link.user_id)
    // An invoicing-only membership (lib/auth/invoicer-role.ts) takes no receipts.
    .neq('role', 'invoicer')
    .is('companies.archived_at', null)
  if (membershipsError) {
    log.warn('membership query failed during company resolution; will retry', {
      error: membershipsError.message,
    })
    return 'transient_error'
  }
  const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]
  if (companyIds.length === 1) return { companyId: companyIds[0], via: 'single' }
  return null
}
