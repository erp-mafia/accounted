/**
 * Link underlag (receipts, invoices, other räkenskapsinformation) to a
 * journal entry via POST /api/documents/{id}/link.
 *
 * Why this is a shared helper and not an inline loop per dialog:
 *
 * BFL 5 kap 7 § requires a verifikation to carry a reference to the underlag
 * it rests on, and BFL 7 kap requires that underlag to be archived with the
 * verifikat for 7 years. By the time this runs the verifikat is already
 * committed (the voucher number is assigned atomically), so a failed link
 * cannot be rolled back: it leaves a verifikat whose underlag is missing from
 * the archive. That is a compliance defect, and the only way it becomes
 * recoverable is if the user is told about it. Callers must therefore never
 * report plain success while `failed` is non-empty, and must never discard the
 * user's files on a failure.
 *
 * The contract: this function never throws and never swallows. Every target
 * ends up in exactly one of `linked` or `failed`, and a failure carries enough
 * (file name, HTTP status, error code) to name the specific documents that did
 * not attach.
 */

export interface DocumentLinkTarget {
  /** documents.id: the row POST /api/documents/{id}/link is addressed at. */
  documentId: string
  /** Shown to the user when this document fails to attach. */
  fileName?: string | null
  /** Inbox item consumed by this link (the "choose from inbox" flow). */
  inboxItemId?: string | null
  /** Bank transaction the document should also be pinned to. */
  transactionId?: string | null
}

export interface DocumentLinkFailure {
  documentId: string
  fileName: string | null
  /** HTTP status, or 0 when the request never produced a response (offline). */
  status: number
  /** Structured error code from the API envelope, when the server sent one. */
  code: string | null
  /** Best-effort human-readable reason (envelope message or thrown message). */
  reason: string | null
}

export interface LinkDocumentsResult {
  /** documentIds that attached, in input order. */
  linked: string[]
  /** Everything that did not attach. Empty means the underlag is on the books. */
  failed: DocumentLinkFailure[]
  /** First document that attached: the "first linked doc wins" pin source. */
  firstLinkedId: string | null
  /** True when nothing failed (also true for an empty target list). */
  allLinked: boolean
}

export interface LinkDocumentsOptions {
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; message_en?: string }
}

async function readErrorEnvelope(res: Response): Promise<{ code: string | null; reason: string | null }> {
  try {
    const body = (await res.json()) as ErrorEnvelope | null
    const err = body?.error
    return { code: err?.code ?? null, reason: err?.message ?? err?.message_en ?? null }
  } catch {
    // Non-JSON body (proxy error page, empty 502): the status alone is the
    // signal. Still a failure, never a silent success.
    return { code: null, reason: null }
  }
}

/**
 * Link every target to `journalEntryId`, sequentially (input order is the
 * "first linked doc wins" order the link route relies on for its transaction
 * pin). Resolves with a per-document verdict; never rejects.
 */
export async function linkDocuments(
  targets: DocumentLinkTarget[],
  journalEntryId: string,
  options: LinkDocumentsOptions = {},
): Promise<LinkDocumentsResult> {
  // Wrapped rather than assigned so the global fetch keeps its receiver.
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))

  const linked: string[] = []
  const failed: DocumentLinkFailure[] = []

  for (const target of targets) {
    const fileName = target.fileName?.trim() ? target.fileName.trim() : null
    try {
      const res = await doFetch(`/api/documents/${encodeURIComponent(target.documentId)}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journal_entry_id: journalEntryId,
          ...(target.inboxItemId ? { inbox_item_id: target.inboxItemId } : {}),
          ...(target.transactionId ? { transaction_id: target.transactionId } : {}),
        }),
      })
      if (res.ok) {
        linked.push(target.documentId)
        continue
      }
      // A 4xx/5xx here is the exact case the old inline loops missed: the
      // request completed, so nothing threw, but the underlag never attached.
      const { code, reason } = await readErrorEnvelope(res)
      failed.push({ documentId: target.documentId, fileName, status: res.status, code, reason })
    } catch (err) {
      failed.push({
        documentId: target.documentId,
        fileName,
        status: 0,
        code: null,
        reason: err instanceof Error ? err.message : null,
      })
    }
  }

  return {
    linked,
    failed,
    firstLinkedId: linked[0] ?? null,
    allLinked: failed.length === 0,
  }
}

/**
 * Comma-separated file names for the "these did not attach" message. Falls
 * back to the document id so a nameless document is still identifiable: the
 * user must always be able to tell WHICH underlag is missing.
 */
export function formatFailedDocumentNames(failures: DocumentLinkFailure[]): string {
  return failures.map((f) => f.fileName ?? f.documentId).join(', ')
}
