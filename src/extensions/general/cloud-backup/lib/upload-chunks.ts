/**
 * A file's bytes as the providers' upload chunks, cut from the stream as it
 * is produced: memory holds one chunk and the piece it was cut from, never
 * the file. Every chunk but the last is exactly `size` bytes, and the last
 * says so: a stream does not tell its length up front, and both upload
 * protocols must know which request ends the file. An empty file is one
 * empty last chunk.
 */
export async function* uploadChunks(
  source: AsyncIterable<Uint8Array>,
  size: number
): AsyncGenerator<{ chunk: Uint8Array<ArrayBuffer>; last: boolean }> {
  const held: Uint8Array[] = []
  let heldBytes = 0
  const take = (n: number): Uint8Array<ArrayBuffer> => {
    const chunk = new Uint8Array(n)
    for (let at = 0; at < n; ) {
      const head = held[0]
      const used = Math.min(head.length, n - at)
      chunk.set(head.subarray(0, used), at)
      at += used
      if (used === head.length) held.shift()
      else held[0] = head.subarray(used)
    }
    heldBytes -= n
    return chunk
  }
  for await (const piece of source) {
    if (piece.length === 0) continue
    held.push(piece)
    heldBytes += piece.length
    // Strictly more than a chunk: the chunk cut now cannot be the last.
    while (heldBytes > size) yield { chunk: take(size), last: false }
  }
  yield { chunk: take(heldBytes), last: true }
}
