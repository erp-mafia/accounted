import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { hasCapability } from '@/lib/entitlements/has-capability'
import type { CompanySendingDomain } from '@/types'

/**
 * Sender identity for invoice email: the From header's display name and
 * address. Only used when a company has opted in to its own sending domain;
 * otherwise invoice mail keeps the platform sender.
 */
export interface InvoiceSenderIdentity {
  name: string
  address: string
}

type SenderRow = Pick<
  CompanySendingDomain,
  'domain' | 'status' | 'enabled' | 'sender_local_part' | 'sender_name'
>

/** `<local>@<domain>`; pure, so the address shape is unit-testable. */
export function buildSenderAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain}`
}

/**
 * Pure mapping from a sending-domain row to the From identity, or undefined
 * when the row must not change the sender (unverified, paused, or missing).
 * Falls back to the company name when no explicit sender name is stored.
 */
export function senderFromRow(
  row: SenderRow | null | undefined,
  companyName: string | null | undefined,
): InvoiceSenderIdentity | undefined {
  if (!row || row.status !== 'verified' || !row.enabled) return undefined
  const name = (row.sender_name ?? companyName ?? '').trim()
  if (!name) return undefined
  return { name, address: buildSenderAddress(row.sender_local_part, row.domain) }
}

/**
 * Resolve the From identity for a company's invoice email.
 *
 * Returns undefined in every case where the platform sender should be used:
 * no sending-domain row, not verified, paused, no capability grant (the
 * opt-in can lapse), or any read error. Never throws: a sender lookup
 * failure must never stop an invoice from going out.
 *
 * Order matters for cost: most companies have no row, so the table read
 * happens first and the two entitlement queries only run for opted-in
 * companies.
 */
export async function resolveInvoiceSender(
  supabase: SupabaseClient,
  companyId: string,
  companyName: string | null | undefined,
): Promise<InvoiceSenderIdentity | undefined> {
  try {
    const { data, error } = await supabase
      .from('company_sending_domains')
      .select('domain, status, enabled, sender_local_part, sender_name')
      .eq('company_id', companyId)
      .eq('status', 'verified')
      .eq('enabled', true)
      .maybeSingle()
    if (error || !data) return undefined

    const sender = senderFromRow(data as SenderRow, companyName)
    if (!sender) return undefined

    const entitled = await hasCapability(supabase, companyId, CAPABILITY.custom_sender_domain)
    return entitled ? sender : undefined
  } catch {
    return undefined
  }
}
