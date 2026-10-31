import { writeZip, type ZipWriterOptions } from './zip-writer'

/** What a file in the archive holds: text (written as UTF-8) or bytes. */
export type ArchiveContent = string | Uint8Array | ArrayBuffer

/**
 * A file read when the writer reaches it rather than when it is added, which
 * is how the underlag go in: memory then holds the files being written, not
 * all of them. Null leaves the file out (a failed read, which the archive's
 * manifest records).
 */
export type ArchiveRead = () => Promise<ArchiveContent | null>

const utf8 = new TextEncoder()

function toBytes(content: ArchiveContent): Uint8Array {
  if (typeof content === 'string') return utf8.encode(content)
  return content instanceof Uint8Array ? content : new Uint8Array(content)
}

/**
 * The files of an archive in the order they are written, addressed by folder
 * the way the archive builders addressed JSZip. A path added twice keeps its
 * first place and its last content, as in JSZip.
 */
export class ArchiveFolder {
  private constructor(
    private readonly files: Map<string, ArchiveContent | ArchiveRead>,
    private readonly prefix: string,
  ) {}

  static root(): ArchiveFolder {
    return new ArchiveFolder(new Map(), '')
  }

  file(name: string, content: ArchiveContent | ArchiveRead): void {
    this.files.set(this.prefix + name, content)
  }

  folder(name: string): ArchiveFolder {
    return new ArchiveFolder(this.files, `${this.prefix}${name}/`)
  }

  /**
   * The whole archive as ZIP bytes, produced as they are read: a deferred
   * file is read when the writer reaches it. Read it once; deferred reads do
   * not repeat.
   */
  zip(options?: ZipWriterOptions): AsyncGenerator<Uint8Array> {
    return writeZip(this.entries(), options)
  }

  private async *entries(): AsyncGenerator<{ name: string; data: Uint8Array }> {
    for (const [name, content] of this.files) {
      const data = typeof content === 'function' ? await content() : content
      if (data !== null) yield { name, data: toBytes(data) }
    }
  }
}

/**
 * Start each read up to `ahead` places before the writer reaches it. The
 * writer takes the reads in order, one at a time; without a few in flight, an
 * archive of thousands of underlag spends most of its time waiting on storage
 * round trips. At most `ahead + 1` files are held at once, and each read is
 * let go as soon as it is handed over.
 */
export function readAhead(reads: ArchiveRead[], ahead: number): ArchiveRead[] {
  const inFlight = new Map<number, Promise<ArchiveContent | null>>()
  let started = 0
  return reads.map((_, index) => () => {
    for (; started < reads.length && started <= index + ahead; started++) {
      const read = reads[started]()
      read.catch(() => {}) // observed when its turn comes; until then a rejection must not count as unhandled
      inFlight.set(started, read)
    }
    const read = inFlight.get(index)
    inFlight.delete(index)
    return read ?? reads[index]()
  })
}

/** Read a byte stream to its end, into one ArrayBuffer of exactly its length. */
export async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of chunks) {
    parts.push(chunk)
    length += chunk.length
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out.buffer
}
