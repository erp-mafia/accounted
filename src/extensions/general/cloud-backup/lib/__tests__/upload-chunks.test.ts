import { describe, it, expect } from 'vitest'
import { uploadChunks, type UploadChunk } from '../upload-chunks'

async function* partsOf(...parts: number[][]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Uint8Array.from(part)
}

async function all(chunks: AsyncIterable<UploadChunk>): Promise<{ bytes: number[]; last: boolean }[]> {
  const out: { bytes: number[]; last: boolean }[] = []
  for await (const chunk of chunks) out.push({ bytes: [...chunk.bytes], last: chunk.last })
  return out
}

describe('uploadChunks', () => {
  it('cuts the stream into chunks of exactly the size, whatever its parts, and marks the last', async () => {
    const chunks = await all(uploadChunks(partsOf([1, 2], [3, 4, 5, 6, 7], [], [8]), 3))

    expect(chunks).toEqual([
      { bytes: [1, 2, 3], last: false },
      { bytes: [4, 5, 6], last: false },
      { bytes: [7, 8], last: true },
    ])
  })

  it('ends a stream of an exact multiple on a full chunk, with no empty one after it', async () => {
    const chunks = await all(uploadChunks(partsOf([1, 2, 3, 4, 5, 6]), 3))

    expect(chunks).toEqual([
      { bytes: [1, 2, 3], last: false },
      { bytes: [4, 5, 6], last: true },
    ])
  })

  it('gives a short stream as one last chunk, and an empty one as one empty last chunk', async () => {
    expect(await all(uploadChunks(partsOf([9]), 3))).toEqual([{ bytes: [9], last: true }])
    expect(await all(uploadChunks(partsOf(), 3))).toEqual([{ bytes: [], last: true }])
  })

  it('hands on a full chunk only once the next byte has arrived', async () => {
    const events: string[] = []
    async function* source(): AsyncGenerator<Uint8Array> {
      events.push('part 1')
      yield Uint8Array.from([1, 2, 3])
      events.push('part 2')
      yield Uint8Array.from([4])
    }

    for await (const chunk of uploadChunks(source(), 3)) {
      events.push(`chunk ${chunk.bytes.length}${chunk.last ? ' last' : ''}`)
    }

    // Whether [1, 2, 3] is the last chunk is known only from part 2.
    expect(events).toEqual(['part 1', 'part 2', 'chunk 3', 'chunk 1 last'])
  })

  it('copies the bytes: a source that reuses its buffer cannot change a chunk', async () => {
    const shared = Uint8Array.from([1, 2])
    async function* source(): AsyncGenerator<Uint8Array> {
      yield shared
      shared.fill(0)
      yield shared
    }

    expect(await all(uploadChunks(source(), 4))).toEqual([{ bytes: [1, 2, 0, 0], last: true }])
  })
})
