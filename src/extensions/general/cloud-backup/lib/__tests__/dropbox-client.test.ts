import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  asciiJson,
  dropboxContentHash,
  sanitizeDropboxName,
  uploadDropboxFile,
} from '../dropbox-client'

const CHUNK = 8 * 1024 * 1024

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Dropbox's content_hash, computed independently of the implementation. */
function expectedHash(bytes: Uint8Array): string {
  const blocks: Buffer[] = []
  for (let i = 0; i < bytes.length; i += 4 * 1024 * 1024) {
    blocks.push(
      createHash('sha256')
        .update(Buffer.from(bytes.subarray(i, Math.min(i + 4 * 1024 * 1024, bytes.length))))
        .digest()
    )
  }
  return createHash('sha256').update(Buffer.concat(blocks)).digest('hex')
}

function makeBuffer(size: number, fill = 7): ArrayBuffer {
  return new Uint8Array(size).fill(fill).buffer
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dropboxContentHash', () => {
  it('matches the block-wise definition for a multi-block payload', () => {
    const bytes = new Uint8Array(9 * 1024 * 1024).fill(3)
    expect(dropboxContentHash(bytes.buffer)).toBe(expectedHash(bytes))
  })

  it('hashes an empty file as the hash of an empty concatenation', () => {
    expect(dropboxContentHash(new ArrayBuffer(0))).toBe(
      createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    )
  })
})

describe('asciiJson', () => {
  it('escapes Swedish characters so the header stays ASCII', () => {
    const encoded = asciiJson({ path: '/Bolag/LÄSMIG.txt' })
    expect([...encoded].every((c) => c.codePointAt(0)! < 128)).toBe(true)
    expect(JSON.parse(encoded)).toEqual({ path: '/Bolag/LÄSMIG.txt' })
  })

  it('escapes astral characters as surrogate pairs', () => {
    const encoded = asciiJson({ n: '🚀' })
    expect(encoded).toContain('\\ud83d')
    expect(encoded).toContain('\\ude80')
    expect(JSON.parse(encoded)).toEqual({ n: '🚀' })
  })
})

describe('sanitizeDropboxName', () => {
  it('replaces characters Dropbox rejects in a path component', () => {
    expect(sanitizeDropboxName('Bolaget AB / Filial: X?')).toBe('Bolaget AB - Filial- X-')
  })

  it('neutralises a backslash so a name cannot escape its folder', () => {
    expect(sanitizeDropboxName(`a${String.fromCharCode(92)}b`)).toBe('a-b')
  })

  it('strips trailing dots and spaces', () => {
    expect(sanitizeDropboxName('Firma AB. ')).toBe('Firma AB')
  })

  it('never returns an empty component', () => {
    expect(sanitizeDropboxName('///')).toBe('---')
    expect(sanitizeDropboxName('')).toBe('foretag')
  })

  it('keeps Swedish characters: Dropbox accepts them, the header escapes them', () => {
    expect(sanitizeDropboxName('Åkeri Ödmjuk AB')).toBe('Åkeri Ödmjuk AB')
  })
})

describe('uploadDropboxFile', () => {
  it('uses a single request for a payload that fits one chunk', async () => {
    const data = makeBuffer(1024)
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        name: 'Grunddata.zip',
        path_display: '/Bolag/Grunddata.zip',
        size: 1024,
        content_hash: dropboxContentHash(data),
      })
    )

    const result = await uploadDropboxFile('token', '/Bolag/Grunddata.zip', data)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://content.dropboxapi.com/2/files/upload')
    expect(JSON.parse((init.headers as Record<string, string>)['Dropbox-API-Arg'])).toEqual({
      path: '/Bolag/Grunddata.zip',
      mode: 'overwrite',
      mute: true,
      autorename: false,
    })
    expect(result).toMatchObject({ path: '/Bolag/Grunddata.zip', size_bytes: 1024 })
  })

  it('splits a large payload into a start/append/finish session', async () => {
    const data = makeBuffer(CHUNK * 2 + 10)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ session_id: 'sess-1' }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'Arkiv 2024.zip',
          path_display: '/Bolag/Arkiv 2024.zip',
          size: data.byteLength,
          content_hash: dropboxContentHash(data),
        })
      )

    const result = await uploadDropboxFile('token', '/Bolag/Arkiv 2024.zip', data)

    const endpoints = fetchMock.mock.calls.map(([url]) => String(url).split('/2')[1])
    expect(endpoints).toEqual([
      '/files/upload_session/start',
      '/files/upload_session/append_v2',
      '/files/upload_session/finish',
    ])
    // The append cursor must sit exactly one chunk in, and finish two chunks in:
    // a wrong offset silently truncates or duplicates archive bytes.
    const appendArg = JSON.parse(
      (fetchMock.mock.calls[1][1].headers as Record<string, string>)['Dropbox-API-Arg']
    )
    expect(appendArg.cursor).toEqual({ session_id: 'sess-1', offset: CHUNK })
    const finishArg = JSON.parse(
      (fetchMock.mock.calls[2][1].headers as Record<string, string>)['Dropbox-API-Arg']
    )
    expect(finishArg.cursor).toEqual({ session_id: 'sess-1', offset: CHUNK * 2 })
    expect(finishArg.commit.mode).toBe('overwrite')
    expect(result.size_bytes).toBe(data.byteLength)
  })

  it('closes a payload that is an exact multiple of the chunk size', async () => {
    const data = makeBuffer(CHUNK * 2)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ session_id: 'sess-2' }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'Arkiv 2024.zip',
          path_display: '/Bolag/Arkiv 2024.zip',
          size: data.byteLength,
          content_hash: dropboxContentHash(data),
        })
      )

    const result = await uploadDropboxFile('token', '/Bolag/Arkiv 2024.zip', data)

    const endpoints = fetchMock.mock.calls.map(([url]) => String(url).split('/2')[1])
    expect(endpoints).toEqual([
      '/files/upload_session/start',
      '/files/upload_session/finish',
    ])
    expect(result.size_bytes).toBe(data.byteLength)
  })

  it('retries the whole upload once when the stored content hash disagrees', async () => {
    const data = makeBuffer(512)
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ name: 'x.zip', path_display: '/x.zip', size: 512, content_hash: 'wrong' })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'x.zip',
          path_display: '/x.zip',
          size: 512,
          content_hash: dropboxContentHash(data),
        })
      )

    const result = await uploadDropboxFile('token', '/x.zip', data)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.content_hash).toBe(dropboxContentHash(data))
  })

  it('throws rather than record a corrupted backup when the hash never matches', async () => {
    const data = makeBuffer(512)
    // A fresh Response per call: a body can only be read once, and the retry
    // issues a genuinely new request.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ name: 'x.zip', path_display: '/x.zip', size: 512, content_hash: 'wrong' })
    )

    await expect(uploadDropboxFile('token', '/x.zip', data)).rejects.toThrow(
      /checksum mismatch/
    )
  })

  it('retries a 5xx and succeeds on a later attempt', async () => {
    const data = makeBuffer(256)
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'x.zip',
          path_display: '/x.zip',
          size: 256,
          content_hash: dropboxContentHash(data),
        })
      )

    const result = await uploadDropboxFile('token', '/x.zip', data)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.size_bytes).toBe(256)
  })

  it('does not retry a 4xx: it can only fail the same way again', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"error_summary":"path/malformed_path/"}', { status: 400 })
    )

    await expect(uploadDropboxFile('token', '/x.zip', makeBuffer(256))).rejects.toThrow(
      /malformed_path/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
