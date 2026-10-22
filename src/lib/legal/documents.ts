/**
 * The published legal documents: the one place their dates and versions live.
 *
 * The pages render `updatedAt`; the acceptance flow records `acceptanceVersion`.
 * They are separate on purpose: a typo fix or a newly listed field moves
 * `updatedAt` only, while a change the customer has to agree to again (new
 * rights for us, new obligations for them) moves `acceptanceVersion`, and
 * that is what puts the re-acceptance prompt in front of existing users.
 *
 * The privacy policy is information, not a contract, so it carries no
 * acceptance version: it is linked from the acceptance prompt, never agreed to.
 */

export type LegalDocumentKey = 'terms' | 'privacy' | 'dpa' | 'subprocessors'

/**
 * The company behind the hosted service, as the documents name it. Address
 * and VAT number are what Bolagsverket and Skatteverket hold; aktiebolagslagen
 * 28 kap. 5 § and e-handelslagen 8 § want them on the site.
 */
export const LEGAL_PROVIDER = {
  name: 'Arcim Technology AB',
  orgNumber: '559538-6219',
  vatNumber: 'SE559538621901',
  address: 'Östermalmsgatan 26 A, 114 26 Stockholm',
  seat: 'Stockholm',
  email: 'support@accounted.se',
} as const

export interface LegalDocument {
  key: LegalDocumentKey
  /** Public path inside the app. */
  path: string
  /** Shown on the page as "Senast uppdaterad". ISO date. */
  updatedAt: string
  /** The version a user accepts. ISO date of the last change that needs re-acceptance; null when the document is never accepted. */
  acceptanceVersion: string | null
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentKey, LegalDocument> = {
  terms: {
    key: 'terms',
    path: '/terms',
    updatedAt: '2026-03-05',
    acceptanceVersion: '2026-03-05',
  },
  privacy: {
    key: 'privacy',
    path: '/privacy',
    updatedAt: '2026-10-21',
    acceptanceVersion: null,
  },
  dpa: {
    key: 'dpa',
    path: '/dpa',
    updatedAt: '2026-10-22',
    acceptanceVersion: '2026-10-21',
  },
  // Part of the DPA (its point 6), kept on its own page so it can change
  // without a new DPA version: a new sub-processor is announced 30 days ahead
  // instead of re-accepted.
  subprocessors: {
    key: 'subprocessors',
    path: '/subprocessors',
    updatedAt: '2026-10-21',
    acceptanceVersion: null,
  },
}

/** Every legal page path; the middleware serves these without a session. */
export const LEGAL_PATHS: string[] = (Object.values(LEGAL_DOCUMENTS) as LegalDocument[]).map(
  (d) => d.path,
)

/** The documents a user must have accepted at their current version. */
export const ACCEPTED_DOCUMENTS: LegalDocumentKey[] = (
  Object.values(LEGAL_DOCUMENTS) as LegalDocument[]
)
  .filter((d) => d.acceptanceVersion !== null)
  .map((d) => d.key)
