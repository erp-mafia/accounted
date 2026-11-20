/**
 * The Autogiro page's calls: one request helper that reads the canonical
 * envelope (`{ data }` or `{ error: { code, message, message_en } }`), and the
 * two downloads. A file for the bank is stored and fetched by id; the answer
 * to internet-bank mandates carries the payers' accounts and personnummer, is
 * never stored, and arrives as base64 to be saved at once.
 */
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { downloadFile, saveBlobToDisk, type DownloadFileResult } from '@/lib/browser/download-file'
import type { AnswerFile, WrittenFileRef } from './types'

export type AutogiroRequestResult<T> = { ok: true; data: T } | { ok: false; message: string }

export async function requestAutogiro<T>(
  url: string,
  init: RequestInit | undefined,
  locale: ErrorLocale,
): Promise<AutogiroRequestResult<T>> {
  try {
    const res = await fetch(url, init)
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return { ok: false, message: getErrorMessage(body, { statusCode: res.status, locale, context: 'invoice' }) }
    }
    return { ok: true, data: (body as { data: T }).data }
  } catch (error) {
    return { ok: false, message: getErrorMessage(error, { locale }) }
  }
}

export function jsonRequest(method: 'POST' | 'PUT' | 'PATCH', body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/** A stored file (debit file, cancellation, a report read): saved under the server's name. */
export function downloadAutogiroFile(file: WrittenFileRef, locale: ErrorLocale): Promise<DownloadFileResult> {
  return downloadFile({
    url: `/api/invoices/autogiro/files/${file.id}`,
    filename: file.filename,
    preferServerFilename: true,
    locale,
    errorContext: 'invoice',
  })
}

/**
 * The answer file, saved from the bytes the route returned. They already are
 * ISO 8859-1, the encoding Bankgirot reads, so they are written as they are:
 * re-encoding them as text would turn å, ä and ö into UTF-8.
 */
export function saveAnswerFile(answer: AnswerFile): void {
  const binary = atob(answer.content_base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  saveBlobToDisk(new Blob([bytes], { type: 'text/plain;charset=ISO-8859-1' }), answer.filename)
}
