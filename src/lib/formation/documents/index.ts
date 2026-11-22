/**
 * The formation package: every document Accounted builds from the
 * founder's answers, with the formats it is offered in. The answer sheet
 * and the Skatteverket and bank checklists are read, not edited, so they
 * come as PDF only; the founding documents also come as Word files the
 * founders can edit.
 */

import type { FormationAnswers } from '../answers'
import type { FormationDocument } from '../document-model'
import { buildAktieagaravtal } from './aktieagaravtal'
import { buildAktiebok } from './aktiebok'
import { buildAnswerSheet } from './answer-sheet'
import { buildBankChecklist } from './bank'
import { buildBolagsordning } from './bolagsordning'
import { FORMATION_CATALOG, type FormationCatalogEntry, type FormationDocumentSlug } from './catalog'
import type { DocumentContext } from './context'
import { buildSkatteverket } from './skatteverket'
import { buildStiftelseurkund } from './stiftelseurkund'
import { buildStyrelseprotokoll } from './styrelseprotokoll'

export type { DocumentContext } from './context'
export { FORMATION_CATALOG, FORMATION_DOCUMENT_SLUGS, isFormationDocumentSlug } from './catalog'
export type { FormationCatalogEntry, FormationDocumentFormat, FormationDocumentSlug } from './catalog'
export { buildBolagetMarkdown } from './bolaget-md'
export { SIGNATORY_RULE_TEXT, signatoryRuleText } from './signatory'

const BUILDERS: Record<FormationDocumentSlug, (answers: FormationAnswers, ctx: DocumentContext) => FormationDocument> = {
  verksamt: buildAnswerSheet,
  bolagsordning: buildBolagsordning,
  stiftelseurkund: buildStiftelseurkund,
  styrelseprotokoll: buildStyrelseprotokoll,
  aktiebok: buildAktiebok,
  skatteverket: buildSkatteverket,
  bank: buildBankChecklist,
  aktieagaravtal: buildAktieagaravtal,
}

export interface FormationDocumentEntry extends FormationCatalogEntry {
  build(answers: FormationAnswers, ctx: DocumentContext): FormationDocument
}

export const FORMATION_DOCUMENTS: readonly FormationDocumentEntry[] = FORMATION_CATALOG.map((entry) => ({
  ...entry,
  build: BUILDERS[entry.slug],
}))

/** The document for `slug`, or null when the slug is unknown or the document does not apply. */
export function buildFormationDocument(
  slug: string,
  answers: FormationAnswers,
  ctx: DocumentContext,
): FormationDocument | null {
  const entry = FORMATION_DOCUMENTS.find((d) => d.slug === slug)
  if (!entry || !entry.available(answers)) return null
  return entry.build(answers, ctx)
}
