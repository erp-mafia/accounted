import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { ArchiveFolder, collectBytes, readAhead, type ArchiveContent } from '../archive-folder'

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
