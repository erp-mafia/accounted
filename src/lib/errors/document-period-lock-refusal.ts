/**
 * The text enforce_period_lock_documents (migration 017, never edited) raises
 * when a document row would sit on a verifikat in a locked or closed fiscal
 * period: an upload naming the verifikat, a link, a new version. Read in two
 * places only, both answering DOC_UPLOAD_PERIOD_LOCKED: classifyError (the
 * code at every door, lib/errors/get-structured-error.ts) and
 * getErrorMessage's pattern (the sentence for a raw error). It has a file of
 * its own: the registry's browser copy carries a fixed set of exports, and a
 * test that replaces get-error-message with a mock still loads classifyError.
 */
export const DOCUMENT_PERIOD_LOCK_REFUSAL = /Cannot attach documents to entries in a locked\/closed fiscal period/i
