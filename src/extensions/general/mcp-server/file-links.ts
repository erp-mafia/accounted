import { getCanonicalBaseUrl } from '@/lib/api/v1/base-url'

/**
 * Two links to one file.
 *
 * A file URL the MCP tools hand out is served from the app origin with its
 * signed token in a headers object, never in the URL
 * (lib/core/documents/storage-proxy.ts). That link is for a client that
 * fetches the bytes itself; pasted into a chat it gives the user nothing that
 * opens, since a browser sends no such header.
 *
 * So where the file is meant for the user, the answer also carries `app_url`:
 * a page or a session route of this app that already exists and already
 * authenticates with the user's own Accounted session (withRouteContext, or a
 * dashboard page behind the login). It carries no token. It opens for the
 * company that is active in the user's Accounted, like every other page.
 */

/**
 * A link into the app for the user's browser: absolute on a deployment that
 * knows its origin, so the agent can hand it over as it is, else the path
 * (a self-host without NEXT_PUBLIC_APP_URL, where getCanonicalBaseUrl would
 * answer localhost).
 */
export function appUrl(path: string): string {
  return process.env.NEXT_PUBLIC_APP_URL ? `${getCanonicalBaseUrl()}${path}` : path
}

/**
 * A stored document: GET /api/documents/[id]/inline, with `original=1` for
 * the file itself and not the viewer's preview.
 */
export function documentAppUrl(documentId: string): string {
  return appUrl(`/api/documents/${encodeURIComponent(documentId)}/inline?original=1`)
}

/**
 * An invoice's PDF. With a delivery: the archived file of that delivery, as
 * it was sent (GET /api/invoices/[id]/archived-pdf). Without: a fresh render
 * shown in the browser (GET /api/invoices/[id]/pdf).
 */
export function invoicePdfAppUrl(invoiceId: string, archivedDeliveryId?: string): string {
  const invoice = `/api/invoices/${encodeURIComponent(invoiceId)}`
  return appUrl(
    archivedDeliveryId
      ? `${invoice}/archived-pdf?delivery=${encodeURIComponent(archivedDeliveryId)}`
      : `${invoice}/pdf?disposition=inline`,
  )
}

/** Fakturor > Begär utbetalning: each begäran with its file under Hämta fil. */
export function rotRutAppUrl(): string {
  return appUrl('/invoices/rot-rut')
}

/**
 * The period's archive, built and downloaded on the click by the session
 * route the web app's own export uses (GET /api/reports/full-archive, owner
 * or admin): the same content as the stored package, with no size cap.
 */
export function auditPackageAppUrl(fiscalPeriodId: string, includeDocuments: boolean): string {
  const query = new URLSearchParams({ scope: 'period', period_id: fiscalPeriodId })
  if (!includeDocuments) query.set('include_documents', 'false')
  return appUrl(`/api/reports/full-archive?${query.toString()}`)
}

/** True when the download link needs headers, so it does not open in a browser. */
const needsHeaders = (headers: Record<string, string>) => Object.keys(headers).length > 0

const FOR_A_CLIENT =
  'download_url with download_headers is for a client that fetches the bytes itself; it does not open as a link in a browser.'

/**
 * Beside the rot/rut begäran file. The file names every buyer by full
 * personnummer and the agent only has to get it to the user: the note says
 * so plainly. Omitted where the download link is a raw signed Storage URL
 * that opens by itself (a self-host without NEXT_PUBLIC_APP_URL), as before.
 */
export function rotRutDownloadNote(headers: Record<string, string>): { download_note?: string } {
  if (!needsHeaders(headers)) return {}
  return {
    download_note:
      'Give the user app_url: it opens in their browser when they are signed in to Accounted, on Fakturor > Begär utbetalning, where Hämta fil saves the file. ' +
      'Do not download or read the file yourself: it holds personnummer. ' +
      FOR_A_CLIENT,
  }
}

/** Beside the audit package. Omitted where the download link opens by itself, as above. */
export function auditPackageDownloadNote(headers: Record<string, string>): { download_note?: string } {
  if (!needsHeaders(headers)) return {}
  return {
    download_note:
      'Give the user app_url: it builds and downloads the same package in their browser when they are signed in to Accounted as owner or admin. ' +
      FOR_A_CLIENT,
  }
}
