import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DriveFileGoneError,
  ensureFolder,
  getFileMeta,
  updateFile,
  uploadFile,
} from '../google-drive'
import { CloudScopeMissingError, type FileBytes } from '../cloud-provider'

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

/** `data` as the uploader reads a file: in parts of `partSize` bytes, from the start on each read. */
function fileOf(data: ArrayBuffer, partSize = Math.max(1, data.byteLength)): FileBytes {
  return async function* () {
    const bytes = new Uint8Array(data)
    for (let at = 0; at < bytes.length; at += partSize) yield bytes.slice(at, at + partSize)
  }
}

function chunkHeaders(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>
}

function chunkBody(call: unknown[]): Uint8Array {
  return (call[1] as RequestInit).body as Uint8Array
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

    const result = await uploadFile('access-tok', 'folder-1', 'arkiv.zip', fileOf(data))

    expect(result.id).toBe('file-123')
    expect(result.size_bytes).toBe(2048)
    expect(result.md5_checksum).toBe(md5Of(data))

    const [initUrl, initInit] = fetchMock.mock.calls[0]
    expect(initUrl).toContain('uploadType=resumable')
    expect((initInit as RequestInit).method).toBe('POST')
    const initHeaders = (initInit as RequestInit).headers as Record<string, string>
    expect(initHeaders.Authorization).toBe('Bearer access-tok')
    // The length is known only once the file has been read.
    expect(initHeaders['X-Upload-Content-Length']).toBeUndefined()
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
    const data = new Uint8Array(CHUNK + 10).map((_, i) => i % 251).buffer
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

    // Read in 3 MB parts: the chunks are cut from the stream, not from its parts.
    const result = await uploadFile('at', 'folder', 'big.zip', fileOf(data, 3 * 1024 * 1024))
    expect(result.id).toBe('f-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Only the request that ends the file names its length.
    expect(chunkHeaders(fetchMock.mock.calls[1])['Content-Range']).toBe(`bytes 0-${CHUNK - 1}/*`)
    expect(chunkHeaders(fetchMock.mock.calls[2])['Content-Range']).toBe(
      `bytes ${CHUNK}-${CHUNK + 9}/${CHUNK + 10}`
    )
    const sent = Buffer.concat([chunkBody(fetchMock.mock.calls[1]), chunkBody(fetchMock.mock.calls[2])])
    expect(sent.length).toBe(CHUNK + 10)
    expect(sent.equals(Buffer.from(data))).toBe(true)
  })

  it('sends the rest of a chunk when Drive stored only part of it', async () => {
    const CHUNK = 8 * 1024 * 1024
    const PART = 256 * 1024
    const data = new Uint8Array(CHUNK + 10).map((_, i) => i % 253).buffer
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { Range: `bytes=0-${PART - 1}` } })
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK - 1}` } })
      )
      .mockResolvedValueOnce(
        fileResponse({ id: 'f-1', name: 'big.zip', md5Checksum: md5Of(data) })
      )

    const result = await uploadFile('at', 'folder', 'big.zip', fileOf(data))

    expect(result.id).toBe('f-1')
    expect(chunkHeaders(fetchMock.mock.calls[2])['Content-Range']).toBe(
      `bytes ${PART}-${CHUNK - 1}/*`
    )
    expect(
      Buffer.from(chunkBody(fetchMock.mock.calls[2])).equals(
        Buffer.from(new Uint8Array(data, PART, CHUNK - PART))
      )
    ).toBe(true)
    expect(chunkHeaders(fetchMock.mock.calls[3])['Content-Range']).toBe(
      `bytes ${CHUNK}-${CHUNK + 9}/${CHUNK + 10}`
    )
  })

  it('fails when the session no longer holds an earlier chunk', async () => {
    const CHUNK = 8 * 1024 * 1024
    const data = new Uint8Array(CHUNK + 10).buffer
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK - 1}` } })
      )
      // The bytes before this chunk are gone from the session and from memory.
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { Range: 'bytes=0-99' } }))

    await expect(uploadFile('at', 'folder', 'big.zip', fileOf(data))).rejects.toThrow(
      /outside the chunk/
    )
  })

  it('gives up on a session that stops taking bytes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockImplementation(
        async () => new Response(null, { status: 308, headers: { Range: 'bytes=0-1' } })
      )

    await expect(
      uploadFile('at', 'folder', 'a.zip', fileOf(new Uint8Array([1, 2, 3, 4, 5]).buffer))
    ).rejects.toThrow(/no progress/)
  })

  it('uploads an empty file with one request that names its length', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(fileResponse({ id: 'f-0', name: 'tom.txt', size: '0' }))

    const result = await uploadFile('at', 'folder', 'tom.txt', fileOf(new ArrayBuffer(0)))

    expect(result).toMatchObject({ id: 'f-0', size_bytes: 0 })
    expect(chunkHeaders(fetchMock.mock.calls[1])['Content-Range']).toBe('bytes */0')
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

    const result = await uploadFile('at', 'folder', 'a.zip', fileOf(data))
    expect(result.id).toBe('f-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('releases a 5xx response body before it retries the chunk', async () => {
    const data = new Uint8Array([7, 7]).buffer
    const flaky = new Response('flaky', { status: 503 })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(flaky)
      .mockResolvedValueOnce(
        fileResponse({ id: 'f-1', name: 'a.zip', md5Checksum: md5Of(data) })
      )

    await uploadFile('at', 'folder', 'a.zip', fileOf(data))
    // A cancelled body is disturbed: nothing keeps the connection busy.
    expect(flaky.bodyUsed).toBe(true)
  })

  it('throws with Drive error body when the init fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('quota exceeded', { status: 403 })
    )
    await expect(
      uploadFile('at', 'folder', 'a.zip', fileOf(new Uint8Array(1).buffer))
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

    const file = vi.fn(fileOf(data))
    const result = await uploadFile('at', 'folder', 'a.zip', file)
    expect(result.id).toBe('f-2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    // The second upload reads the file again from its first byte.
    expect(file).toHaveBeenCalledTimes(2)
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
      uploadFile('at', 'folder', 'a.zip', fileOf(new Uint8Array([9]).buffer))
    ).rejects.toThrow(/checksum mismatch/)
  })

  it('trusts the upload when Drive omits md5Checksum', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(fileResponse({ id: 'f-1', name: 'a.zip' }))
    const result = await uploadFile('at', 'folder', 'a.zip', fileOf(new Uint8Array([9]).buffer))
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

    const result = await updateFile('at', 'file-9', fileOf(data))
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
      updateFile('at', 'gone-id', fileOf(new Uint8Array([1]).buffer))
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

/**
 * The answer production got every night for grants made with the Drive box
 * unticked at Google's consent screen (B12): 403, insufficient scopes.
 */
function insufficientScopeResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [
          { message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' },
        ],
        status: 'PERMISSION_DENIED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
            domain: 'googleapis.com',
          },
        ],
      },
    }),
    {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate':
          'Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="https://www.googleapis.com/auth/drive.file"',
      },
    }
  )
}

describe('a grant without the Drive scope', () => {
  it('fails the folder lookup with CloudScopeMissingError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insufficientScopeResponse())
    const err = await ensureFolder('at', 'gnubok', null).catch((e) => e)
    expect(err).toBeInstanceOf(CloudScopeMissingError)
    expect(err.message).toContain('403')
  })

  it('fails the folder revalidation with CloudScopeMissingError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insufficientScopeResponse())
    await expect(getFileMeta('at', 'f-1')).rejects.toBeInstanceOf(CloudScopeMissingError)
  })

  it('fails an upload at session init with CloudScopeMissingError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(insufficientScopeResponse())
    await expect(
      uploadFile('at', 'folder-1', 'Arkiv 2024.zip', fileOf(new ArrayBuffer(4)))
    ).rejects.toBeInstanceOf(CloudScopeMissingError)
  })

  it('recognises the challenge header alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 403,
        headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' },
      })
    )
    await expect(getFileMeta('at', 'f-1')).rejects.toBeInstanceOf(CloudScopeMissingError)
  })

  it('keeps a file-level 403 an ordinary error, not a reconnect', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'The user does not have sufficient permissions for file f-1.',
            errors: [{ reason: 'insufficientFilePermissions' }],
          },
        }),
        { status: 403 }
      )
    )
    const err = await getFileMeta('at', 'f-1').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CloudScopeMissingError)
    expect(err.message).toContain('403')
  })
})
