import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyInbox } from '@/types'

export function composeInboxAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain}`
}

export async function getActiveInbox(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyInbox | null> {
  const { data, error } = await supabase
    .from('company_inboxes')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw new Error(`Failed to load inbox: ${error.message}`)
  return (data as CompanyInbox | null) ?? null
}

// Rotate the company's inbox address. Delegates to the rotate_company_inbox
// RPC so the three steps (deprecate, generate, insert) run inside a single
// Postgres transaction; a failure on any step rolls the whole thing back
// and the company is never left without an active inbox.
export async function rotateCompanyInbox(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyInbox> {
  const { data, error } = await supabase
    .rpc('rotate_company_inbox', { p_company_id: companyId })

  if (error || !data) {
    throw new Error(`Failed to rotate inbox: ${error?.message ?? 'no data'}`)
  }

  // The RPC returns a single row (SETOF company_inboxes).
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Failed to rotate inbox: RPC returned no row')

  return row as CompanyInbox
}

/**
 * The statuses the inbound webhook files mail for: the company's address and
 * the earlier addresses a rename kept (rename_company_inbox). A deprecated or
 * blocked address answers 410.
 */
export function inboxReceivesMail(status: string | null | undefined): boolean {
  return status === 'active' || status === 'previous'
}

/** The earlier addresses a rename kept, which still receive. Oldest first. */
export async function listPreviousInboxes(
  supabase: SupabaseClient,
  companyId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('company_inboxes')
    .select('local_part')
    .eq('company_id', companyId)
    .eq('status', 'previous')
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to load previous inboxes: ${error.message}`)
  return ((data ?? []) as Array<{ local_part: string }>).map((row) => row.local_part)
}

/**
 * Why rename_company_inbox refused: the address already carries the
 * company's name (PT409), or there is no active address to rename (P0002).
 */
export class InboxRenameRefused extends Error {
  constructor(readonly reason: 'unchanged' | 'no_active_inbox', message: string) {
    super(message)
    this.name = 'InboxRenameRefused'
  }
}

// A new address with the company's current name, while the old one keeps
// receiving as 'previous' (crm#1334). One transaction in the
// rename_company_inbox RPC, gated to owner/admin like rotation.
export async function renameCompanyInbox(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyInbox> {
  const { data, error } = await supabase
    .rpc('rename_company_inbox', { p_company_id: companyId })

  if (error?.code === 'PT409') throw new InboxRenameRefused('unchanged', error.message)
  if (error?.code === 'P0002') throw new InboxRenameRefused('no_active_inbox', error.message)
  if (error || !data) {
    throw new Error(`Failed to rename inbox: ${error?.message ?? 'no data'}`)
  }

  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Failed to rename inbox: RPC returned no row')

  return row as CompanyInbox
}
