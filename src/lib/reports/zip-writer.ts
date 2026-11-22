/**
 * A ZIP writer that streams: entries go in one at a time and the archive's
 * bytes come out as each entry is written, so memory holds one entry rather
 * than the whole archive. Built for the complete archive
 * (full-archive-export.ts), which runs to gigabytes for a company with years
 * of underlag.
 *
 * Entries are stored, not deflated, as the archive always has been: the
 * receipts and PDFs that make up its bulk are compressed already. Each entry's
 * bytes are in hand before its header is written, so the header carries the
 * real CRC and sizes and no data descriptor is needed.
 *
 * ZIP64 records (APPNOTE.TXT 4.5) are written only once an offset or the
 * central directory passes 4 GiB, or the entries pass 65,535. Below that the
 * output is a plain ZIP that every unzipper reads; past it the archive stays
 * readable instead of wrapping its 32-bit offsets.
 */

export interface ZipEntry {
  /** Path inside the archive, '/'-separated. */
  name: string
  /** The bytes, whole or in parts written one after another. */
  data: Uint8Array | readonly Uint8Array[]
}

export interface ZipWriterOptions {
  /** Modification time stamped on every entry (default: now). */
  date?: Date
  /**
   * The values at which a 32-bit and a 16-bit field switch to ZIP64. Only
   * tests lower them, to exercise the ZIP64 records without writing 4 GiB.
   */
  zip64From?: { uint32: number; uint16: number }
}

const UINT16_MARKER = 0xffff
const UINT32_MARKER = 0xffffffff
/** DOS platform, the version JSZip stamped on the archives before this writer. */
const MADE_BY = 0x0014
const NEEDED_STORED = 10
const NEEDED_ZIP64 = 45
/** General purpose bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/**
 * CRC-32 (ISO-HDLC), the checksum every ZIP entry carries. `previous` is the
 * checksum of the data before `data`, for data that arrives in parts.
 */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

const utf8 = new TextEncoder()

/** DOS date and time in UTC, as JSZip wrote them. */
function dosDateTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

function record(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

/**
 * The Info-ZIP Unicode Path field (0x7075) for a name outside ASCII. The UTF-8
 * flag alone would do for current unzippers; Info-ZIP unzip wants an extra
 * field before it trusts the flag, and JSZip wrote this one, so names with
 * å, ä and ö read the same as in the archives users already hold.
 */
function unicodePathField(name: Uint8Array): Uint8Array {
  const field = record(4 + 5 + name.length, (view) => {
    view.setUint16(0, 0x7075, true)
    view.setUint16(2, 5 + name.length, true)
    view.setUint8(4, 1)
    view.setUint32(5, crc32(name), true)
  })
  field.set(name, 9)
  return field
}

/** ZIP64 extended information in a central header: only the local header offset overflows. */
function zip64OffsetField(offset: number): Uint8Array {
  return record(12, (view) => {
    view.setUint16(0, 0x0001, true)
    view.setUint16(2, 8, true)
    view.setBigUint64(4, BigInt(offset), true)
  })
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Write `entries` as a ZIP, yielding its bytes in order. The next entry is
 * not pulled until the current one has been handed on, so a lazy source reads
 * one file at a time.
 */
export async function* writeZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: ZipWriterOptions = {},
): AsyncGenerator<Uint8Array> {
  const { time, day } = dosDateTime(options.date ?? new Date())
  const zip64From32 = options.zip64From?.uint32 ?? UINT32_MARKER
  const zip64From16 = options.zip64From?.uint16 ?? UINT16_MARKER
  const central: Uint8Array[] = []
  let offset = 0

  for await (const entry of entries) {
    const parts: readonly Uint8Array[] = Array.isArray(entry.data) ? entry.data : [entry.data as Uint8Array]
    let size = 0
    let crc = 0
    for (const part of parts) {
      size += part.length
      crc = crc32(part, crc)
    }
    // Each entry is held in memory before it is written, so none comes near
    // this; the check keeps a size from wrapping silently if one ever does.
    if (size >= UINT32_MARKER) throw new Error(`ZIP entry too large: ${entry.name}`)
    const name = utf8.encode(entry.name)
    // Any character outside ASCII encodes to more bytes than UTF-16 units.
    const isUtf8 = name.length !== entry.name.length
    const extra = isUtf8 ? unicodePathField(name) : new Uint8Array(0)
    const flags = isUtf8 ? FLAG_UTF8 : 0

    const local = record(30 + name.length + extra.length, (view) => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, NEEDED_STORED, true)
      view.setUint16(6, flags, true)
      view.setUint16(8, 0, true) // stored
      view.setUint16(10, time, true)
      view.setUint16(12, day, true)
      view.setUint32(14, crc, true)
      view.setUint32(18, size, true)
      view.setUint32(22, size, true)
      view.setUint16(26, name.length, true)
      view.setUint16(28, extra.length, true)
    })
    local.set(name, 30)
    local.set(extra, 30 + name.length)
    yield local
    for (const part of parts) if (part.length > 0) yield part

    const zip64 = offset >= zip64From32
    const centralExtra = zip64 ? concat([extra, zip64OffsetField(offset)]) : extra
    const header = record(46 + name.length + centralExtra.length, (view) => {
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, zip64 ? (MADE_BY & 0xff00) | NEEDED_ZIP64 : MADE_BY, true)
      view.setUint16(6, zip64 ? NEEDED_ZIP64 : NEEDED_STORED, true)
      view.setUint16(8, flags, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, time, true)
      view.setUint16(14, day, true)
      view.setUint32(16, crc, true)
      view.setUint32(20, size, true)
      view.setUint32(24, size, true)
      view.setUint16(28, name.length, true)
      view.setUint16(30, centralExtra.length, true)
      // comment length, disk number start, internal and external attributes: 0
      view.setUint32(42, zip64 ? UINT32_MARKER : offset, true)
    })
    header.set(name, 46)
    header.set(centralExtra, 46 + name.length)
    central.push(header)
    offset += local.length + size
  }

  const directory = concat(central)
  const count = central.length
  const directoryOffset = offset
  yield directory

  const countOverflows = count >= zip64From16
  const sizeOverflows = directory.length >= zip64From32
  const offsetOverflows = directoryOffset >= zip64From32
  if (countOverflows || sizeOverflows || offsetOverflows) {
    const zip64EndOffset = directoryOffset + directory.length
    yield record(56, (view) => {
      view.setUint32(0, 0x06064b50, true)
      view.setBigUint64(4, BigInt(44), true) // size of the rest of this record
      view.setUint16(12, NEEDED_ZIP64, true)
      view.setUint16(14, NEEDED_ZIP64, true)
      // this disk and the directory's disk: 0
      view.setBigUint64(24, BigInt(count), true)
      view.setBigUint64(32, BigInt(count), true)
      view.setBigUint64(40, BigInt(directory.length), true)
      view.setBigUint64(48, BigInt(directoryOffset), true)
    })
    yield record(20, (view) => {
      view.setUint32(0, 0x07064b50, true)
      view.setBigUint64(8, BigInt(zip64EndOffset), true)
      view.setUint32(16, 1, true) // total disks
    })
  }

  yield record(22, (view) => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(8, countOverflows ? UINT16_MARKER : count, true)
    view.setUint16(10, countOverflows ? UINT16_MARKER : count, true)
    view.setUint32(12, sizeOverflows ? UINT32_MARKER : directory.length, true)
    view.setUint32(16, offsetOverflows ? UINT32_MARKER : directoryOffset, true)
  })
}
