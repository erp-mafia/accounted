/**
 * The formation package's catalogue without the builders: which documents
 * exist, in which formats, and when each applies. The browser reads this
 * (the package page lists the documents); the builders, which pull in
 * server-side formatting, stay behind `./index.ts`.
 */

import { type FormationAnswers, founders } from '../answers'

export const FORMATION_DOCUMENT_SLUGS = [
  'verksamt',
  'bolagsordning',
  'stiftelseurkund',
  'styrelseprotokoll',
  'aktiebok',
  'skatteverket',
  'bank',
  'aktieagaravtal',
] as const
export type FormationDocumentSlug = (typeof FORMATION_DOCUMENT_SLUGS)[number]

export type FormationDocumentFormat = 'pdf' | 'docx'

export interface FormationCatalogEntry {
  slug: FormationDocumentSlug
  /** i18n key for the document's name in the UI. */
  titleKey: `formation.documents.${FormationDocumentSlug}`
  formats: readonly FormationDocumentFormat[]
  available(answers: FormationAnswers): boolean
}

const always = () => true

export const FORMATION_CATALOG: readonly FormationCatalogEntry[] = [
  { slug: 'verksamt', titleKey: 'formation.documents.verksamt', formats: ['pdf'], available: always },
  { slug: 'bolagsordning', titleKey: 'formation.documents.bolagsordning', formats: ['pdf', 'docx'], available: always },
  { slug: 'stiftelseurkund', titleKey: 'formation.documents.stiftelseurkund', formats: ['pdf', 'docx'], available: always },
  { slug: 'styrelseprotokoll', titleKey: 'formation.documents.styrelseprotokoll', formats: ['pdf', 'docx'], available: always },
  { slug: 'aktiebok', titleKey: 'formation.documents.aktiebok', formats: ['pdf', 'docx'], available: always },
  { slug: 'skatteverket', titleKey: 'formation.documents.skatteverket', formats: ['pdf'], available: always },
  { slug: 'bank', titleKey: 'formation.documents.bank', formats: ['pdf'], available: always },
  // Only meaningful between two or more founders.
  { slug: 'aktieagaravtal', titleKey: 'formation.documents.aktieagaravtal', formats: ['pdf', 'docx'], available: (a) => founders(a).length >= 2 },
]

export function isFormationDocumentSlug(value: string): value is FormationDocumentSlug {
  return (FORMATION_DOCUMENT_SLUGS as readonly string[]).includes(value)
}
