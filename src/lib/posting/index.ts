/**
 * The posting port (Phase 2 of the building-blocks plan): every new posting
 * records what happened in business terms, linked to the verifikat it
 * produced. Step 1 (this module): the store, the port with the ledger as its
 * only adapter, the POSTING_EVENTS switch (off by default) and bank-line
 * booking as the pilot producer. See ./port.ts for the order of writes and
 * migration 20261016220000_business_events.sql for the tables.
 */
export { postingPort, createPostingPort, buildRow, BusinessEventInvalidError, type PostingPortDeps } from './port'
export { ledgerAdapter } from './ledger-adapter'
export { postingEventsMode, POSTING_EVENTS_MODES, type PostingEventsMode } from './mode'
export {
  BUSINESS_EVENT_KINDS,
  KIND_BY_SOURCE_TYPE,
  KINDS_WITHOUT_SOURCE_TYPE,
  isBusinessEventKind,
  kindForSourceType,
  type BusinessEventKind,
} from './kinds'
export {
  BUSINESS_EVENT_CATEGORIES,
  categoryForTemplateGroup,
  categoryForTransactionCategory,
  isBusinessEventCategory,
  type BusinessEventCategory,
} from './categories'
export {
  BusinessEventEvidenceSchema,
  cleanBusinessEventEvidence,
  MAX_BUSINESS_EVENT_EVIDENCE_BYTES,
  type BusinessEventEvidence,
} from './evidence'
export { mappingVersion, MAPPING_SOURCES, type MappingSource } from './mapping-version'
export { projectBusinessEvent, type ProjectedBusinessEvent } from './project'
export {
  isMissingTableError,
  type BusinessEventEntryRole,
  type BusinessEventLink,
  type BusinessEventPartyType,
  type BusinessEventRow,
  type BusinessEventTaxAmount,
} from './store'
export type {
  BusinessEventDraft,
  CommitJournalEntryRequest,
  DraftJournalEntryRequest,
  PostJournalEntryRequest,
  PostingAdapter,
  PostingPort,
  ReverseJournalEntryRequest,
} from './types'
