/**
 * The fonts bundled in public/fonts/invoice (Source Sans 3, Source Serif 4),
 * registered with @react-pdf/renderer once per process for every PDF that
 * draws in them: invoices (lib/invoices/pdf-fonts.ts) and the signed copy's
 * Signeringsbevis (lib/signing/certificate-pdf.tsx). Infrastructure, so the
 * ledger kernel reaches them without importing the invoicing block.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Font } from '@react-pdf/renderer'

export type BundledPdfFontFamily = 'Source Sans 3' | 'Source Serif 4'

interface FontVariantFiles {
  regular: string
  bold: string
  italic: string
  boldItalic: string
}

const BUNDLED_FONT_FILES: Record<BundledPdfFontFamily, FontVariantFiles> = {
  'Source Sans 3': {
    regular: 'SourceSans3-Regular.ttf',
    bold: 'SourceSans3-Bold.ttf',
    italic: 'SourceSans3-Italic.ttf',
    boldItalic: 'SourceSans3-BoldItalic.ttf',
  },
  'Source Serif 4': {
    regular: 'SourceSerif4-Regular.ttf',
    bold: 'SourceSerif4-Bold.ttf',
    italic: 'SourceSerif4-Italic.ttf',
    boldItalic: 'SourceSerif4-BoldItalic.ttf',
  },
}

const registeredFamilies = new Set<BundledPdfFontFamily>()
const bundledRegistration = new Map<BundledPdfFontFamily, Promise<void>>()

/** A TrueType file: the 0x00010000 or "true" signature. */
function isTrueType(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true
  return String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'true'
}

async function readBundledFont(fileName: string): Promise<string> {
  const bytes = await readFile(join(process.cwd(), 'public', 'fonts', 'invoice', fileName))
  if (!isTrueType(bytes)) throw new Error(`Invalid bundled font: ${fileName}`)
  return `data:font/ttf;base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Create every glyph the font maps from a character, with that character,
 * before any document is drawn with it.
 *
 * fontkit caches one glyph object per glyph id, keeping the characters of
 * whoever created it first. When a document is embedded, the subset pulls
 * in the components of composite glyphs (A and the ring for Å, O and the
 * diaeresis for Ö) through getGlyph(id) without characters. A later
 * document laying out a plain A or O then gets that cached glyph with no
 * characters, and @react-pdf/renderer drops it from the line or loses it
 * from the text layer ("Ordförande" drawn as "rdförande"). It only bites
 * after a document that used Å or Ö but not A or O, such as the signing
 * stamp with initials "ÅÖ"; created here first, every glyph keeps its
 * character for the life of the process.
 */
function warmGlyphCache(family: BundledPdfFontFamily): void {
  for (const [fontWeight, fontStyle] of [[400, 'normal'], [700, 'normal'], [400, 'italic'], [700, 'italic']] as const) {
    const font = Font.getFont({ fontFamily: family, fontWeight, fontStyle }).data as unknown as {
      characterSet?: number[]
      glyphForCodePoint?: (codePoint: number) => unknown
    } | null
    if (!font?.characterSet || !font.glyphForCodePoint) continue
    for (const codePoint of font.characterSet) font.glyphForCodePoint(codePoint)
  }
}

/** Register a bundled family (all four faces) once per process; concurrent callers share one registration. */
export async function registerBundledFont(family: BundledPdfFontFamily): Promise<void> {
  if (registeredFamilies.has(family)) return

  let registration = bundledRegistration.get(family)
  if (!registration) {
    registration = (async () => {
      const files = BUNDLED_FONT_FILES[family]
      const [regular, bold, italic, boldItalic] = await Promise.all([
        readBundledFont(files.regular),
        readBundledFont(files.bold),
        readBundledFont(files.italic),
        readBundledFont(files.boldItalic),
      ])

      Font.register({
        family,
        fonts: [
          { src: regular, fontWeight: 400, fontStyle: 'normal' },
          { src: bold, fontWeight: 700, fontStyle: 'normal' },
          { src: italic, fontWeight: 400, fontStyle: 'italic' },
          { src: boldItalic, fontWeight: 700, fontStyle: 'italic' },
        ],
      })
      await Promise.all([
        Font.load({ fontFamily: family, fontWeight: 400, fontStyle: 'normal' }),
        Font.load({ fontFamily: family, fontWeight: 700, fontStyle: 'normal' }),
        Font.load({ fontFamily: family, fontWeight: 400, fontStyle: 'italic' }),
        Font.load({ fontFamily: family, fontWeight: 700, fontStyle: 'italic' }),
      ])
      warmGlyphCache(family)
      registeredFamilies.add(family)
    })()
    bundledRegistration.set(family, registration)
  }

  try {
    await registration
  } finally {
    bundledRegistration.delete(family)
  }
}
