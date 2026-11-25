import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { isSafeSvg, normaliseIcon, sniffFormat } from '../image'

async function png(size: number, opts: { transparent?: boolean } = {}): Promise<Buffer> {
  if (!opts.transparent) {
    return sharp({ create: { width: size, height: size, channels: 4, background: { r: 20, g: 90, b: 200, alpha: 1 } } }).png().toBuffer()
  }
  // A small dot in the middle of a transparent square: a glyph, not a tile.
  const dot = await sharp({ create: { width: Math.round(size / 3), height: Math.round(size / 3), channels: 4, background: '#e11' } }).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: dot, gravity: 'center' }])
    .png()
    .toBuffer()
}

/** An ICO file holding the given entries (PNG bytes or raw 32-bit BMP DIBs). */
function ico(entries: Array<{ size: number; bytes: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + entries.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((e, i) => {
    const at = 6 + i * 16
    header[at] = e.size >= 256 ? 0 : e.size
    header[at + 1] = e.size >= 256 ? 0 : e.size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(e.bytes.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += e.bytes.length
  })
  return Buffer.concat([header, ...entries.map((e) => e.bytes)])
}

function bmp32(size: number): Buffer {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const pixels = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) pixels.set([200, 100, 10, 255], i * 4)
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, mask])
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#0a7"/></svg>'

describe('sniffFormat', () => {
  it('reads the format from the bytes', async () => {
    expect(sniffFormat(await png(100))).toBe('png')
    expect(sniffFormat(Buffer.from(SVG))).toBe('svg')
    expect(sniffFormat(Buffer.from(`<?xml version="1.0"?>\n${SVG}`))).toBe('svg')
    expect(sniffFormat(ico([{ size: 32, bytes: await png(32) }]))).toBe('ico')
    expect(sniffFormat(Buffer.from('<html><body>not an icon</body></html>'))).toBeNull()
  })

  it.each([
    ['an Illustrator head', `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n${SVG}`],
    [
      'an Illustrator head with a DOCTYPE',
      `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 15.0.0, SVG Export Plug-In  -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG}`,
    ],
    ['an Inkscape head', `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Created with Inkscape (http://www.inkscape.org/) -->\n\n${SVG}`],
    ['two comments', `<!-- one -->\n<!-- two -->\n${SVG}`],
    ['a DOCTYPE between two comments', `<!-- one --><!DOCTYPE svg><!-- two -->${SVG}`],
    ['a hundred empty comments', `${'<!---->'.repeat(100)}${SVG}`],
    ['a byte order mark and upper case', '\uFEFF\n<SVG xmlns="http://www.w3.org/2000/svg"></SVG>'],
  ])('reads %s as SVG, as before', (_, head) => {
    expect(sniffFormat(Buffer.from(head))).toBe('svg')
  })

  it.each([
    ['a comment that never ends', `<!-- ${SVG}`],
    ['text before the svg element', `<p>logo</p>${SVG}`],
    ['an element that is not svg', '<svgx/>'],
  ])('does not read %s as SVG, as before', (_, head) => {
    expect(sniffFormat(Buffer.from(head))).toBeNull()
  })

  // Each '--><!--' more used to double the time the check took. The bound is
  // checked after every head, shortest first, so a slow check fails on a
  // short one instead of never returning on the whole kilobyte it reads.
  it('answers at once for a head of repeated comment ends, up to the kilobyte it reads', () => {
    const started = Date.now()
    for (const n of [18, 22, 26, 30, 200]) {
      expect(sniffFormat(Buffer.from(`<!--${'--><!--'.repeat(n)}x`))).toBeNull()
      expect(Date.now() - started).toBeLessThan(1000)
    }
  })
})

describe('isSafeSvg', () => {
  it('refuses entities, outside references, foreignObject and imports', () => {
    expect(isSafeSvg(SVG)).toBe(true)
    expect(isSafeSvg('<svg><use href="#a"/><linearGradient id="a"/><rect fill="url(#a)"/></svg>')).toBe(true)
    expect(isSafeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>')).toBe(false)
    expect(isSafeSvg('<svg><image href="file:///etc/passwd"/></svg>')).toBe(false)
    expect(isSafeSvg('<svg><image xlink:href="https://tracker.example/p.png"/></svg>')).toBe(false)
    expect(isSafeSvg('<svg><foreignObject/></svg>')).toBe(false)
    expect(isSafeSvg('<svg><style>@import "x.css";</style></svg>')).toBe(false)
    expect(isSafeSvg('<svg><rect style="fill:url(https://x.example/a)"/></svg>')).toBe(false)
  })

  it('reads a reference with spaces around it as before', () => {
    expect(isSafeSvg('<svg><use href=" #a "/></svg>')).toBe(true)
    expect(isSafeSvg("<svg><image xlink:href = ' data:image/png;base64,iVBORw0KGgo='/></svg>")).toBe(true)
    expect(isSafeSvg('<svg><image href="  https://tracker.example/p.png"/></svg>')).toBe(false)
  })

  it('answers at once for a reference that is never closed, up to an icon as large as we fetch', () => {
    // Without its closing quote it is no reference, as before; librsvg then
    // refuses the file. A slow check fails on the smaller icon first.
    const open = '<svg><a href="'
    const started = Date.now()
    for (const size of [80 * 1024, 300 * 1024]) {
      expect(isSafeSvg(`${open}${' '.repeat(size - open.length)}`)).toBe(true)
      expect(Date.now() - started).toBeLessThan(1000)
    }
  })
})

describe('normaliseIcon', () => {
  it('turns an opaque 180 px tile into a 128 px PNG that fills the square', async () => {
    const out = await normaliseIcon(await png(180))
    if (typeof out === 'string') throw new Error(out)
    const meta = await sharp(out.png).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 128, 128])
    expect(out.width).toBe(180)
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
    const corner = await sharp(out.png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()
    expect(corner[3]).toBe(255)
  })

  it('gives a transparent glyph a margin', async () => {
    const out = await normaliseIcon(await png(160, { transparent: true }))
    if (typeof out === 'string') throw new Error(out)
    const edge = await sharp(out.png).extract({ left: 4, top: 64, width: 1, height: 1 }).raw().toBuffer()
    expect(edge[3]).toBe(0)
  })

  it('refuses a source under 96 px', async () => {
    expect(await normaliseIcon(await png(64))).toBe('too_small')
  })

  it('rasterises a safe SVG and refuses an unsafe one', async () => {
    const out = await normaliseIcon(Buffer.from(SVG))
    if (typeof out === 'string') throw new Error(out)
    expect((await sharp(out.png).metadata()).width).toBe(128)
    expect(out.width).toBeNull()
    expect(await normaliseIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'))).toBe('unsafe_svg')
  })

  it('takes the largest PNG entry of an ICO, and refuses one with only small entries', async () => {
    const out = await normaliseIcon(ico([{ size: 32, bytes: await png(32) }, { size: 128, bytes: await png(128) }]))
    if (typeof out === 'string') throw new Error(out)
    expect(out.width).toBe(128)
    expect(await normaliseIcon(ico([{ size: 16, bytes: await png(16) }, { size: 48, bytes: await png(48) }]))).toBe('too_small')
  })

  it('decodes a 32-bit BMP entry of an ICO', async () => {
    const out = await normaliseIcon(ico([{ size: 96, bytes: bmp32(96) }]))
    if (typeof out === 'string') throw new Error(out)
    expect(out.width).toBe(96)
    const pixel = await sharp(out.png).extract({ left: 64, top: 64, width: 1, height: 1 }).raw().toBuffer()
    expect([pixel[0], pixel[1], pixel[2]]).toEqual([10, 100, 200])
  })

  it('refuses what is not an image', async () => {
    expect(await normaliseIcon(Buffer.from('<html></html>'))).toBe('unsupported')
    expect(await normaliseIcon(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))).toBe('undecodable')
  })
})
