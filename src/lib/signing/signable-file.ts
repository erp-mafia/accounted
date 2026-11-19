/**
 * What BankID signing takes: one PDF of at most SIGNING_MAX_DOCUMENT_BYTES.
 * The one definition of that rule for both sides. The server reads a stored
 * document through it (loadSignableDocument), the Arkiv record offers "Begär
 * signering" by it, and Signeringar refuses a picked file by it before
 * anything is uploaded. Pure, so a client component can import it.
 */
import { declaredDocumentType } from '@/lib/documents/upload-types'
import { SIGNING_MAX_DOCUMENT_BYTES } from './types'

export const SIGNABLE_MIME_TYPE = 'application/pdf'

/** The file picker's `accept` for a document to sign: the extension first, the type for pickers that filter on it. */
export const SIGNABLE_FILE_ACCEPT = `.pdf,${SIGNABLE_MIME_TYPE}`

/** Whether a document of this stored type can be sent for signing. */
export function isSignableMimeType(mimeType: string | null | undefined): boolean {
  return mimeType === SIGNABLE_MIME_TYPE
}

export type SignableFileRefusal = 'not_pdf' | 'too_large'

/**
 * Why a picked file cannot be sent for signing, or null when it can. The
 * type is read as the archive reads it (the declared one, or the one the
 * extension implies when the browser declared none); the bytes are verified
 * by the upload itself.
 */
export function signableFileRefusal(file: { name?: string | null; type?: string | null; size: number }): SignableFileRefusal | null {
  if (!isSignableMimeType(declaredDocumentType(file))) return 'not_pdf'
  if (file.size > SIGNING_MAX_DOCUMENT_BYTES) return 'too_large'
  return null
}
