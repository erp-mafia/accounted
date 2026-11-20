import { describe, it, expect, vi, beforeEach } from 'vitest'

const download = vi.fn()
const remove = vi.fn()
const from = vi.fn(() => ({ download, remove }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ storage: { from } }),
}))

import { readUploadedFile } from '../staged-upload'

const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'
const PENDING_KEY = `documents/company-1/user-1/pending/${UPLOAD_ID}_faktura.pdf`

function form(fields: Record<string, string | File>): FormData {
  const f = new FormData()
  for (const [key, value] of Object.entries(fields)) f.append(key, value)
  return f
}

describe('readUploadedFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    remove.mockResolvedValue({ data: [], error: null })
  })

  it('returns an inline file as it is, without touching Storage', async () => {
    const file = new File(['%PDF-1.4'], 'kvitto.pdf', { type: 'application/pdf' })

    const result = await readUploadedFile(form({ file }), 'company-1', 'user-1')

    expect(result).toEqual({ ok: true, file })
    expect(from).not.toHaveBeenCalled()
  })

  it('answers DOC_UPLOAD_NO_FILE when neither a file nor a valid reference is sent', async () => {
    expect(await readUploadedFile(form({}), 'company-1', 'user-1')).toEqual({ ok: false, code: 'DOC_UPLOAD_NO_FILE' })
    expect(
      await readUploadedFile(form({ upload_id: 'not-a-uuid', file_name: 'x.pdf' }), 'company-1', 'user-1'),
    ).toEqual({ ok: false, code: 'DOC_UPLOAD_NO_FILE' })
    expect(from).not.toHaveBeenCalled()
  })

  it('reads a staged object from the caller\'s own pending key and removes it', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 staged')
    download.mockResolvedValue({ data: new Blob([bytes]), error: null })

    const result = await readUploadedFile(
      form({ upload_id: UPLOAD_ID, file_name: 'faktura.pdf', mime_type: 'application/pdf' }),
      'company-1',
      'user-1',
    )

    expect(from).toHaveBeenCalledWith('documents')
    expect(download).toHaveBeenCalledWith(PENDING_KEY)
    expect(remove).toHaveBeenCalledWith([PENDING_KEY])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.name).toBe('faktura.pdf')
    expect(result.file.type).toBe('application/pdf')
    expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(bytes)
  })

  it('keys the object on the session\'s company and user, never on anything the form says', async () => {
    download.mockResolvedValue({ data: null, error: { message: 'Object not found' } })

    await readUploadedFile(
      form({ upload_id: UPLOAD_ID, file_name: 'faktura.pdf', mime_type: 'application/pdf', company_id: 'other' }),
      'company-1',
      'user-1',
    )

    expect(download).toHaveBeenCalledWith(PENDING_KEY)
  })

  it('answers DOCUMENT_UPLOAD_NOT_FOUND when the PUT never landed or the reservation expired', async () => {
    download.mockResolvedValue({ data: null, error: { message: 'Object not found' } })

    const result = await readUploadedFile(
      form({ upload_id: UPLOAD_ID, file_name: 'faktura.pdf', mime_type: 'application/pdf' }),
      'company-1',
      'user-1',
    )

    expect(result).toEqual({ ok: false, code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
    expect(remove).not.toHaveBeenCalled()
  })
})
