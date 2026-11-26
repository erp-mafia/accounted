/**
 * A Visma eAccounting (Spiris) customer invoice's own PDF: the invoice as
 * Visma rendered it, for the migration's document import
 * (extensions/general/arcim-migration/lib/import-documents.ts), which keeps it
 * as the imported invoice's archived copy.
 *
 * GET /customerinvoices/{invoiceId}/pdf answers JSON naming a temporary,
 * anonymous link to the file in Visma's storage: `TemporaryUrl`, `Url` in
 * Visma's older answers. The link is read without our token, and only when it
 * points into Visma's own storage over https (VISMA_STORAGE_DOMAIN), so the
 * answer can never send the download anywhere else. Scope: ea:sales, which
 * every Visma connection asks for (visma/oauth.ts).
 */
import { fetchInExecutionBudget } from '@/lib/http/execution-budget';
import { isTimeoutError } from '@/lib/http/fetch-with-timeout';
import { withRetry } from '../retry';
import type { VismaClient } from './client';
import { VISMA_STORAGE_DOMAIN } from './config';

/** Per attempt: one invoice PDF from Visma's storage. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** An invoice PDF is a few hundred kB; a body far above that is not one. */
const MAX_INVOICE_PDF_BYTES = 20 * 1024 * 1024;

/**
 * A failed read of the temporary link: an expired link, a storage outage. Not
 * a VismaApiError, because it says nothing about the connection or its rights:
 * the import counts it as one invoice that did not come, never as a refusal
 * of the register.
 */
export class VismaFileDownloadError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
  ) {
    super(message);
    this.name = 'VismaFileDownloadError';
  }
}

/** The temporary link in Visma's answer, or null when it names none inside its storage. */
export function vismaTemporaryFileUrl(answer: unknown): URL | null {
  if (!answer || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  const raw =
    typeof record.TemporaryUrl === 'string' && record.TemporaryUrl.trim()
      ? record.TemporaryUrl
      : typeof record.Url === 'string'
        ? record.Url
        : '';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Safe to ignore: text that is no URL names no link, and the caller
    // refuses the copy with VISMA_INVOICE_PDF_LINK_MISSING.
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (host !== VISMA_STORAGE_DOMAIN && !host.endsWith(`.${VISMA_STORAGE_DOMAIN}`)) return null;
  return url;
}

function retryableDownload(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof VismaFileDownloadError) {
    return error.statusCode === 429 || (error.statusCode !== null && error.statusCode >= 500);
  }
  return false;
}

/** The invoice's PDF bytes, by Visma's invoice id (the migration's source id). */
export async function fetchVismaInvoicePdf(
  client: VismaClient,
  accessToken: string,
  invoiceId: string,
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  const answer = await client.get<unknown>(accessToken, `/customerinvoices/${encodeURIComponent(invoiceId)}/pdf`);
  const url = vismaTemporaryFileUrl(answer);
  if (!url) throw new VismaFileDownloadError('VISMA_INVOICE_PDF_LINK_MISSING', null);

  return withRetry(
    async () => {
      const response = await fetchInExecutionBudget(url, {
        // A redirect could leave Visma's storage: not followed.
        redirect: 'error',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new VismaFileDownloadError(`VISMA_INVOICE_PDF_DOWNLOAD_FAILED: ${response.status}`, response.status);
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_INVOICE_PDF_BYTES) {
        throw new VismaFileDownloadError('VISMA_INVOICE_PDF_TOO_LARGE', response.status);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_INVOICE_PDF_BYTES) {
        throw new VismaFileDownloadError('VISMA_INVOICE_PDF_TOO_LARGE', response.status);
      }
      return { bytes, contentType: response.headers.get('content-type') };
    },
    { maxAttempts: 3, initialDelayMs: 1000, shouldRetry: retryableDownload },
  );
}
