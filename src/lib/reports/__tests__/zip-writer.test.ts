import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { collectBytes } from '../archive-folder'
import { crc32, writeZip, type ZipEntry } from '../zip-writer'

const text = (value: string) => new TextEncoder().encode(value)

const ENTRIES: ZipEntry[] = [
  { name: 'LÄSMIG.txt', data: text('Räkenskapsår 2024: åäö') },
  { name: 'sie/2024.se', data: text('#FLAGGA 0\n') },
  { name: 'dokument/2024/A17_kvitto.pdf', data: Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) % 256) },
  { name: 'dokument/manifest.json', data: new Uint8Array(0) },
]

async function readBack(zip: ArrayBuffer): Promise<Record<string, Uint8Array>> {
  // checkCRC32 makes the reader verify every entry's checksum against its bytes.
  const archive = await JSZip.loadAsync(zip, { checkCRC32: true })
  const out: Record<string, Uint8Array> = {}
  for (const name of Object.keys(archive.files)) {
    if (!archive.files[name].dir) out[name] = await archive.files[name].async('uint8array')
  }
  return out
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('continues over data that arrives in parts', () => {
    expect(crc32(text('6789'), crc32(text('12345')))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0), 0xcbf43926)).toBe(0xcbf43926)
  })
})

describe('writeZip', () => {
  it('writes a ZIP that reads back byte for byte, names with å, ä and ö included', async () => {
    const files = await readBack(await collectBytes(writeZip(ENTRIES)))

    expect(Object.keys(files)).toEqual(ENTRIES.map((e) => e.name))
    for (const entry of ENTRIES) expect(files[entry.name]).toEqual(entry.data)
  })

  it('stamps the UTF-8 flag only on names outside ASCII', async () => {
    const zip = new Uint8Array(await collectBytes(writeZip(ENTRIES.slice(0, 2))))
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800) // LÄSMIG.txt
    const second = 30 + view.getUint16(26, true) + view.getUint16(28, true) + view.getUint32(18, true)
    expect(view.getUint32(second, true)).toBe(0x04034b50)
    expect(view.getUint16(second + 6, true) & 0x0800).toBe(0) // sie/2024.se
  })

  it('pulls the next entry only after the current one is handed on', async () => {
    const pulled: string[] = []
    async function* source(): AsyncGenerator<ZipEntry> {
      for (const entry of ENTRIES) {
        pulled.push(entry.name)
        yield entry
      }
    }
    const writer = writeZip(source())

    await writer.next() // local header of the first entry
    await writer.next() // its data
    expect(pulled).toEqual(['LÄSMIG.txt'])
    await writer.next()
    expect(pulled).toEqual(['LÄSMIG.txt', 'sie/2024.se'])
  })

  it('writes an entry given in parts as the same bytes as the entry whole', async () => {
    const date = new Date(Date.UTC(2026, 10, 22, 4, 0, 0))
    const whole = text(`[\n  {"text": "Faktura € mars ${'å'.repeat(3000)}"}\n]`)
    const parts = [whole.subarray(0, 2), new Uint8Array(0), whole.subarray(2, 4000), whole.subarray(4000)]

    const asParts = await collectBytes(writeZip([ENTRIES[0], { name: 'revision/b.json', data: parts }], { date }))
    const asWhole = await collectBytes(writeZip([ENTRIES[0], { name: 'revision/b.json', data: whole }], { date }))

    expect(new Uint8Array(asParts)).toEqual(new Uint8Array(asWhole))
    expect((await readBack(asParts))['revision/b.json']).toEqual(whole)
  })

  it('writes no ZIP64 records while offsets and counts fit 32 and 16 bits', async () => {
    const zip = new Uint8Array(await collectBytes(writeZip(ENTRIES)))
    const tail = new DataView(zip.buffer, zip.length - 22)
    expect(tail.getUint32(0, true)).toBe(0x06054b50)
    expect(tail.getUint16(10, true)).toBe(ENTRIES.length)
    // No ZIP64 locator in front of the end record.
    expect(new DataView(zip.buffer).getUint32(zip.length - 42, true)).not.toBe(0x07064b50)
  })

  // An archive past 4 GiB or 65,535 entries
  // must switch to ZIP64 instead of wrapping its offsets. The thresholds are
  // lowered so the records are exercised without writing gigabytes.
  it('switches to ZIP64 records once an offset or the entry count overflows', async () => {
    const zip = await collectBytes(writeZip(ENTRIES, { zip64From: { uint32: 64, uint16: 2 } }))
    const bytes = new Uint8Array(zip)
    const view = new DataView(zip)

    const end = bytes.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(0xffff)
    expect(view.getUint32(end + 16, true)).toBe(0xffffffff)
    const locator = end - 20
    expect(view.getUint32(locator, true)).toBe(0x07064b50)
    const zip64End = Number(view.getBigUint64(locator + 8, true))
    expect(view.getUint32(zip64End, true)).toBe(0x06064b50)
    expect(Number(view.getBigUint64(zip64End + 32, true))).toBe(ENTRIES.length)

    // A reader that follows the ZIP64 records gets every entry back intact.
    const files = await readBack(zip)
    for (const entry of ENTRIES) expect(files[entry.name]).toEqual(entry.data)
  })
})
