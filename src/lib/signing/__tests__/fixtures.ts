/**
 * Shared shapes for the signing unit tests: ids, rows as the server reads
 * them, a real one-page PDF, a quiet logger, and storage on a table mock.
 */
import { vi } from 'vitest'
import type { Logger } from '@/lib/logger'
import type { SigningRequestRow, SigningSignerRow } from '../types'

export const COMPANY = '33333333-3333-4333-8333-333333333333'
export const SENDER = '44444444-4444-4444-8444-444444444444'
export const MEMBER = '55555555-5555-4555-8555-555555555555'
export const DOC = '66666666-6666-4666-8666-666666666666'
export const REQ = '77777777-7777-4777-8777-777777777777'
export const SIGNER = '88888888-8888-4888-8888-888888888888'
export const VERSION = '99999999-9999-4999-8999-999999999999'
/** A valid personnummer (Luhn), 12 digits as TIC answers it. */
export const PN = '199001011239'
export const BANKID_TEST_KEY = 'a'.repeat(64)
export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const BASE_URL = 'https://app.accounted.se'

export async function onePagePdf(text = 'Hyresavtal'): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText(text, { x: 56, y: 760, size: 14, font })
  return pdf.save()
}

export function requestRow(overrides: Partial<SigningRequestRow> = {}): SigningRequestRow {
  return {
    id: REQ,
    company_id: COMPANY,
    created_by: SENDER,
    created_via: 'app',
    document_id: DOC,
    document_sha256: 'ab'.repeat(32),
    title: 'Hyresavtal',
    message: null,
    annual_report_version_id: null,
    status: 'open',
    expires_at: new Date(Date.now() + 14 * DAY).toISOString(),
    completed_at: null,
    declined_at: null,
    cancelled_at: null,
    signed_document_id: null,
    evidence_document_id: null,
    created_at: new Date(Date.now() - HOUR).toISOString(),
    ...overrides,
  }
}

export function signerRow(overrides: Partial<SigningSignerRow> = {}): SigningSignerRow {
  return {
    id: SIGNER,
    company_id: COMPANY,
    signing_request_id: REQ,
    position: 1,
    name: 'Anna Andersson',
    email: 'anna@example.se',
    role_label: null,
    user_id: null,
    lock_kind: 'none',
    annual_report_signature_id: null,
    link_sent_at: null,
    last_reminded_at: null,
    status: 'pending',
    bankid_session_id: null,
    bankid_session_started_at: null,
    signed_at: null,
    bankid_given_name: null,
    bankid_surname: null,
    declined_at: null,
    decline_reason: null,
    last_error_code: null,
    created_at: new Date(Date.now() - HOUR).toISOString(),
    ...overrides,
  }
}

export type TestLogger = Logger & {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  child: ReturnType<typeof vi.fn>
}

export function testLogger(): TestLogger {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log as unknown as TestLogger
}

/** Storage on a table mock: a download of `path` answers the bytes set for it, else storage's not-found. */
export function attachStorage(supabase: object, files: Map<string, Uint8Array>) {
  const download = vi.fn(async (path: string) => {
    const bytes = files.get(path)
    return bytes ? { data: new Blob([new Uint8Array(bytes)]), error: null } : { data: null, error: { message: 'Object not found' } }
  })
  const storage = { from: vi.fn(() => ({ download })) }
  Object.assign(supabase, { storage })
  return { storage, download }
}

/** The three signing services the TIC extension puts on the registry. */
export function bankIdServices() {
  return {
    startBankIdSignature: vi.fn(),
    pollBankIdSignature: vi.fn(),
    cancelBankIdSignature: vi.fn().mockResolvedValue({ ok: true, data: null }),
  }
}
