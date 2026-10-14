/**
 * What the settings section "Attest" reads and writes beside the policy: the
 * members who can be picked as attesters, whether the signed-in user may edit
 * the policy, and the user's own switch for the attest mail
 * (notification_settings.attest_request_email_enabled, per person, default on).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { createServiceClient } from '@/lib/supabase/server'
import { loadAttestPolicy } from './attest-policy-read'
import type { AttestPolicy } from './attest-policy'
import { loadAttestPeople } from './attest-service'

export interface AttestCandidate {
  user_id: string
  name: string | null
  email: string | null
  role: 'owner' | 'admin' | 'member'
}

export interface AttestSettingsView {
  policy: AttestPolicy
  /** Members who may be attesters: everyone who may write (viewers cannot attest). */
  candidates: AttestCandidate[]
  /** Owners and admins edit the policy; everyone else reads it. */
  can_edit: boolean
  /** The signed-in user's own switch for the attest mail. */
  mail_enabled: boolean
  /** Kontantmetoden has no attest step: the section says so. */
  accounting_method: string | null
}

export async function loadAttestSettingsView(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<AttestSettingsView> {
  const service = createServiceClient()
  const [policy, canEdit, { data: members, error: membersError }, { data: prefs }, { data: settings }] = await Promise.all([
    loadAttestPolicy(supabase, companyId),
    isCompanyAdmin(supabase, companyId),
    service.from('company_members').select('user_id, role').eq('company_id', companyId),
    supabase.from('notification_settings').select('attest_request_email_enabled').eq('user_id', userId).maybeSingle(),
    supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
  ])
  if (membersError) throw membersError
  const writers = ((members ?? []) as Array<{ user_id: string; role: string }>).filter((m) => m.role !== 'viewer')
  const people = await loadAttestPeople(service, writers.map((m) => m.user_id))
  return {
    policy,
    candidates: writers.map((m) => ({
      ...(people.get(m.user_id) ?? { user_id: m.user_id, name: null, email: null }),
      role: m.role as AttestCandidate['role'],
    })),
    can_edit: canEdit,
    mail_enabled: (prefs as { attest_request_email_enabled?: boolean | null } | null)?.attest_request_email_enabled !== false,
    accounting_method: (settings as { accounting_method?: string | null } | null)?.accounting_method ?? null,
  }
}

/** Switch the attest mail on or off for the signed-in user: their own notification_settings row (RLS: own row only). */
export async function saveAttestMailPreference(supabase: SupabaseClient, userId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('notification_settings')
    .upsert({ user_id: userId, attest_request_email_enabled: enabled }, { onConflict: 'user_id' })
  if (error) throw error
}
