/**
 * Which numbers we send to SCB.
 *
 * A Swedish organisationsnummer for a juridisk person has 20 or more in
 * positions 3 and 4 (the "month" slot), which is how it is told apart from a
 * personnummer. A sole trader's org number IS a personnummer, so a lookup
 * would be personal-data processing with SCB as an independent controller;
 * the plan keeps sole traders out of registry enrichment in this phase (no
 * credit or registry facts on natural persons, GDPR Art. 14 notice first).
 */
export function isLegalPersonOrgNumber(orgNumber: string | null | undefined): boolean {
  const d = (orgNumber ?? '').replace(/[^0-9]/g, '')
  if (d.length !== 10) return false
  const month = Number(d.slice(2, 4))
  return month >= 20
}

/** SCB's PeOrgNr: 16 + the ten-digit org number for legal persons. */
export function toPeOrgNr(orgNumber: string): string {
  const d = orgNumber.replace(/[^0-9]/g, '')
  return d.length === 10 ? `16${d}` : d
}
