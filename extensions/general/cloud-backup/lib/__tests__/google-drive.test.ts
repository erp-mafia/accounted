import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DriveFileGoneError,
  ensureFolder,
  getFileMeta,
  updateFile,
  uploadFile,
} from '../google-drive'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ensureFolder', () => {
  it('returns existing folder when found', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ files: [{ id: 'folder-1', name: 'gnubok' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const folder = await ensureFolder('at', 'gnubok', null)
    expect(folder.id).toBe('folder-1')
    // Only the search call; no create needed.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/files?q=')
    expect(decodeURIComponent(url)).toContain(`name = 'gnubok'`)
    expect(decodeURIComponent(url)).toContain(`'root' in parents`)
  })

  it('creates a new folder when none exists', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'new-id', name: 'gnubok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    const folder = await ensureFolder('at', 'gnubok', null)
    expect(folder.id).toBe('new-id')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const createCall = fetchMock.mock.calls[1]
    expect((createCall[1] as RequestInit).method).toBe('POST')
    const body = JSON.parse(String((createCall[1] as RequestInit).body))
    expect(body.mimeType).toBe('application/vnd.google-apps.folder')
    expect(body.name).toBe('gnubok')
  })

  it('escapes single quotes in folder name and scopes to parent', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // findFolderByName → match so we never hit create.
        new Response(JSON.stringify({ files: [{ id: 'x', name: "Kalle's" }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    await ensureFolder('at', "Kalle's", 'parent-id')
    const searchUrl = decodeURIComponent(fetchMock.mock.calls[0][0] as string)
    expect(searchUrl).toContain(`name = 'Kalle\\'s'`)
    expect(searchUrl).toContain(`'parent-id' in parents`)
  })
})

/** Resumable init response: 200 with a session URL in the Location header. */
function initResponse(): Response {
  return new Response(null, {
    status: 200,
    headers: { Location: 'https://upload.session/xyz' },
  })
}

function fileResponse(
  file: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(file), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function md5Of(data: ArrayBuffer): string {
  return createHash('md5').update(Buffer.from(data)).digest('hex')
}

describe('uploadFile (resumable)', () => {
  it('initiates a resumable session with metadata, then uploads the bytes', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]).buffer
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        fileResponse({
          id: 'file-123',
          name: 'arkiv.zip',
          size: '2048',
          webViewLink: 'https://drive.google.com/file/d/file-123/view',
          md5Checksum: md5Of(data),
        })
      )

    const result = await uploadFile('access-tok', 'folder-1', 'arkiv.zip', data)

    expect(result.id).toBe('file-123')
    expect(result.size_bytes).toBe(2048)
    expect(result.md5_checksum).toBe(md5Of(data))

    const [initUrl, initInit] = fetchMock.mock.calls[0]
    expect(initUrl).toContain('uploadType=resumable')
    expect((initInit as RequestInit).method).toBe('POST')
    const initHeaders = (initInit as RequestInit).headers as Record<string, string>
    expect(initHeaders.Authorization).toBe('Bearer access-tok')
    expect(initHeaders['X-Upload-Content-Length']).toBe('5')
    const metadata = JSON.parse(String((initInit as RequestInit).body))
    expect(metadata.name).toBe('arkiv.zip')
    expect(metadata.parents).toEqual(['folder-1'])

    const [chunkUrl, chunkInit] = fetchMock.mock.calls[1]
    expect(chunkUrl).toBe('https://upload.session/xyz')
    expect((chunkInit as RequestInit).method).toBe('PUT')
    const chunkHeaders = (chunkInit as RequestInit).headers as Record<string, string>
    expect(chunkHeaders['Content-Range']).toBe('bytes 0-4/5')
  })

  it('splits large payloads into chunks and follows 308 continuations', async () => {
    const CHUNK = 8 * 1024 * 1024
    const data = new Uint8Array(CHUNK + 10).buffer
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { Range: `bytes=0-${CHUNK - 1}` },
        })
      )
      .mockResolvedValueOnce(
        fileResponse({ id: 'f-1', name: 'big.zip', md5Checksum: md5Of(data) })
      )

    const result = await uploadFile('at', 'folder', 'big.zip', data)
    expect(result.id).toBe('f-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const firstRange = (fetchMock.mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>
    expect(firstRange['Content-Range']).toBe(`bytes 0-${CHUNK - 1}/${CHUNK + 10}`)
    const secondRange = (fetchMock.mock.calls[2][1] as RequestInit)
      .headers as Record<string, string>
    expect(secondRange['Content-Range']).toBe(`bytes ${CHUNK}-${CHUNK + 9}/${CHUNK + 10}`)
  })

  it('retries a chunk on 5xx before giving up', async () => {
    const data = new Uint8Array([7, 7]).buffer
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(new Response('flaky', { status: 502 }))
      .mockResolvedValueOnce(
        fileResponse({ id: 'f-1', name: 'a.zip', md5Checksum: md5Of(data) })
      )

    const result = await uploadFile('at', 'folder', 'a.zip', data)
    expect(result.id).toBe('f-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws with Drive error body when the init fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('quota exceeded', { status: 403 })
    )
    await expect(
      uploadFile('at', 'folder', 'a.zip', new Uint8Array(1).buffer)
    ).rejects.toThrow(/403/)
  })

  it('retries the whole upload once on checksum mismatch, then succeeds', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]).buffer
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        fileResponse({ id: 'f-1', name: 'a.zip', md5Checksum: 'corrupted' })
      )
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        fileResponse({ id: 'f-2', name: 'a.zip', md5Checksum: md5Of(data) })
      )

    const result = await uploadFile('at', 'folder', 'a.zip', data)
    expect(result.id).toBe('f-2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('throws after two checksum mismatches', async () => {
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++
      return call % 2 === 1
        ? initResponse()
        : fileResponse({ id: 'f-1', name: 'a.zip', md5Checksum: 'corrupted' })
    })
    await expect(
      uploadFile('at', 'folder', 'a.zip', new Uint8Array([9]).buffer)
    ).rejects.toThrow(/checksum mismatch/)
  })

  it('trusts the upload when Drive omits md5Checksum', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(fileResponse({ id: 'f-1', name: 'a.zip' }))
    const result = await uploadFile('at', 'folder', 'a.zip', new Uint8Array([9]).buffer)
    expect(result.id).toBe('f-1')
    expect(result.md5_checksum).toBeUndefined()
  })
})

describe('updateFile (resumable, in place)', () => {
  it('PATCHes an existing file id and uploads the new content', async () => {
    const data = new Uint8Array([4, 5, 6]).buffer
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        fileResponse({ id: 'file-9', name: 'Arkiv 2024.zip', md5Checksum: md5Of(data) })
      )

    const result = await updateFile('at', 'file-9', data)
    expect(result.id).toBe('file-9')

    const [initUrl, initInit] = fetchMock.mock.calls[0]
    expect(initUrl).toContain('/file-9?uploadType=resumable')
    expect((initInit as RequestInit).method).toBe('PATCH')
    // No metadata body on a content-only update.
    expect((initInit as RequestInit).body).toBeUndefined()
  })

  it('throws DriveFileGoneError when the file id no longer exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 })
    )
    await expect(
      updateFile('at', 'gone-id', new Uint8Array([1]).buffer)
    ).rejects.toBeInstanceOf(DriveFileGoneError)
  })
})

describe('getFileMeta', () => {
  it('returns metadata with trashed flag', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'f-1', name: 'gnubok', trashed: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const meta = await getFileMeta('at', 'f-1')
    expect(meta).toEqual({ id: 'f-1', name: 'gnubok', trashed: true })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/files/f-1')
    expect(url).toContain('fields=id,name,trashed')
  })

  it('defaults trashed to false when the field is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'f-1', name: 'gnubok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const meta = await getFileMeta('at', 'f-1')
    expect(meta?.trashed).toBe(false)
  })

  it('returns null on 404 (deleted or invisible to the scope)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 })
    )
    expect(await getFileMeta('at', 'gone')).toBeNull()
  })

  it('throws on other errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('server error', { status: 500 })
    )
    await expect(getFileMeta('at', 'f-1')).rejects.toThrow(/500/)
  })
})
