/**
 * The signed copy's own pages, drawn with @react-pdf/renderer in the
 * invoice fonts (Source Sans 3, Source Serif 4: every Swedish letter, where
 * pdf-lib's standard fonts print "?" outside WinAnsi). ./seal.ts appends
 * them to the original with pdf-lib.
 *
 *   - The Signeringsbevis: the company, the document, who signed as what,
 *     with which BankID and when, the document's facts, what a BankID
 *     signature is (and, on a sealed copy, that the file is sealed and
 *     carries the original), and where a copy is checked. Header and footer repeat
 *     on every page; a signer row never splits, so many signers paginate.
 *   - The stamp: one strip per page width, "Signerat med BankID av JW, EM ·
 *     ID 1569BCE7 · app.accounted.se/verifiera" between two hairlines, that
 *     seal.ts draws in the bottom margin of every original page (DocuSign
 *     stamps its envelope id on each page, Scrive a document id and the
 *     signers' initials).
 *
 * Layout rules shared with the other PDFs: no `break` props (they deadlock
 * multi-page renders in @react-pdf/renderer 4), rows `wrap={false}`.
 */
import { Document, Image, Link, Page, Path, StyleSheet, Svg, Text, View } from '@react-pdf/renderer'
import { registerBundledFont } from '@/lib/pdf/bundled-fonts'
import { createLogger } from '@/lib/logger'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { BANKID_SYMBOL_PATHS, BANKID_SYMBOL_VIEWBOX, BANKID_VIEWBOX, BANKID_WORDMARK_PATHS } from './bankid-mark'
import { formatSigningMoment, formatSigningShortMoment } from './format'
import { companyInitials, fitLogo, type SigningLogo } from './logo'

const log = createLogger('signing.certificate')

/** Words break at spaces only: the default hyphenation is English and splits Swedish words wrong. */
const noHyphens = (word: string) => [word]

const INK = '#1c1b19'
const BODY = '#45433f'
const MUTED = '#6b6862'
const HAIRLINE = '#e5e2dc'
const TILE = '#efece6'

/** The strip the stamp is drawn from: its height, and the gap under it to the page's edge. */
export const STAMP_STRIP_HEIGHT = 12
export const STAMP_BOTTOM_OFFSET = 14
/** A page narrower than this gets the stamp of this width, scaled down to fit. */
export const STAMP_MIN_WIDTH = 400

export interface SigningPdfFonts {
  sans: string
  serif: string
  mono: string
}

/**
 * The bundled fonts, registered once per process. A failed registration
 * (a missing file in a function bundle) falls back to the standard fonts
 * rather than leaving the request unsealed.
 */
export async function prepareSigningFonts(): Promise<SigningPdfFonts> {
  try {
    await Promise.all([registerBundledFont('Source Sans 3'), registerBundledFont('Source Serif 4')])
    return { sans: 'Source Sans 3', serif: 'Source Serif 4', mono: 'Courier' }
  } catch (err) {
    log.warn('signing fonts unavailable, drawing the signed copy in the standard fonts', { error: err instanceof Error ? err.message : String(err) })
    return { sans: 'Helvetica', serif: 'Times-Roman', mono: 'Courier' }
  }
}

/** The short id every page of the signed copy prints: the first 8 hex digits of the request id. */
export function shortSigningId(requestId: string): string {
  return requestId.replace(/-/g, '').slice(0, 8).toUpperCase()
}

/** A URL as a reader types it: no scheme, no trailing slash. */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

const firstLetter = (word: string | undefined) => (word ? [...word].find((c) => /\p{L}|\p{N}/u.test(c)) ?? '' : '')

/** "AA" for Anna Andersson, "EL" for Erik Berg Lund: the first given name and the last surname. */
export function bankIdInitials(givenName: string, surname: string): string {
  const given = givenName.trim().split(/\s+/)
  const sur = surname.trim().split(/\s+/)
  return `${firstLetter(given[0])}${firstLetter(sur[sur.length - 1])}`.toLocaleUpperCase('sv-SE')
}

/** The initials of everyone who signed, at most `max`, then "+n" for the rest. */
export function signersInitials(signers: Array<{ givenName: string; surname: string }>, max = 6): string {
  const all = signers.map((s) => bankIdInitials(s.givenName, s.surname)).filter(Boolean)
  const shown = all.slice(0, max).join(', ')
  return all.length > max ? `${shown} +${all.length - max}` : shown
}

/** The line in the bottom margin of every original page. */
export function stampLine(input: { initials: string; requestId: string; verifyUrl: string }): string {
  return `Signerat med BankID av ${input.initials} · ID ${shortSigningId(input.requestId)} · ${bareUrl(input.verifyUrl)}`
}

/** "Arcim Technology AB:s", "Anna Svenssons", "Kompass": the Swedish genitive of a name. */
export function swedishGenitive(name: string): string {
  const trimmed = name.trim()
  const last = trimmed.slice(-1)
  if (/[\p{Lu}\p{N}]/u.test(last)) return `${trimmed}:s`
  if (/[sxz]/i.test(last)) return trimmed
  return `${trimmed}s`
}

function BankIdSymbol({ size, color = INK }: { size: number; color?: string }) {
  return (
    <Svg viewBox={BANKID_SYMBOL_VIEWBOX} style={{ width: size, height: (size * 8.6) / 12.2 }}>
      {BANKID_SYMBOL_PATHS.map((d, i) => (
        <Path key={i} d={d} fill={color} />
      ))}
    </Svg>
  )
}

function BankIdMark({ size, color = INK }: { size: number; color?: string }) {
  return (
    <Svg viewBox={BANKID_VIEWBOX} style={{ width: size, height: size }}>
      {[...BANKID_SYMBOL_PATHS, ...BANKID_WORDMARK_PATHS].map((d, i) => (
        <Path key={i} d={d} fill={color} />
      ))}
    </Svg>
  )
}

// ---------------------------------------------------------------- the stamp

export interface StampStripsInput {
  text: string
  /** One strip per entry, each this many points wide (at least STAMP_MIN_WIDTH). */
  widths: number[]
  fonts: SigningPdfFonts
}

export function SigningStampStrips({ text, widths, fonts }: StampStripsInput) {
  return (
    <Document producer="Accounted" creator="Accounted">
      {widths.map((width, i) => {
        const inset = Math.min(54, Math.round(width * 0.09))
        return (
          <Page key={i} size={[width, STAMP_STRIP_HEIGHT]} style={{ paddingHorizontal: inset, flexDirection: 'row', alignItems: 'center', fontFamily: fonts.sans }}>
            <View style={{ flexGrow: 1, height: 0.6, backgroundColor: HAIRLINE }} />
            <View style={{ marginLeft: 9, marginRight: 6 }}>
              <BankIdSymbol size={9} />
            </View>
            <Text style={{ fontSize: 7, color: MUTED, marginRight: 9 }}>{text}</Text>
            <View style={{ flexGrow: 1, height: 0.6, backgroundColor: HAIRLINE }} />
          </Page>
        )
      })}
    </Document>
  )
}

// --------------------------------------------------------- the certificate

export interface SigningCertificateSigner {
  /** The name the sender typed for this signer. */
  name: string
  role: string | null
  bankidGivenName: string
  bankidSurname: string
  personnummerMasked: string | null
  signedAt: string
}

export interface SigningCertificateData {
  requestId: string
  title: string
  companyName: string
  orgNumber: string | null
  logo: SigningLogo | null
  /** Who sent it for signing (describeRequester). */
  requester: string
  createdAt: string
  completedAt: string
  fileName: string
  /** Pages in the original: the certificate's page numbers follow them. */
  originalPageCount: number
  sha256: string
  signers: SigningCertificateSigner[]
  /** An årsredovisning is dated by its first signature: that day, when the request signs one. */
  annualReportDate: string | null
  verifyUrl: string
  platformName: string
  /** The copy gets an electronic seal (./pades-seal.ts), with or without the original attached: the page says so. */
  sealed?: { originalAttached: boolean }
  fonts: SigningPdfFonts
}

function createStyles(fonts: SigningPdfFonts) {
  return StyleSheet.create({
    page: { paddingTop: 48, paddingHorizontal: 54, paddingBottom: 72, fontFamily: fonts.sans, fontSize: 9.75, color: INK },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    brand: { flexDirection: 'row', alignItems: 'center', maxWidth: 330 },
    tile: { width: 30, height: 30, borderRadius: 6, backgroundColor: TILE, alignItems: 'center', justifyContent: 'center' },
    tileText: { fontSize: 11, fontWeight: 700, color: BODY },
    companyName: { fontSize: 10.5, fontWeight: 700 },
    companyMeta: { fontSize: 9, color: MUTED, marginTop: 1.5 },
    docKind: { fontSize: 10.5, fontWeight: 700, textAlign: 'right' },
    docId: { fontSize: 8.5, fontFamily: fonts.mono, color: MUTED, marginTop: 2, textAlign: 'right' },
    titleBlock: { borderTopWidth: 0.75, borderTopColor: HAIRLINE, paddingTop: 6, marginBottom: 24 },
    title: { fontFamily: fonts.serif, fontSize: 22.5, lineHeight: 1.15, marginTop: 12 },
    status: { fontSize: 10.5, color: BODY, marginTop: 7.5 },
    label: { fontSize: 9, fontWeight: 700, color: MUTED, marginBottom: 9 },
    table: { borderWidth: 0.75, borderColor: HAIRLINE, borderRadius: 6, marginBottom: 24 },
    row: { flexDirection: 'row', paddingVertical: 13.5, paddingHorizontal: 15 },
    rowRule: { borderBottomWidth: 0.75, borderBottomColor: HAIRLINE },
    cell: { flex: 1, marginRight: 12 },
    cellLast: { flex: 1, alignItems: 'flex-end' },
    signerName: { fontSize: 11.25, fontWeight: 700 },
    muted: { color: MUTED, marginTop: 3 },
    bankid: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
    facts: { marginBottom: 24 },
    fact: { flexDirection: 'row', marginBottom: 7.5 },
    factLabel: { width: 120, marginRight: 12, color: MUTED },
    factValue: { flex: 1 },
    mono: { fontFamily: fonts.mono, fontSize: 8.5, paddingTop: 1 },
    legal: { fontSize: 9, lineHeight: 1.6, color: BODY, marginBottom: 24 },
    verify: { flexDirection: 'row', alignItems: 'center', borderWidth: 0.75, borderColor: HAIRLINE, borderRadius: 6, paddingVertical: 15, paddingHorizontal: 18, marginTop: 'auto' },
    seal: { width: 48, height: 48, borderRadius: 24, borderWidth: 1.1, borderColor: INK, alignItems: 'center', justifyContent: 'center', marginRight: 15 },
    verifyTitle: { fontSize: 10.5, fontWeight: 700 },
    verifyBody: { fontSize: 9.75, lineHeight: 1.5, color: BODY, marginTop: 3 },
    link: { color: BODY, textDecoration: 'none' },
    footer: { position: 'absolute', left: 54, right: 54, bottom: 30, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8.25, color: MUTED },
  })
}

export function SigningCertificatePDF(data: SigningCertificateData) {
  const styles = createStyles(data.fonts)
  const id = shortSigningId(data.requestId)
  const count = data.signers.length
  const logo = data.logo ? fitLogo(data.logo, { width: 120, height: 30 }) : null
  const squareLogo = logo ? logo.width / logo.height < 1.25 : false
  const verifyText = bareUrl(data.verifyUrl)
  const pages = data.originalPageCount

  return (
    <Document title={`Signeringsbevis: ${data.title}`} author={data.companyName} producer={data.platformName} creator={data.platformName}>
      <Page size="A4" style={styles.page}>
        <View fixed style={styles.header}>
          <View style={styles.brand}>
            {data.logo && logo ? (
              // A react-pdf Image is drawn into the PDF, not a DOM <img>: it takes no alt, and the company name is printed beside it.
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={data.logo.dataUrl} style={{ width: logo.width, height: logo.height, borderRadius: squareLogo ? 6 : 0, objectFit: 'contain' }} />
            ) : (
              <View style={styles.tile}>
                <Text style={styles.tileText}>{companyInitials(data.companyName)}</Text>
              </View>
            )}
            <View style={{ marginLeft: 9, flexShrink: 1 }}>
              <Text hyphenationCallback={noHyphens} style={styles.companyName}>
                {data.companyName}
              </Text>
              {data.orgNumber ? <Text style={styles.companyMeta}>Org.nr {formatOrgNumberDisplay(data.orgNumber)}</Text> : null}
            </View>
          </View>
          <View>
            <Text style={styles.docKind}>Signeringsbevis</Text>
            <Text style={styles.docId}>ID {id}</Text>
          </View>
        </View>

        <View style={styles.titleBlock}>
          <Text hyphenationCallback={noHyphens} style={styles.title}>
            {data.title}
          </Text>
          <Text hyphenationCallback={noHyphens} style={styles.status}>
            Signerat av alla ({count} av {count}). Slutfört {formatSigningMoment(data.completedAt)}.
          </Text>
        </View>

        <Text style={styles.label}>Underskrifter</Text>
        <View style={styles.table}>
          {data.signers.map((s, i) => (
            <View key={i} wrap={false} style={i < count - 1 ? [styles.row, styles.rowRule] : styles.row}>
              <View style={styles.cell}>
                <Text hyphenationCallback={noHyphens} style={styles.signerName}>
                  {s.name}
                </Text>
                <Text style={styles.muted}>{s.role || 'Undertecknare'}</Text>
              </View>
              <View style={styles.cell}>
                <Text hyphenationCallback={noHyphens}>{`${s.bankidGivenName} ${s.bankidSurname}`.trim().toLocaleUpperCase('sv-SE')}</Text>
                {s.personnummerMasked ? <Text style={styles.muted}>{s.personnummerMasked}</Text> : null}
              </View>
              <View style={styles.cellLast}>
                <Text>{formatSigningShortMoment(s.signedAt)}</Text>
                <View style={styles.bankid}>
                  <BankIdSymbol size={10.5} />
                  <Text style={{ color: MUTED, marginLeft: 4.5 }}>BankID</Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.label}>Dokumentet</Text>
        <View style={styles.facts}>
          <View wrap={false} style={styles.fact}>
            <Text style={styles.factLabel}>Fil</Text>
            <Text hyphenationCallback={noHyphens} style={styles.factValue}>
              {data.fileName}, {pages} {pages === 1 ? 'sida' : 'sidor'}
            </Text>
          </View>
          <View wrap={false} style={styles.fact}>
            <Text style={styles.factLabel}>Skickat för signering</Text>
            <Text hyphenationCallback={noHyphens} style={styles.factValue}>
              {formatSigningMoment(data.createdAt)} av {data.requester}
            </Text>
          </View>
          {data.annualReportDate ? (
            <View wrap={false} style={styles.fact}>
              <Text style={styles.factLabel}>Årsredovisningens datering</Text>
              <Text style={styles.factValue}>{data.annualReportDate} (dagen för den första underskriften)</Text>
            </View>
          ) : null}
          <View wrap={false} style={styles.fact}>
            <Text style={styles.factLabel}>Kontrollsumma (SHA-256)</Text>
            <Text style={[styles.factValue, styles.mono]}>{data.sha256}</Text>
          </View>
          <View wrap={false} style={styles.fact}>
            <Text style={styles.factLabel}>Signerings-ID</Text>
            <Text style={[styles.factValue, styles.mono]}>{data.requestId}</Text>
          </View>
        </View>

        <Text hyphenationCallback={noHyphens} style={styles.legal}>
          Varje underskrift är en BankID-signatur, en avancerad elektronisk underskrift enligt eIDAS, gjord över dokumentets kontrollsumma ovan. Signaturerna,
          originalfilen och BankID:s bekräftelse att certifikaten var giltiga finns i bevispaketet i {swedishGenitive(data.companyName)} arkiv.
          {data.sealed ? ' Den här filen är elektroniskt förseglad och tidsstämplad: en PDF-läsare visar om något har ändrats efter förseglingen.' : null}
          {data.sealed?.originalAttached ? ' Originalfilen ligger med som bilaga.' : null}
        </Text>

        <View wrap={false} style={styles.verify}>
          <View style={styles.seal}>
            <BankIdMark size={22.5} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.verifyTitle}>Kontrollera att kopian är äkta</Text>
            <Text hyphenationCallback={noHyphens} style={styles.verifyBody}>
              Ladda upp filen på{' '}
              <Link src={data.verifyUrl} style={styles.link}>
                {verifyText}
              </Link>
              . Filen lämnar inte datorn, bara dess kontrollsumma jämförs.
            </Text>
          </View>
        </View>

        <View fixed style={styles.footer}>
          <Text>Signeringsbevis · ID {id}</Text>
          <Text render={({ pageNumber, totalPages }) => `Sida ${pages + pageNumber} (${pages + totalPages}) · Signerat via ${data.platformName}`} />
        </View>
      </Page>
    </Document>
  )
}

export async function renderSigningCertificate(data: SigningCertificateData): Promise<Uint8Array> {
  const { renderToBuffer } = await import('@react-pdf/renderer')
  return new Uint8Array(await renderToBuffer(SigningCertificatePDF(data)))
}

export async function renderStampStrips(input: StampStripsInput): Promise<Uint8Array> {
  const { renderToBuffer } = await import('@react-pdf/renderer')
  return new Uint8Array(await renderToBuffer(SigningStampStrips(input)))
}
