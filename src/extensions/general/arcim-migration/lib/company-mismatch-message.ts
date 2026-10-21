import { formatOrgNumber } from '@/lib/utils'

/** What a ProviderCompanyMismatchError carries, read structurally. */
export interface CompanyMismatchFacts {
  expectedOrgNumber: string
  actualOrgNumber: string
  actualCompanyName: string | null
}

/**
 * The sentence a user reads when valid provider credentials open another
 * company than the one being imported into (PROVIDER_COMPANY_MISMATCH).
 *
 * It names the company the connection opened and gives both ways out (PH 193).
 * The common case is a bookkeeper bringing in a client company while still
 * standing in their own company in Accounted: choosing again at the provider,
 * the only advice the registry sentence gave, can never help them. They add
 * the company in Accounted first and connect from there. The registry entry
 * stays the static fallback for an envelope without these facts.
 */
export function companyMismatchMessages(facts: CompanyMismatchFacts): { sv: string; en: string } {
  const actual = formatOrgNumber(facts.actualOrgNumber)
  const expected = formatOrgNumber(facts.expectedOrgNumber)
  const name = facts.actualCompanyName?.trim() || null
  const openedSv = name ? `${name} (org.nr ${actual})` : `ett annat företag (org.nr ${actual})`
  const openedEn = name ? `${name} (org. no. ${actual})` : `another company (org. no. ${actual})`
  return {
    sv: `Anslutningen gäller ${openedSv}, inte företaget du importerar till (org.nr ${expected}). ` +
      `Ska ${name ?? 'det företaget'} flyttas till Accounted? Välj då Lägg till företag i företagsmenyn ` +
      '(klicka på företagsnamnet) och anslut därifrån. Annars: anslut igen och välj rätt företag.',
    en: `The connection opened ${openedEn}, not the company you are importing into (org. no. ${expected}). ` +
      `To move ${name ?? 'that company'} to Accounted, choose Add company in the company menu ` +
      '(click the company name) and connect from there. Otherwise, connect again and pick the right company.',
  }
}
