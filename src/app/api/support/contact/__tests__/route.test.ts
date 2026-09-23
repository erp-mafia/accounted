import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockSupabase } from '@/tests/helpers'
import {
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
} from '@/lib/support/attachments'

const mockSupabase = createMockSupabase()
const requireAuthMock = vi.fn()
const sendEmailMock = vi.fn()
const isConfiguredMock = vi.fn()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
    isConfigured: () => isConfiguredMock(),
  }),
}))
vi.mock('@/lib/support', () => ({
  getSupportRecipientEmail: () => 'support@example.test',
}))
vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

import { POST } from '../route'

const user = { id: 'user-1', email: 'user@example.test' }

/** Real PNG signature: a declared image/png with anything else is rejected. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function pngFile(name = 'skarmbild.png', padTo = 0): File {
  const bytes = padTo > PNG_BYTES.length
    ? new Uint8Array([...PNG_BYTES, ...new Uint8Array(padTo - PNG_BYTES.length)])
    : PNG_BYTES
  return new File([bytes], name, { type: 'image/png' })
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/support/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function multipartRequest(fields: {
  subject?: string
  message?: string
  files?: File[]
}): Request {
  const form = new FormData()
  if (fields.subject !== undefined) form.append('subject', fields.subject)
  if (fields.message !== undefined) form.append('message', fields.message)
  for (const file of fields.files ?? []) form.append('files', file, file.name)
  return new Request('http://localhost/api/support/contact', { method: 'POST', body: form })
}

describe('POST /api/support/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isConfiguredMock.mockReturnValue(true)
    sendEmailMock.mockResolvedValue({ success: true })
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(jsonRequest({ message: 'Hjälp tack' }))
    expect(response.status).toBe(401)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects a message shorter than 5 characters', async () => {
    const response = await POST(jsonRequest({ message: 'hej' }))
    expect(response.status).toBe(400)
  })

  it('maps an invalid request body to a Swedish user-facing error', async () => {
    const response = await POST(
      new Request('http://localhost/api/support/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('Förfrågan innehåller ogiltiga uppgifter.')
  })

  it('still accepts the JSON body with no attachments', async () => {
    const response = await POST(jsonRequest({ subject: 'Moms', message: 'Jag fastnar på ruta 05' }))
    expect(response.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'support@example.test',
        replyTo: 'user@example.test',
        attachments: undefined,
      })
    )
  })

  it('attaches an uploaded screenshot to the support mail', async () => {
    const response = await POST(
      multipartRequest({ subject: 'Trasig vy', message: 'Ser ut så här', files: [pngFile()] })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { sent: true } })

    const sent = sendEmailMock.mock.calls[0][0]
    expect(sent.subject).toBe('[accounted support] Trasig vy')
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0].filename).toBe('skarmbild.png')
    expect(sent.attachments[0].contentType).toBe('image/png')
    expect(Buffer.isBuffer(sent.attachments[0].content)).toBe(true)
    // The reader must see that files came along even in a folded mail client.
    expect(sent.text).toContain('Bilagor (1): skarmbild.png')
  })

  it('strips path segments out of the attachment filename', async () => {
    await POST(
      multipartRequest({
        message: 'Se bilagan',
        files: [pngFile('../../etc/passwd.png')],
      })
    )
    expect(sendEmailMock.mock.calls[0][0].attachments[0].filename).toBe('passwd.png')
  })

  it('forces an attachment extension that matches the verified type', async () => {
    await POST(
      multipartRequest({
        message: 'Se bilagan',
        files: [pngFile('update.exe')],
      })
    )
    expect(sendEmailMock.mock.calls[0][0].attachments[0].filename).toBe('update.png')
  })

  it('rejects an empty attachment instead of silently omitting it', async () => {
    const response = await POST(
      multipartRequest({
        message: 'Tom bild',
        files: [new File([], 'tom.png', { type: 'image/png' })],
      })
    )
    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects more attachments than the cap allows', async () => {
    const files = Array.from(
      { length: SUPPORT_MAX_ATTACHMENTS + 1 },
      (_, index) => pngFile(`${index}.png`)
    )
    const response = await POST(
      multipartRequest({
        message: 'För många bilder',
        files,
      })
    )
    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects attachments over the total size budget', async () => {
    const response = await POST(
      multipartRequest({
        message: 'En stor bild',
        files: [pngFile('stor.png', SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES + 1)],
      })
    )
    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported attachment type', async () => {
    const response = await POST(
      multipartRequest({
        message: 'Ett skript',
        files: [new File(['#!/bin/sh'], 'run.sh', { type: 'application/x-sh' })],
      })
    )
    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects content that does not match its declared type', async () => {
    const response = await POST(
      multipartRequest({
        message: 'Utger sig för att vara en png',
        files: [new File(['not a png at all'], 'fake.png', { type: 'image/png' })],
      })
    )
    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('rejects an executable-shaped PDF polyglot', async () => {
    const bytes = new Uint8Array(64)
    bytes.set([0x4d, 0x5a])
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 16)
    const response = await POST(
      multipartRequest({
        message: 'Misstänkt PDF',
        files: [new File([bytes], 'update.exe', { type: 'application/pdf' })],
      })
    )
    expect(response.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('returns 503 when the email service is not configured', async () => {
    isConfiguredMock.mockReturnValue(false)
    const response = await POST(jsonRequest({ message: 'Hjälp tack' }))
    expect(response.status).toBe(503)
  })

  it('returns 500 when the send fails', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'boom' })
    const response = await POST(jsonRequest({ message: 'Hjälp tack' }))
    expect(response.status).toBe(500)
  })
})
