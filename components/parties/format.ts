import type { LedgerStats, PartyRole, RegisterRow } from '@/lib/parties/register'
import type { SuggestionReason } from '@/lib/parties/suggest'
import { formatOrgNumber } from '@/lib/utils'

/** next-intl translator shape the register components accept. */
export type Translate = (key: string, values?: Record<string, string | number>) => string

export function rhythmLabel(t: Translate, rhythm: LedgerStats['rhythm']): string {
  return rhythm ? t(`rhythm_${rhythm}`) : ''
}

export function roleLabel(t: Translate, roles: RegisterRow['roles']): string {
  const parts: string[] = []
  if (roles.supplierId) parts.push(t('role_supplier'))
  if (roles.customerId) parts.push(t('role_customer'))
  return parts.length ? parts.join(' · ') : t('role_none')
}

/** "Leverantör", "Kund" or "Leverantör · Kund": what a suggestion becomes. */
export function rolesLabel(t: Translate, roles: PartyRole[]): string {
  const parts: string[] = []
  if (roles.includes('supplier')) parts.push(t('role_supplier'))
  if (roles.includes('customer')) parts.push(t('role_customer'))
  return parts.join(' · ')
}

/** "Org.nr 556354-5185 i 3 underlag · 12 verifikat · varje månad": why a row is in the queue. */
export function reasonText(t: Translate, reason: SuggestionReason | null, rhythm: LedgerStats['rhythm'], orgNumber: string | null = null): string {
  if (!reason) return ''
  const parts: string[] = []
  const docs = Math.max(0, (reason.docs ?? 0) - (reason.self_docs ?? 0))
  // An org number the person picked from the register (no document carries
  // it) is stated as such; the stored reason predates the pick.
  const picked = Boolean(orgNumber) && !reason.org_number
  if (reason.org_number) parts.push(t('reason_org', { org: formatOrgNumber(reason.org_number), docs }))
  else if (picked) parts.push(t('reason_org_picked', { org: formatOrgNumber(orgNumber!) }))
  else if (reason.ambiguous_orgs?.length) parts.push(t('reason_ambiguous'))
  else if (docs > 0) parts.push(t('reason_docs', { docs }))
  parts.push(t('reason_vouchers', { count: reason.occurrences ?? 0 }))
  if (rhythm && rhythm !== 'irregular') parts.push(rhythmLabel(t, rhythm))
  if (!reason.org_number && !picked && !reason.ambiguous_orgs?.length && docs === 0) parts.push(t('reason_ledger_only'))
  if (reason.similar_to?.length) parts.push(t('reason_similar', { name: reason.similar_to[0]!.display_name }))
  return parts.join(' · ')
}

/** 53170900 reads 5317-0900; 7-digit bankgiro 531-7090; plusgiro keeps its check digit after the hyphen. */
export function formatPaymentIdentity(scheme: string, value: string): string {
  const d = value.replace(/[^0-9]/g, '')
  if (scheme === 'bankgiro' && (d.length === 7 || d.length === 8)) return `${d.slice(0, d.length - 4)}-${d.slice(-4)}`
  if (scheme === 'plusgiro' && d.length >= 2) return `${d.slice(0, -1)}-${d.slice(-1)}`
  return value
}

export function isDuplicateCandidate(row: RegisterRow): boolean {
  return row.similar.length > 0 || Boolean(row.reason?.similar_to?.length)
}

export function hasHardKey(row: RegisterRow): boolean {
  return Boolean(row.reason?.org_number || row.orgNumber)
}
