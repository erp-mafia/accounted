/** One request's worth of a file being uploaded (uploadChunks). */
export interface UploadChunk {
  bytes: Uint8Array<ArrayBuffer>
  /** No byte of the file comes after this chunk. */
  last: boolean
}

/**
 * A byte stream cut into chunks of exactly `size` bytes, the last one
 * shorter (or empty, for an empty stream), each told whether it is the last:
 * both upload protocols say so on the request that ends the file. A full
 * chunk is handed on only once the next byte has arrived, so memory holds at
 * most two chunks besides the piece of the source being cut.
 *
 * Every chunk is new memory: a request body never shares bytes with the
 * source, which may hand on its own buffers, or with another chunk.
 */
export async function* uploadChunks(
  source: AsyncIterable<Uint8Array>,
  size: number
): AsyncGenerator<UploadChunk> {
  let chunk = new Uint8Array(size)
  let filled = 0
  let full: Uint8Array<ArrayBuffer> | null = null
  for await (const part of source) {
    for (let at = 0; at < part.length; ) {
      if (full) {
        yield { bytes: full, last: false }
        full = null
      }
      const take = Math.min(size - filled, part.length - at)
      chunk.set(part.subarray(at, at + take), filled)
      filled += take
      at += take
      if (filled === size) {
        full = chunk
        chunk = new Uint8Array(size)
        filled = 0
      }
    }
  }
  yield full ? { bytes: full, last: true } : { bytes: chunk.subarray(0, filled), last: true }
}
