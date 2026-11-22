import { writeZip, type ZipEntry, type ZipWriterOptions } from './zip-writer'

/** What a file in the archive holds: text (written as UTF-8), bytes, or bytes in parts written in order. */
export type ArchiveContent = string | Uint8Array | ArrayBuffer | readonly Uint8Array[]

/**
 * A file read when the writer reaches it rather than when it is added, which
 * is how the underlag go in: memory then holds the files being written, not
 * all of them. Null leaves the file out (a failed read, which the archive's
 * manifest records).
 */
export type ArchiveRead = () => Promise<ArchiveContent | null>

const utf8 = new TextEncoder()

function toBytes(content: ArchiveContent): Uint8Array | readonly Uint8Array[] {
  if (typeof content === 'string') return utf8.encode(content)
  if (Array.isArray(content)) return content
  return content instanceof Uint8Array ? content : new Uint8Array(content as ArrayBuffer)
}

const JSON_OPEN = utf8.encode('[\n')
const JSON_COMMA = utf8.encode(',\n')
const JSON_CLOSE = utf8.encode('\n]')

/**
 * One element of `JSON.stringify(array, null, 2)` as UTF-8: the value's text
 * indented one level, as the array holds it. With jsonArray it writes a long
 * array as the same bytes while neither its objects nor its text are held
 * whole: a busy company's behandlingshistorik runs to hundreds of MB as
 * either, and as one string it was what ran the cloud backup out of memory.
 */
export function jsonArrayElement(value: unknown): Uint8Array {
  return utf8.encode(`  ${(JSON.stringify(value, null, 2) ?? 'null').replace(/\n/g, '\n  ')}`)
}

/** `JSON.stringify(array, null, 2)` in parts, from the array's elements made by jsonArrayElement. */
export function jsonArray(elements: readonly Uint8Array[]): Uint8Array[] {
  if (elements.length === 0) return [utf8.encode('[]')]
  const parts: Uint8Array[] = [JSON_OPEN]
  for (const element of elements) parts.push(element, JSON_COMMA)
  parts[parts.length - 1] = JSON_CLOSE
  return parts
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
   * file is read when the writer reaches it. Read it once: deferred reads do
   * not repeat, and each file is let go once it is written.
   */
  zip(options?: ZipWriterOptions): AsyncGenerator<Uint8Array> {
    return writeZip(this.entries(), options)
  }

  private async *entries(): AsyncGenerator<ZipEntry> {
    for (const [name, content] of this.files) {
      this.files.delete(name)
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

/**
 * An archive past its caller's max_bytes, thrown while it is built: a caller
 * that keeps the archive in memory, or stores it where objects are capped,
 * learns it will not fit before it holds it whole (crm#1703).
 */
export class ArchiveTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The archive is over ${Math.round(maxBytes / 1024 / 1024)} MB`)
    this.name = 'ArchiveTooLargeError'
  }
}

/**
 * Read a byte stream to its end, into one ArrayBuffer of exactly its length.
 * With maxBytes, stops reading and throws ArchiveTooLargeError once the
 * stream has passed it.
 */
export async function collectBytes(chunks: AsyncIterable<Uint8Array>, maxBytes?: number): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of chunks) {
    parts.push(chunk)
    length += chunk.length
    if (maxBytes !== undefined && length > maxBytes) throw new ArchiveTooLargeError(maxBytes)
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out.buffer
}
