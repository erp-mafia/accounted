/**
 * Owner tax and related parties in Bolaget: the shared vocabulary of the
 * owner loan register (ABL 21 kap.) and the K10 underlag (IL 57 kap.).
 *
 * Pure data with no server imports: client components read the enums for
 * their pickers. Every enum mirrors a CHECK in
 * supabase/migrations/20261030040000_bolaget_owner_tax.sql.
 */

/** A loan, or security the company gave for the party's debt (ABL 21:3). */
export const LOAN_KINDS = ['loan', 'security'] as const
export type LoanKind = (typeof LOAN_KINDS)[number]

/** lends: the company lends to (or secures for) the party; borrows: the party lends to the company. */
export const LOAN_DIRECTIONS = ['lends', 'borrows'] as const
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number]

/**
 * What the registers cannot tell about the party. Holders, board members and
 * the VD are read from the aktiebok and the roles; these name the rest of the
 * ABL 21:1 circle: an insider in another company of the group, a spouse,
 * cohabitant or relative of an insider (related_to_party_id), or a legal
 * person an insider controls.
 */
export const LOAN_RELATIONS = ['none', 'group_insider', 'related_person', 'controlled_entity'] as const
export type LoanRelation = (typeof LOAN_RELATIONS)[number]

/** The relations that name the insider they go through. */
export const RELATIONS_WITH_INSIDER: readonly LoanRelation[] = ['related_person', 'controlled_entity']

/**
 * The låneförbud exception a loan is granted under: group_company (21:2
 * first para p. 1), business_loan (21:2 first para p. 2: used only in the
 * borrower's business, on purely commercial grounds) or dispensation
 * (Skatteverket, 21:8). The 1 % holding exception is read from the aktiebok.
 */
export const LOAN_EXCEPTIONS = ['none', 'group_company', 'business_loan', 'dispensation'] as const
export type LoanException = (typeof LOAN_EXCEPTIONS)[number]

/** The exceptions whose loans go on the special list kept ten years (ABL 21:10). */
export const SPECIAL_LIST_EXCEPTIONS: readonly LoanException[] = ['business_loan', 'dispensation']

export const LOAN_STATUSES = ['active', 'repaid', 'cancelled'] as const
export type LoanStatus = (typeof LOAN_STATUSES)[number]

/**
 * The BAS 2026 accounts an owner loan is booked on: 1360 Lån till delägare
 * eller närstående (långfristig del) or 1685 Kortfristiga fordringar hos
 * delägare eller närstående when the company lends; 2393 Lån från
 * närstående personer (långfristig del) or 2893 Skulder till närstående
 * personer (kortfristig del) when it borrows. Any account of those groups
 * is accepted (1360-1368, 1680-1689, 2390-2399, 2890-2899).
 */
export const LOAN_ACCOUNT_PATTERN = /^(136[0-8]|168[0-9]|239[0-9]|289[0-9])$/
export const DEFAULT_LOAN_ACCOUNTS: Record<LoanDirection, { long: string; short: string }> = {
  lends: { long: '1360', short: '1685' },
  borrows: { long: '2393', short: '2893' },
}

/** Whether the account is on the right side for the direction (an asset when the company lends). */
export function accountFitsDirection(account: string, direction: LoanDirection): boolean {
  return LOAN_ACCOUNT_PATTERN.test(account) && (direction === 'lends') === account.startsWith('1')
}

export const LOAN_RELATION_LABELS_SV: Record<LoanRelation, string> = {
  none: 'Enligt aktieboken och rollerna',
  group_insider: 'Aktieägare, styrelseledamot eller VD i annat koncernbolag',
  related_person: 'Närstående (make, sambo eller släkting)',
  controlled_entity: 'Juridisk person som kontrolleras av en insider',
}

export const LOAN_EXCEPTION_LABELS_SV: Record<LoanException, string> = {
  none: 'Inget undantag',
  group_company: 'Koncernföretag (21 kap. 2 § första stycket 1 ABL)',
  business_loan: 'Affärsmässigt lån till låntagarens rörelse (21 kap. 2 § första stycket 2 ABL)',
  dispensation: 'Dispens från Skatteverket (21 kap. 8 § ABL)',
}
