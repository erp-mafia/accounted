/**
 * The company logo as the signing mails and the Signeringsbevis page draw
 * it, from company_settings.logo_url (./brand.ts).
 *
 * The stored URL is tenant input, so it is read only through the shared
 * logo resolver (lib/pdf/logo.ts: the outbound URL guard, a size cap, a
 * re-encode to PNG, a short cache). The PDF draws that PNG. The mail cannot
 * carry it (a data URL is stripped by most clients), so it links the stored
 * URL itself, at the size the PNG says, and only when the stored file is a
 * format every mail client shows (PNG, JPEG, GIF: not WebP or SVG, which
 * Outlook and Gmail drop). Anything else draws the company's initials.
 */
import { embeddableLogoUrl } from '@/lib/pdf/logo'

export interface SigningLogo {
  /** A PNG data URL @react-pdf/renderer draws. */
  dataUrl: string
  /** Intrinsic size of that PNG, in pixels. */
  width: number
  height: number
}

export interface MailLogo {
  /** The stored, absolute https URL. */
  src: string
  /** Display size in CSS pixels, the logo's own aspect ratio kept. */
  width: number
  height: number
}

/** Width and height from a PNG's IHDR chunk, or null for anything else. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** The company logo as a drawable PNG with its size, or null when there is none or it cannot be read. */
export async function resolveSigningLogo(logoUrl: string | null): Promise<SigningLogo | null> {
  if (!logoUrl) return null
  const dataUrl = await embeddableLogoUrl(logoUrl)
  const match = dataUrl?.match(/^data:image\/png;base64,(.+)$/)
  if (!dataUrl || !match) return null
  const size = pngSize(new Uint8Array(Buffer.from(match[1]!.slice(0, 64), 'base64')))
  return size ? { dataUrl, ...size } : null
}

/**
 * Scale a width and height to fit a box, never past either side: the logo
 * keeps its aspect ratio, a wide wordmark gets the full width and a square
 * mark the full height.
 */
export function fitLogo(size: { width: number; height: number }, box: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(box.width / size.width, box.height / size.height)
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

const MAIL_SAFE_LOGO = /\.(png|jpe?g|gif)$/i

/** The logo for a mail: the stored https URL at its display size, or null to draw initials instead. */
export function mailLogo(logoUrl: string | null, logo: SigningLogo | null, box = { width: 160, height: 48 }): MailLogo | null {
  if (!logoUrl || !logo) return null
  let url: URL
  try {
    url = new URL(logoUrl)
  } catch {
    // Not a URL at all: a mail cannot link it, so the initials stand in.
    return null
  }
  if (url.protocol !== 'https:' || !MAIL_SAFE_LOGO.test(url.pathname)) return null
  return { src: url.toString(), ...fitLogo(logo, box) }
}

/** Legal-form words that say nothing about which company it is. */
const LEGAL_FORM = new Set(['ab', 'hb', 'kb', 'aktiebolag', 'handelsbolag', 'kommanditbolag', 'ek', 'för', 'ekonomisk', 'förening', '(publ)', 'publ'])

/** Two letters for a company without a logo: "Arcim Technology AB" is "AT". */
export function companyInitials(name: string): string {
  const words = name
    .normalize('NFC')
    .split(/[\s&.,]+/)
    .filter((w) => w && !LEGAL_FORM.has(w.toLocaleLowerCase('sv-SE')))
  const letters = words
    .map((w) => [...w].find((c) => /\p{L}|\p{N}/u.test(c)))
    .filter((c): c is string => Boolean(c))
  const initials = letters.length >= 2 ? letters[0]! + letters[1]! : letters[0] ?? [...name.trim()][0] ?? '?'
  return initials.toLocaleUpperCase('sv-SE')
}
