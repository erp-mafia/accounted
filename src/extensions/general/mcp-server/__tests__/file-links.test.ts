/**
 * The link an agent gives the user for a file: a page or a session route of
 * the app, opened in the user's own browser with their Accounted session. No
 * token rides in it (CASA 2.1.1), unlike the signed link it sits beside,
 * whose token travels in a headers object and which a browser cannot open.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appUrl,
  auditPackageAppUrl,
  auditPackageDownloadNote,
  documentAppUrl,
  invoicePdfAppUrl,
  rotRutAppUrl,
  rotRutDownloadNote,
} from '../file-links'

const APP = 'https://app.accounted.se'
const DOC = '6f1c2a3e-1234-4bcd-9abc-0123456789ab'
const INVOICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DELIVERY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PERIOD = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const HEADERS = { Authorization: 'Bearer eyJ.signed.token' }

afterEach(() => {
  vi.unstubAllEnvs()
})

const links = () => ({
  document: documentAppUrl(DOC),
  archivedInvoice: invoicePdfAppUrl(INVOICE, DELIVERY),
  renderedInvoice: invoicePdfAppUrl(INVOICE),
  rotRut: rotRutAppUrl(),
  auditPackage: auditPackageAppUrl(PERIOD, true),
  auditPackageWithoutDocuments: auditPackageAppUrl(PERIOD, false),
})

describe('app links for a file', () => {
  it('point at the app origin, at the session route or page of that file', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `${APP}/`)

    expect(links()).toEqual({
      document: `${APP}/api/documents/${DOC}/inline?original=1`,
      archivedInvoice: `${APP}/api/invoices/${INVOICE}/archived-pdf?delivery=${DELIVERY}`,
      renderedInvoice: `${APP}/api/invoices/${INVOICE}/pdf?disposition=inline`,
      rotRut: `${APP}/invoices/rot-rut`,
      auditPackage: `${APP}/api/reports/full-archive?scope=period&period_id=${PERIOD}`,
      auditPackageWithoutDocuments: `${APP}/api/reports/full-archive?scope=period&period_id=${PERIOD}&include_documents=false`,
    })
  })

  it('carry no token and no credential-shaped parameter', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)

    for (const [name, link] of Object.entries(links())) {
      const url = new URL(link)
      expect(url.origin, name).toBe(APP)
      expect(url.username + url.password + url.hash, name).toBe('')
      for (const key of url.searchParams.keys()) {
        expect(['original', 'delivery', 'disposition', 'scope', 'period_id', 'include_documents'], name).toContain(key)
      }
      expect(link, name).not.toMatch(/token|signature|eyJ|gnubok_/i)
    }
  })

  // The routes are named here once more, as files: a link to a route that
  // was moved or removed would open on a 404 for the user.
  it('name routes and pages that exist', () => {
    const root = join(process.cwd(), 'src', 'app')
    for (const file of [
      'api/documents/[id]/inline/route.ts',
      'api/invoices/[id]/archived-pdf/route.ts',
      'api/invoices/[id]/pdf/route.ts',
      'api/reports/full-archive/route.ts',
      '(dashboard)/invoices/rot-rut/page.tsx',
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true)
    }
  })

  it('escape what goes into the path', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
    expect(documentAppUrl('a/b?c')).toBe(`${APP}/api/documents/a%2Fb%3Fc/inline?original=1`)
  })

  // A self-host that never set NEXT_PUBLIC_APP_URL: no origin is known, and
  // localhost would be a dead link for a remote user. The path is answered,
  // as the review link under /pending always was.
  it('answer the path alone where the deployment does not know its origin', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')

    expect(appUrl('/pending')).toBe('/pending')
    expect(documentAppUrl(DOC)).toBe(`/api/documents/${DOC}/inline?original=1`)
    expect(rotRutAppUrl()).toBe('/invoices/rot-rut')
    expect(JSON.stringify(links())).not.toContain('localhost')
  })
})

describe('notes beside a file meant for the user', () => {
  it('rot/rut: the user gets app_url, and the agent neither downloads nor reads the file', () => {
    const { download_note: note } = rotRutDownloadNote(HEADERS)
    expect(note).toMatch(/^Give the user app_url/)
    expect(note).toContain('Do not download or read the file yourself: it holds personnummer.')
    expect(note).toContain('download_url with download_headers is for a client that fetches the bytes itself')
    expect(note).not.toContain(HEADERS.Authorization)
  })

  it('audit package: the user gets app_url, a client the signed link', () => {
    const { download_note: note } = auditPackageDownloadNote(HEADERS)
    expect(note).toMatch(/^Give the user app_url/)
    expect(note).toContain('owner or admin')
    expect(note).toContain('download_url with download_headers is for a client that fetches the bytes itself')
  })

  it('say nothing where the download link needs no header and opens by itself', () => {
    expect(rotRutDownloadNote({})).toEqual({})
    expect(auditPackageDownloadNote({})).toEqual({})
  })

  it('stay short', () => {
    for (const note of [rotRutDownloadNote(HEADERS).download_note!, auditPackageDownloadNote(HEADERS).download_note!]) {
      expect(note.length).toBeLessThan(420)
    }
  })
})
