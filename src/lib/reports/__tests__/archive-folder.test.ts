import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  ArchiveFolder,
  ArchiveTooLargeError,
  DeflatedBytes,
  collectBytes,
  deflatedJsonArray,
  deflatedJsonArrayElements,
  jsonArray,
  jsonArrayElement,
  readAhead,
  type ArchiveContent,
} from '../archive-folder'
import { writeZip, type ZipPart, type ZipPartSource } from '../zip-writer'

function deferred() {
  let resolve!: (value: ArchiveContent | null) => void
  const promise = new Promise<ArchiveContent | null>((r) => { resolve = r })
  return { promise, resolve }
}

describe('ArchiveFolder', () => {
  it('writes files in the order added, under their folders, and leaves out a read that returns null', async () => {
    const root = ArchiveFolder.root()
    root.file('LÄSMIG.txt', 'hej')
    const dokument = root.folder('dokument')
    dokument.file('a.pdf', async () => new Uint8Array([1, 2, 3]))
    dokument.file('saknas.pdf', async () => null)
    dokument.folder('2024').file('b.pdf', new Uint8Array([4]).buffer)
    root.file('LÄSMIG.txt', 'hej igen') // keeps its place, takes the new content

    const zip = await JSZip.loadAsync(await collectBytes(root.zip()))
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
    expect(names).toEqual(['LÄSMIG.txt', 'dokument/a.pdf', 'dokument/2024/b.pdf'])
    expect(await zip.file('LÄSMIG.txt')!.async('text')).toBe('hej igen')
    expect(await zip.file('dokument/a.pdf')!.async('uint8array')).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('is written once: a second zip fails rather than come out empty', async () => {
    const root = ArchiveFolder.root()
    root.file('a.txt', 'a')
    await collectBytes(root.zip())
    await expect(collectBytes(root.zip())).rejects.toThrow('written once')
  })

  it('reads a deferred file only when the writer reaches it', async () => {
    const root = ArchiveFolder.root()
    const read: string[] = []
    for (const name of ['a', 'b', 'c']) {
      root.file(name, async () => {
        read.push(name)
        return name
      })
    }
    const zip = root.zip()

    await zip.next()
    expect(read).toEqual(['a'])
    await zip.next() // a's data
    await zip.next() // b's header
    expect(read).toEqual(['a', 'b'])
  })
})

/** The parts' bytes in order, read the way the ZIP writer reads them. */
function readParts(parts: readonly ZipPart[]): string {
  return Buffer.concat(
    parts.map((part) => (typeof (part as ZipPartSource).bytes === 'function' ? (part as ZipPartSource).bytes() : (part as Uint8Array))),
  ).toString('utf8')
}

const AWKWARD_ROW = {
  id: 'a-1',
  company_id: null,
  old_state: { amount: -12.5, list: [1, 'två', null, true, { deep: [] }], empty: {} },
  new_state: { text: 'rad\nbrytning "citat" \\ € 🧾 \u2028 åäö', left_out: undefined, fn: () => 1 },
  created_at: '2026-11-20T04:00:00.000Z',
}
const AWKWARD_ARRAYS: unknown[][] = [
  [AWKWARD_ROW, null, 0, 'text', [], {}, [[1, [2]], { a: [] }]],
  [AWKWARD_ROW],
  [],
  [undefined],
]

/** A history of rows like the audit log's, past one held part (1 MB) of text. */
const LONG_HISTORY = Array.from({ length: 1500 }, (_, i) => ({
  ...AWKWARD_ROW,
  id: `audit-${i}`,
  new_state: { ...AWKWARD_ROW.new_state, note: `rad ${i} ${'åäö x '.repeat(i % 97)}` },
}))

describe('jsonArray', () => {
  it('writes the bytes JSON.stringify(array, null, 2) writes, one element at a time', () => {
    for (const array of AWKWARD_ARRAYS) {
      expect(readParts(jsonArray(array.map(jsonArrayElement)))).toBe(JSON.stringify(array, null, 2))
    }
  })

  it('hands out no buffer twice, so a reader that takes a chunk over cannot empty a separator', async () => {
    const entries = [
      { name: 'a.json', data: jsonArray([1, 2, 3].map(jsonArrayElement)) },
      { name: 'b.json', data: jsonArray([4].map(jsonArrayElement)) },
    ]
    const buffers = new Set<ArrayBufferLike>()
    let chunks = 0
    for await (const chunk of writeZip(entries)) {
      buffers.add(chunk.buffer)
      chunks++
    }
    expect(buffers.size).toBe(chunks)
  })
})

describe('DeflatedBytes', () => {
  it('reads back its bytes, as a new buffer of their own size each time', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(LONG_HISTORY.slice(0, 50)))
    for (const dictionary of [undefined, bytes.subarray(0, 4000)]) {
      const held = new DeflatedBytes(bytes, dictionary)
      const first = held.bytes()
      const second = held.bytes()
      expect(held.length).toBe(bytes.length)
      expect(first).toEqual(bytes)
      expect(second).toEqual(bytes)
      expect(first.buffer).not.toBe(second.buffer)
      // Not a view of zlib's larger output buffer, which a reader collecting chunks would hold whole.
      expect(first.buffer.byteLength).toBe(bytes.length)
    }
  })
})

describe('deflatedJsonArray and deflatedJsonArrayElements', () => {
  it('write the bytes JSON.stringify(array, null, 2) writes', async () => {
    for (const array of [...AWKWARD_ARRAYS, LONG_HISTORY]) {
      const inOrder = await deflatedJsonArray(async (push) => array.forEach((value) => push(value)))
      expect(readParts(inOrder)).toBe(JSON.stringify(array, null, 2))

      const hold = deflatedJsonArrayElements()
      expect(readParts(jsonArray(array.map((value) => hold(value))))).toBe(JSON.stringify(array, null, 2))
    }
  })

  it('deflate each element against a copy of the start of the first one only', () => {
    // A first row of hundreds of KB (an audited annual report): zlib copies the dictionary on every row.
    const first = { table_name: 'annual_report_versions', new_state: { report_data: 'årsredovisning '.repeat(40_000) } }
    const hold = deflatedJsonArrayElements()
    const held = [hold(first), hold(AWKWARD_ROW)]

    for (const element of held) {
      const dictionary = (element as unknown as { dictionary: Uint8Array }).dictionary
      expect(dictionary.length).toBe(4096)
      expect(dictionary.buffer.byteLength).toBe(4096)
    }
    expect(readParts(jsonArray(held))).toBe(JSON.stringify([first, AWKWARD_ROW], null, 2))
  })

  it('hold a long array in parts of about a megabyte, not one part or one per element', async () => {
    const parts = await deflatedJsonArray(async (push) => LONG_HISTORY.forEach((value) => push(value)))
    expect(Buffer.byteLength(JSON.stringify(LONG_HISTORY, null, 2))).toBeGreaterThan(1 << 20)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => part instanceof DeflatedBytes)).toBe(true)
    // Every part but the last holds a megabyte of text and at most one element more.
    for (const part of parts.slice(0, -1)) {
      expect(part.length).toBeGreaterThanOrEqual(1 << 20)
      expect(part.length).toBeLessThan((1 << 20) + 16 * 1024)
    }
  })

  it('write a long array through the ZIP writer as the same file JSON.stringify makes', async () => {
    const folder = ArchiveFolder.root()
    folder.file('all.json', await deflatedJsonArray(async (push) => LONG_HISTORY.forEach((value) => push(value))))
    const hold = deflatedJsonArrayElements()
    folder.file('period.json', jsonArray(LONG_HISTORY.map((value) => hold(value))))

    const zip = await JSZip.loadAsync(await collectBytes(folder.zip()), { checkCRC32: true })
    expect(await zip.file('all.json')!.async('text')).toBe(JSON.stringify(LONG_HISTORY, null, 2))
    expect(await zip.file('period.json')!.async('text')).toBe(JSON.stringify(LONG_HISTORY, null, 2))
  })
})

describe('readAhead', () => {
  it('keeps at most `ahead` reads in flight beyond the one being written', async () => {
    const pending = Array.from({ length: 6 }, () => deferred())
    const started: number[] = []
    const reads = readAhead(
      pending.map((p, i) => () => {
        started.push(i)
        return p.promise
      }),
      2,
    )

    const first = reads[0]()
    expect(started).toEqual([0, 1, 2])
    pending[0].resolve('0')
    await expect(first).resolves.toBe('0')

    const second = reads[1]()
    expect(started).toEqual([0, 1, 2, 3])
    pending[1].resolve('1')
    await expect(second).resolves.toBe('1')
  })

  it('hands each read its own result in order, whatever order they finish in', async () => {
    const pending = Array.from({ length: 3 }, () => deferred())
    const reads = readAhead(pending.map((p) => () => p.promise), 5)

    const results = [reads[0](), reads[1](), reads[2]()]
    pending[2].resolve('c')
    pending[0].resolve('a')
    pending[1].resolve('b')
    await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c'])
  })

  it('does not leave a read that fails ahead of its turn unhandled', async () => {
    const reads = readAhead([
      async () => 'a',
      async () => { throw new Error('storage unavailable') },
    ], 1)

    await expect(reads[0]()).resolves.toBe('a')
    await new Promise((r) => setTimeout(r, 0))
    await expect(reads[1]()).rejects.toThrow('storage unavailable')
  })
})

describe('collectBytes with maxBytes', () => {
  async function* chunks(...sizes: number[]) {
    for (const size of sizes) yield new Uint8Array(size)
  }

  it('collects a stream up to and at the cap', async () => {
    expect((await collectBytes(chunks(3, 4), 7)).byteLength).toBe(7)
  })

  it('stops at the first chunk past the cap, without reading on (crm#1703)', async () => {
    let read = 0
    async function* counted() {
      for (const size of [4, 4, 4]) {
        read++
        yield new Uint8Array(size)
      }
    }
    await expect(collectBytes(counted(), 6)).rejects.toBeInstanceOf(ArchiveTooLargeError)
    expect(read).toBe(2)
  })
})
