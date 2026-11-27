import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SpendFile } from '@accounted/connect-contract'
import { MAX_DOCUMENT_SIZE, uploadDocument, validateDocumentMagicBytes } from '@/lib/core/documents/document-service'
import { ALLOWED_DOCUMENT_TYPES } from '@/lib/documents/upload-types'
import { readBodyWithCap, safeFetch, type SafeFetchDeps } from '@/lib/http/safe-fetch'

/**
 * Store an expense's receipt files as documents when the expense arrives.
 *
 * Connect keeps its copy only until the expense is acknowledged (and its
 * links expire within minutes), so the files are archived here before the
 * acknowledgement, never at booking time. Each file is kept as the provider
 * delivered it (BFL 7 kap 1 § 3 st: in the condition it had when it reached
 * the company), checked against the sha256 Connect stated. The documents are
 * not linked to anything yet; booking links them to the verifikat.
 *
 * A file this ledger can never store (a type it does not accept, content
 * that is not what its type says, more than 10 MB) is a permanent failure:
 * the expense is rejected so the person attaches a usable file at the
 * provider. A download or a store that fails is transient: the expense is
 * left unanswered and the next run tries again with a fresh link.
 */

export type SpendReceiptOutcome =
  | { ok: true; documentIds: string[] }
  | { ok: false; permanent: boolean; reason: 'type_not_accepted' | 'too_large' | 'download_failed' | 'checksum_mismatch' | 'store_failed'; fileName: string }

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

function fileName(file: SpendFile, index: number): string {
  if (file.name) return file.name
  return `kvitto-${index + 1}.${EXTENSIONS[file.contentType] ?? 'bin'}`
}

export async function storeSpendReceipts(
  admin: SupabaseClient,
  args: { companyId: string; userId: string; itemId: string; files: SpendFile[] },
  deps: SafeFetchDeps = {},
): Promise<SpendReceiptOutcome> {
  const documentIds: string[] = []
  for (const [index, file] of args.files.entries()) {
    const name = fileName(file, index)
    if (!(ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(file.contentType)) {
      return { ok: false, permanent: true, reason: 'type_not_accepted', fileName: name }
    }
    if (file.size > MAX_DOCUMENT_SIZE) return { ok: false, permanent: true, reason: 'too_large', fileName: name }

    let bytes: Buffer | null
    try {
      const response = await safeFetch(file.downloadUrl, { method: 'GET', cache: 'no-store' }, {}, deps)
      if (!response.ok) return { ok: false, permanent: false, reason: 'download_failed', fileName: name }
      bytes = await readBodyWithCap(response, MAX_DOCUMENT_SIZE)
    } catch {
      return { ok: false, permanent: false, reason: 'download_failed', fileName: name }
    }
    if (!bytes) return { ok: false, permanent: true, reason: 'too_large', fileName: name }
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      return { ok: false, permanent: false, reason: 'checksum_mismatch', fileName: name }
    }
    // The store refuses content that is not what its type says; that file never becomes storable.
    const buffer = new Uint8Array(bytes).buffer as ArrayBuffer
    if (validateDocumentMagicBytes(buffer, file.contentType, { allowImageTypeMismatch: true })) {
      return { ok: false, permanent: true, reason: 'type_not_accepted', fileName: name }
    }

    try {
      const document = await uploadDocument(
        admin,
        args.userId,
        args.companyId,
        { name, buffer, type: file.contentType },
        // The provider already coded the expense: no AI reading per receipt.
        { upload_source: 'api', idempotency_key: `spend:${args.itemId}:${file.fileRef}`, extractionOwner: 'none' },
      )
      documentIds.push(document.id)
    } catch {
      // Storage or the database stumbled: the next run tries again, within Connect's acknowledgement deadline.
      return { ok: false, permanent: false, reason: 'store_failed', fileName: name }
    }
  }
  return { ok: true, documentIds }
}

/** The Swedish reason a permanent receipt failure sends back to the provider. */
export function receiptRejectionSv(outcome: Extract<SpendReceiptOutcome, { ok: false }>): string {
  const why =
    outcome.reason === 'too_large'
      ? 'filen är större än 10 MB'
      : outcome.reason === 'type_not_accepted'
        ? 'filtypen tas inte emot'
        : 'filen gick inte att läsa'
  return `Kvittot ${outcome.fileName} kan inte sparas i Accounted (${why}). Ladda upp en PDF eller en bild under 10 MB och exportera igen.`
}
