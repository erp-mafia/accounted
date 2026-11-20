import { orgNumberKey } from '@/lib/invariants/org-number'

/** SCB's PeOrgNr: 16 + the ten-digit org number for legal persons. */
export function toPeOrgNr(orgNumber: string): string {
  return `16${orgNumberKey(orgNumber) ?? orgNumber}`
}
