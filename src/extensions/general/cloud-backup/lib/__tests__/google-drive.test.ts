import { createHash } from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DriveFileGoneError,
  ensureFolder,
  getFileMeta,
  updateFile,
  uploadFile,
} from '../google-drive'
import { CloudScopeMissingError } from '../cloud-provider'

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

/** The bytes as the sync hands them over: a stream, started again on each call. */
function streamOf(data: ArrayBuffer) {
  return async function* () {
    yield new Uint8Array(data)
  }
}

const MB = 1024 * 1024

/**
 * A Drive upload session that keeps what it is sent (or the part `keep`
 * says): 308 until the request that states the total, then the file with the
 * md5 of everything it kept.
 */
function driveSession(keep?: (range: string, body: Uint8Array) => number | undefined) {
  const ranges: string[] = []
  const md5 = createHash('md5')
  let received = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).includes('uploadType=resumable')) return initResponse()
    const range = ((init as RequestInit).headers as Record<string, string>)['Content-Range']
    const body = (init as RequestInit).body as Uint8Array
    ranges.push(range)
    const kept = keep?.(range, body) ?? body.length
    md5.update(body.subarray(0, kept))
    received += kept
    if (kept === body.length && !range.endsWith('/*')) {
      return fileResponse({ id: 'f-1', name: 'big.zip', size: String(received), md5Checksum: md5.digest('hex') })
    }
    return new Response(null, { status: 308, headers: { Range: `bytes=0-${received - 1}` } })
  })
  return { ranges }
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

    const result = await uploadFile('access-tok', 'folder-1', 'arkiv.zip', streamOf(data))

    expect(result.id).toBe('file-123')
    expect(result.size_bytes).toBe(2048)
    expect(result.md5_checksum).toBe(md5Of(data))

    const [initUrl, initInit] = fetchMock.mock.calls[0]
    expect(initUrl).toContain('uploadType=resumable')
    expect((initInit as RequestInit).method).toBe('POST')
    const initHeaders = (initInit as RequestInit).headers as Record<string, string>
    expect(initHeaders.Authorization).toBe('Bearer access-tok')
    // The length is not known when the session starts: the file is produced while it is sent.
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

    const result = await uploadFile('at', 'folder', 'big.zip', streamOf(data))
    expect(result.id).toBe('f-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const firstRange = (fetchMock.mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>
    expect(firstRange['Content-Range']).toBe(`bytes 0-${CHUNK - 1}/*`)
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

    const result = await uploadFile('at', 'folder', 'a.zip', streamOf(data))
    expect(result.id).toBe('f-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws with Drive error body when the init fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('quota exceeded', { status: 403 })
    )
    await expect(
      uploadFile('at', 'folder', 'a.zip', streamOf(new Uint8Array(1).buffer))
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

    const open = vi.fn(streamOf(data))
    const result = await uploadFile('at', 'folder', 'a.zip', open)
    expect(result.id).toBe('f-2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    // The retry produces the file again rather than keeping the first copy.
    expect(open).toHaveBeenCalledTimes(2)
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
      uploadFile('at', 'folder', 'a.zip', streamOf(new Uint8Array([9]).buffer))
    ).rejects.toThrow(/checksum mismatch/)
  })

  it('sends each chunk as it is produced, holding no more than a chunk and the piece it was cut from', async () => {
    // 21 MB in 3 MB pieces, the way the ZIP writer hands over large files.
    let produced = 0
    async function* source() {
      for (let i = 0; i < 7; i++) {
        produced += 3 * MB
        yield new Uint8Array(3 * MB).fill(i)
      }
    }
    const held: number[] = []
    const { ranges } = driveSession((range) => {
      const end = Number(range.match(/-(\d+)\//)![1]) + 1
      held.push(produced - end)
      return undefined
    })

    const result = await uploadFile('at', 'folder', 'big.zip', source)

    expect(ranges).toEqual([
      `bytes 0-${8 * MB - 1}/*`,
      `bytes ${8 * MB}-${16 * MB - 1}/*`,
      `bytes ${16 * MB}-${21 * MB - 1}/${21 * MB}`,
    ])
    expect(Math.max(...held)).toBeLessThanOrEqual(3 * MB)
    // Drive's md5 of what it received matched the md5 of what was produced.
    expect(result.size_bytes).toBe(21 * MB)
  })

  it('states the total on the last chunk when the file ends on a chunk boundary', async () => {
    const { ranges } = driveSession()

    await uploadFile('at', 'folder', 'big.zip', streamOf(new Uint8Array(16 * MB).fill(1).buffer))

    expect(ranges).toEqual([`bytes 0-${8 * MB - 1}/*`, `bytes ${8 * MB}-${16 * MB - 1}/${16 * MB}`])
  })

  it('sends again the part of a chunk Drive did not keep', async () => {
    let first = true
    const { ranges } = driveSession(() => {
      if (!first) return undefined
      first = false
      // Drive kept only the first 4 MB of the first chunk.
      return 4 * MB
    })
    const data = new Uint8Array(9 * MB)
    for (let i = 0; i < data.length; i += 4096) data[i] = i % 251

    const result = await uploadFile('at', 'folder', 'big.zip', streamOf(data.buffer))

    expect(ranges).toEqual([
      `bytes 0-${8 * MB - 1}/*`,
      `bytes ${4 * MB}-${8 * MB - 1}/*`,
      `bytes ${8 * MB}-${9 * MB - 1}/${9 * MB}`,
    ])
    expect(result.id).toBe('f-1')
  })

  it('finishes an empty file with its total alone', async () => {
    const { ranges } = driveSession()

    await uploadFile('at', 'folder', 'a.txt', streamOf(new ArrayBuffer(0)))

    expect(ranges).toEqual(['bytes */0'])
  })

  it('trusts the upload when Drive omits md5Checksum', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(initResponse())
      .mockResolvedValueOnce(fileResponse({ id: 'f-1', name: 'a.zip' }))
    const result = await uploadFile('at', 'folder', 'a.zip', streamOf(new Uint8Array([9]).buffer))
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

    const result = await updateFile('at', 'file-9', streamOf(data))
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
      updateFile('at', 'gone-id', streamOf(new Uint8Array([1]).buffer))
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
      uploadFile('at', 'folder-1', 'Arkiv 2024.zip', streamOf(new ArrayBuffer(4)))
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
