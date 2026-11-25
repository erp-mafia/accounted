/**
 * Turning a downloaded icon into the one thing we store: a 128 x 128 PNG.
 * Server only (sharp). The bytes are untrusted: the format is sniffed from
 * the bytes themselves (never from the server's content type alone), an SVG
 * that declares entities or points outside itself is refused before librsvg
 * sees it, the decoder's pixel budget is small, and only the PNG sharp
 * encodes is ever stored or served. No raw SVG leaves this module.
 */
import 'server-only'
import { createHash } from 'node:crypto'

type SharpFn = (typeof import('sharp'))['default']
type SharpImage = ReturnType<SharpFn>

/** The stored size. */
export const ICON_SIZE = 128
/** The smallest source we accept: anything smaller is blurry at 40 px on a 2x screen. */
export const MIN_SOURCE_SIZE = 96
/** A source larger than this many pixels is refused before it is decoded. */
const MAX_INPUT_PIXELS = 2048 * 2048

export type SniffedFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'ico' | 'svg'

export function sniffFormat(bytes: Buffer): SniffedFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0) return 'ico'
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart()
  // One run of comments, not a repeated one: its lazy body reaches past a -->
  // when it has to, so one run reads every head several did (a DOCTYPE between
  // two comments included), and a head of '--><!--' has no exponentially many
  // ways to be split into comments.
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
  return null
}

/**
 * Whether an SVG is self-contained enough to rasterise: no DTD entities
 * (entity expansion), no references to files or other hosts (an <image>
 * or <use> pointing outside the document), no <foreignObject>.
 */
export function isSafeSvg(svg: string): boolean {
  if (/<!ENTITY/i.test(svg)) return false
  if (/<foreignObject/i.test(svg) || /@import/i.test(svg)) return false
  // No \s* before the value: [^"']* takes its leading spaces as well and trim()
  // drops them, while the two side by side split a long unclosed run of
  // spaces in quadratically many ways.
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const ref = m[1]!.trim()
    if (ref === '' || ref.startsWith('#')) continue
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(ref)) continue
    return false
  }
  if (/url\(\s*["']?\s*(?!#|data:image\/)[^)]/i.test(svg)) return false
  return true
}

interface IcoEntry {
  width: number
  height: number
  bytes: Buffer
}

/** The entries of an ICO file whose data lies inside the file. */
function icoEntries(ico: Buffer): IcoEntry[] {
  const count = ico.readUInt16LE(4)
  const out: IcoEntry[] = []
  for (let i = 0; i < Math.min(count, 64); i++) {
    const at = 6 + i * 16
    if (at + 16 > ico.length) break
    const width = ico[at]! || 256
    const height = ico[at + 1]! || 256
    const size = ico.readUInt32LE(at + 8)
    const offset = ico.readUInt32LE(at + 12)
    if (size === 0 || offset + size > ico.length) continue
    out.push({ width, height, bytes: ico.subarray(offset, offset + size) })
  }
  return out
}

/**
 * A 32-bit BMP entry of an ICO (a BITMAPINFOHEADER, bottom-up BGRA rows,
 * then the AND mask), as raw RGBA. Other depths are not worth a decoder: at
 * 96 px and above icons are 32-bit or PNG.
 */
function decodeIcoBmp32(bmp: Buffer): { data: Buffer; width: number; height: number } | null {
  if (bmp.length < 40 || bmp.readUInt32LE(0) < 40) return null
  const headerSize = bmp.readUInt32LE(0)
  const width = bmp.readInt32LE(4)
  const height = Math.floor(Math.abs(bmp.readInt32LE(8)) / 2)
  const bpp = bmp.readUInt16LE(14)
  const compression = bmp.readUInt32LE(16)
  if (bpp !== 32 || compression !== 0 || width <= 0 || height <= 0 || width > 1024 || height > 1024) return null
  const rowBytes = width * 4
  if (headerSize + rowBytes * height > bmp.length) return null
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const src = headerSize + (height - 1 - y) * rowBytes
    for (let x = 0; x < width; x++) {
      const s = src + x * 4
      const d = (y * width + x) * 4
      data[d] = bmp[s + 2]!
      data[d + 1] = bmp[s + 1]!
      data[d + 2] = bmp[s]!
      data[d + 3] = bmp[s + 3]!
    }
  }
  return { data, width, height }
}

/** The largest usable picture in an ICO, as something sharp can open. */
function largestIcoImage(sharp: SharpFn, ico: Buffer): { image: SharpImage; width: number } | null {
  const entries = icoEntries(ico).sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height))
  for (const entry of entries) {
    if (Math.min(entry.width, entry.height) < MIN_SOURCE_SIZE) return null
    if (sniffFormat(entry.bytes) === 'png') return { image: sharp(entry.bytes, { limitInputPixels: MAX_INPUT_PIXELS }), width: entry.width }
    const raw = decodeIcoBmp32(entry.bytes)
    if (raw) return { image: sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }), width: raw.width }
  }
  return null
}

export interface NormalisedIcon {
  png: Buffer
  sha256: string
  /** The source's width in px; null for an SVG (it has no pixels of its own). */
  width: number | null
}

export type NormaliseFailure = 'unsupported' | 'too_small' | 'unsafe_svg' | 'undecodable'

/**
 * The stored form of an icon: 128 x 128 PNG, transparent background. A
 * square source that is a tile (an apple-touch-icon is a brand tile, opaque
 * or with rounded corners) fills the square, so the round chip shows the
 * tile; a mark with mostly transparent space around it (an SVG glyph, a
 * cut-out favicon) is fitted inside with a margin, so it never touches the
 * chip's edge.
 */
export async function normaliseIcon(bytes: Buffer): Promise<NormalisedIcon | NormaliseFailure> {
  const format = sniffFormat(bytes)
  if (!format) return 'unsupported'
  try {
    // Lazy, like every sharp user in the app: a native module loads only where it is needed.
    const sharp = (await import('sharp')).default
    let image: SharpImage
    let width: number | null
    if (format === 'svg') {
      const text = bytes.toString('utf8')
      if (!isSafeSvg(text)) return 'unsafe_svg'
      const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
      const longest = Math.max(meta.width ?? 0, meta.height ?? 0)
      if (!longest) return 'undecodable'
      // Render at twice the stored size, whatever size the SVG declares, then scale down.
      const density = Math.min(2400, Math.max(1, (72 * ICON_SIZE * 2) / longest))
      image = sharp(bytes, { density, limitInputPixels: MAX_INPUT_PIXELS })
      width = null
    } else if (format === 'ico') {
      const picked = largestIcoImage(sharp, bytes)
      if (!picked) return 'too_small'
      image = picked.image
      width = picked.width
    } else {
      image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      const meta = await image.metadata()
      if (!meta.width || !meta.height) return 'undecodable'
      if (Math.min(meta.width, meta.height) < MIN_SOURCE_SIZE) return 'too_small'
      width = meta.width
    }

    const raster = await image.ensureAlpha().png().toBuffer({ resolveWithObject: true })
    const { width: w, height: h } = raster.info
    if (width !== null && Math.min(w, h) < MIN_SOURCE_SIZE) return 'too_small'
    const stats = await sharp(raster.data).stats()
    const square = Math.abs(w - h) <= Math.max(w, h) * 0.05
    // A tile: opaque, or a raster covering at least three quarters of its
    // square (a rounded square or a round badge with transparent corners). An
    // SVG with any transparency is a glyph however much it covers, and like
    // any other glyph it gets a margin.
    const alphaMean = stats.channels[3]?.mean ?? 255
    const tile = square && (stats.isOpaque || (format !== 'svg' && alphaMean >= 0.75 * 255))

    const transparent = { r: 0, g: 0, b: 0, alpha: 0 }
    const inner = tile ? ICON_SIZE : Math.round(ICON_SIZE * 0.75)
    const fitted = await sharp(raster.data)
      .resize(inner, inner, { fit: tile ? 'cover' : 'contain', background: transparent })
      .png()
      .toBuffer()
    const pad = (ICON_SIZE - inner) / 2
    const png = await sharp(fitted)
      .extend({ top: Math.floor(pad), bottom: Math.ceil(pad), left: Math.floor(pad), right: Math.ceil(pad), background: transparent })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer()
    return { png, sha256: createHash('sha256').update(png).digest('hex'), width }
  } catch {
    return 'undecodable'
  }
}
