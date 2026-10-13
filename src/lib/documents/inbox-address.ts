import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The company's document inbox address: mail sent or forwarded here becomes
 * an inbox item (each attachment, or the mail body itself when there is none).
 *
 * One definition for every agent-facing read: the briefing,
 * gnubok_list_inbox_items, the Kvittojakten worklist and the company context
 * and Arkiv resources each composed it on their own, and the two reads an
 * agent actually calls when it looks for the address (the briefing and the
 * inbox list) did not carry it at all (crm#1174).
 *
 * Null when this install has no inbound mail domain (RESEND_INBOUND_DOMAIN)
 * or the company has no active inbox. A failed read is null too: in every
 * caller the address rides along with something else and is never a reason to
 * fail that read.
 */
export async function resolveInboxAddress(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const domain = process.env.RESEND_INBOUND_DOMAIN
  if (!domain) return null
  try {
    const { data, error } = await supabase
      .from('company_inboxes')
      .select('local_part')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .maybeSingle()
    const localPart = (data as { local_part?: string } | null)?.local_part
    if (error || !localPart) return null
    return `${localPart}@${domain}`
  } catch {
    return null
  }
}
