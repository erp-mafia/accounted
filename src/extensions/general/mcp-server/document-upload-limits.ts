import { MAX_DOCUMENT_SIZE } from '@/lib/core/documents/document-service'
import { HOSTED_MAX_UPLOAD_BYTES, isHostedDeployment } from '@/lib/documents/upload-size'

/**
 * What the URLs from gnubok_create_document_upload and gnubok_create_sie_upload
 * actually carry (crm#1455).
 *
 * upload_url is the same-origin Storage proxy (storage-proxy.ts), because
 * agent sandboxes often reach only the MCP host; its token travels in
 * upload_headers. On hosted that proxy runs
 * in a function, and the platform refuses a request body over 4.5 MB before
 * the function starts (upload-size.ts): a 5 MB phone photo got a bare 413
 * while the tool promised 10 MB. The archive itself takes MAX_DOCUMENT_SIZE,
 * and every check (size, type sniffing, hash, company scope) runs at
 * completion on the bytes Storage holds, so the raw signed Storage URL is
 * handed out next to the proxied one: bytes PUT there never pass through a
 * function, and a client that reaches the Storage host gets the full limit.
 * That URL is Storage's own and carries its token in the query, as Storage
 * requires: it takes no headers, and upload_headers is not meant for it.
 *
 * Self-hosted, or without a proxy rewrite (upload_url is already the Storage
 * URL), nothing caps the body below the archive's own limit.
 *
 * maxBytes is what the receiving side takes: the document archive's
 * MAX_DOCUMENT_SIZE, or for a SIE file the import's SIE_LIMITS.fileBytes
 * (multi-year exports run to several MB; the bucket takes 50 MB).
 */
export interface DocumentUploadLimits {
  max_bytes: number
  direct_upload_url?: string
  direct_max_bytes?: number
  notice?: string
}

export function documentUploadLimits(
  signedUrl: string,
  uploadUrl: string,
  maxBytes: number = MAX_DOCUMENT_SIZE,
): DocumentUploadLimits {
  if (uploadUrl === signedUrl || !isHostedDeployment()) return { max_bytes: maxBytes }
  const mb = (bytes: number) => Math.floor(bytes / 1024 / 1024)
  return {
    max_bytes: HOSTED_MAX_UPLOAD_BYTES,
    direct_upload_url: signedUrl,
    direct_max_bytes: maxBytes,
    notice:
      `upload_url takes at most ${mb(HOSTED_MAX_UPLOAD_BYTES)} MB (platform limit). ` +
      `For a larger file, up to ${mb(maxBytes)} MB, PUT the same bytes to direct_upload_url, without upload_headers ` +
      '(the Storage host, which some sandboxes cannot reach) and complete as usual; otherwise shrink the file.',
  }
}
