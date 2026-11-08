import type { ResolvedConsent } from '@/lib/providers/resolve-consent'

export function bokioAccountKey(connection: ResolvedConsent, consentId: string): string {
  return String(connection.consent.org_number ?? '').replace(/[^a-z0-9]/gi, '') || connection.providerCompanyId || consentId
}
