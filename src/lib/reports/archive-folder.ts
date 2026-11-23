import { constants, deflateRawSync, inflateRawSync } from 'node:zlib'
import { writeZip, type ZipEntry, type ZipPart, type ZipPartSource, type ZipWriterOptions } from './zip-writer'

/** What a file in the archive holds: text (written as UTF-8), bytes, or bytes in parts written in order. */
export type ArchiveContent = string | Uint8Array | ArrayBuffer | readonly ZipPart[]

/**
 * A file read when the writer reaches it rather than when it is added, which
 * is how the underlag go in: memory then holds the files being written, not
 * all of them. Null leaves the file out (a failed read, which the archive's
 * manifest records).
 */
export type ArchiveRead = () => Promise<ArchiveContent | null>

const utf8 = new TextEncoder()

function toBytes(content: ArchiveContent): Uint8Array | readonly ZipPart[] {
  if (typeof content === 'string') return utf8.encode(content)
  if (Array.isArray(content)) return content
  return content instanceof Uint8Array ? content : new Uint8Array(content as ArrayBuffer)
}

/**
 * One element of `JSON.stringify(array, null, 2)` as UTF-8: the value's text
 * indented one level, as the array holds it (for plain data: a toJSON that
 * reads its key would see "" here). With jsonArray it writes a long array as
 * the same bytes while neither its objects nor its text are held whole: a busy
 * company's behandlingshistorik runs to hundreds of MB as either, and as one
 * string it was what ran the cloud backup out of memory.
 */
export function jsonArrayElement(value: unknown): Uint8Array {
  return utf8.encode(`  ${(JSON.stringify(value, null, 2) ?? 'null').replace(/\n/g, '\n  ')}`)
}

/**
 * Bytes held deflated until the ZIP writer reads them, and inflated each time
 * it does. The archive stores them as they are: what changes is only what the
 * function holds meanwhile. A behandlingshistorik of 574 000 rows is 1.2 GB as
 * text, held whole before an archive's first byte; deflated it is a fraction.
 */
export class DeflatedBytes implements ZipPartSource {
  readonly length: number
  private readonly held: Uint8Array

  /**
   * `dictionary`: zlib's preset dictionary, text much like the bytes; inflating
   * needs it again. Keep it small: every deflate and inflate copies it into
   * memory the garbage collector does not see.
   */
  constructor(bytes: Uint8Array, private readonly dictionary?: Uint8Array) {
    this.length = bytes.length
    // Copies, both ways: zlib returns a view of its 64 KB output buffer, and a
    // view held here, or by a reader that collects the chunks, holds that
    // whole buffer for every row. The fastest level: the history is built
    // inside the SIE read lease, which lasts five minutes.
    this.held = new Uint8Array(deflateRawSync(bytes, { level: constants.Z_BEST_SPEED, ...(dictionary ? { dictionary } : {}) }))
  }

  bytes(): Uint8Array {
    return new Uint8Array(inflateRawSync(this.held, this.dictionary ? { dictionary: this.dictionary } : {}))
  }
}

/** How much of the first element deflatedJsonArrayElements deflates the others against. */
const DICTIONARY_BYTES = 4096

/**
 * jsonArrayElement held deflated (DeflatedBytes), for the elements of a long
 * array that are put in order only once all have arrived (jsonArray then
 * writes them). Each is deflated against the start of the first one as a
 * preset dictionary: the rows of one behandlingshistorik share their keys and
 * many values, and a 2 KB row deflated on its own keeps a third to a half of
 * its size, against the first row an eighth to a third. Only the start, and a
 * copy: a first row of hundreds of KB (an audited annual report) would
 * otherwise be copied by zlib for every row, and held that way.
 */
export function deflatedJsonArrayElements(): (value: unknown) => DeflatedBytes {
  let dictionary: Uint8Array | undefined
  return (value) => {
    const element = jsonArrayElement(value)
    dictionary ??= element.slice(0, DICTIONARY_BYTES)
    return new DeflatedBytes(element, dictionary)
  }
}

/** About how much of an array's text one held part covers (deflatedJsonArray). */
const HELD_TEXT_BYTES = 1 << 20

/**
 * `JSON.stringify(array, null, 2)` in parts, for an array whose elements
 * arrive in their order: `fill` pushes each value. The text is held deflated
 * about a megabyte at a time: the bytes jsonArray writes for the values'
 * jsonArrayElement, in a fraction of the memory, and in about a third of the
 * time that holding each element on its own takes.
 */
export async function deflatedJsonArray(
  fill: (push: (value: unknown) => void) => Promise<void>,
): Promise<ZipPart[]> {
  const held: ZipPart[] = []
  let text: Uint8Array[] = []
  let textBytes = 0
  let count = 0
  const hold = () => {
    held.push(new DeflatedBytes(Buffer.concat(text)))
    text = []
    textBytes = 0
  }
  await fill((value) => {
    const element = jsonArrayElement(value)
    text.push(utf8.encode(count++ === 0 ? '[\n' : ',\n'), element)
    textBytes += element.length + 2
    if (textBytes >= HELD_TEXT_BYTES) hold()
  })
  if (count === 0) return [utf8.encode('[]')]
  text.push(utf8.encode('\n]'))
  hold()
  return held
}

/** Text read as new bytes each time: one object stands in for every place it goes. */
function textPart(text: string): ZipPartSource {
  const bytes = utf8.encode(text)
  return { length: bytes.length, bytes: () => bytes.slice() }
}

const ARRAY_OPEN = textPart('[\n')
const ARRAY_SEPARATOR = textPart(',\n')
const ARRAY_CLOSE = textPart('\n]')

/**
 * `JSON.stringify(array, null, 2)` in parts, from the array's elements made by
 * jsonArrayElement. A separator is read as new bytes each time: a reader that
 * takes over a chunk it is handed (a byte stream's enqueue detaches it) must
 * not be able to empty the one written for the next row, or the next archive.
 * One object for every separator rather than a buffer each: a long history
 * has hundreds of thousands.
 */
export function jsonArray(elements: readonly ZipPart[]): ZipPart[] {
  if (elements.length === 0) return [utf8.encode('[]')]
  const parts: ZipPart[] = [ARRAY_OPEN]
  for (const element of elements) parts.push(element, ARRAY_SEPARATOR)
  parts[parts.length - 1] = ARRAY_CLOSE
  return parts
}

/** Stands in for a file once the writer has had it: its content is let go, and a second zip() fails instead of missing it. */
const WRITTEN: ArchiveRead = async () => {
  throw new Error('An archive is written once: this file was written already')
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
      this.files.set(name, WRITTEN)
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
