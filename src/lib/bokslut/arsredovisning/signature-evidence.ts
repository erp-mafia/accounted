/**
 * The evidence a recorded årsredovisning signature points at. The signed
 * copy (a scan of the paper original or the e-signed PDF) is räkenskaps-
 * information kept for seven years (BFL 7 kap.), so its natural home is the
 * company's archive, and the reference is that document: document:<id>.
 * The signing step lists the archive and uploads into it, so nobody has to
 * type an opaque reference by hand (PH 186: the only references ever
 * recorded were the input's placeholder).
 */

const DOCUMENT_PREFIX = 'document:'

/** The evidence reference for an archive document (the evidence_reference format). */
export function documentEvidenceReference(documentId: string): string {
  return `${DOCUMENT_PREFIX}${documentId}`
}

/** The archive document a reference points at, or null for any other reference. */
export function evidenceDocumentId(reference: string): string | null {
  const trimmed = reference.trim()
  return trimmed.startsWith(DOCUMENT_PREFIX) ? trimmed.slice(DOCUMENT_PREFIX.length) || null : null
}

export interface EvidenceCandidate {
  document_id: string
  created_at: string
  doc_type: string | null
}

/** Archive documents for the picker: the ones typed as an årsredovisning first, then the latest upload first. */
export function orderEvidenceCandidates<T extends EvidenceCandidate>(documents: readonly T[]): T[] {
  const rank = (document: T) => (document.doc_type === 'annual_report' ? 0 : 1)
  return [...documents].sort(
    (left, right) => rank(left) - rank(right) || right.created_at.localeCompare(left.created_at),
  )
}
