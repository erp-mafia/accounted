/**
 * SIE File Parser
 *
 * Parses SIE (Standard Import Export) files, the Swedish standard format
 * for accounting data exchange. Supports SIE1-SIE4 formats.
 *
 * SIE4 is the most complete format with full transaction history.
 * SIE1 contains only year-end balances.
 *
 * Reference: https://sie.se/format/
 */

import type {
  SIEType,
  SIEEncoding,
  SIEHeader,
  SIEAccount,
  SIEBalance,
  SIEVoucher,
  SIETransactionLine,
  SIEDimension,
  SIEDimensionValue,
  ParsedSIEFile,
  ParseIssue,
  ParseIssueSeverity,
  ValidationResult,
} from './types'

// CP437 to UTF-8 mapping: full 0x80-0x9F range
// CP437 was the standard encoding for DOS/early Windows (used by SIE #FORMAT PC8)
const CP437_MAP: Record<number, string> = {
  // 0x80-0x8F
  0x80: 'Ç',  // Ç
  0x81: 'ü',  // ü
  0x82: 'é',  // é
  0x83: 'â',  // â
  0x84: 'ä',  // ä
  0x85: 'à',  // à
  0x86: 'å',  // å
  0x87: 'ç',  // ç
  0x88: 'ê',  // ê
  0x89: 'ë',  // ë
  0x8a: 'è',  // è
  0x8b: 'ï',  // ï
  0x8c: 'î',  // î
  0x8d: 'ì',  // ì
  0x8e: 'Ä',  // Ä
  0x8f: 'Å',  // Å
  // 0x90-0x9F
  0x90: 'É',  // É
  0x91: 'æ',  // æ
  0x92: 'Æ',  // Æ
  0x93: 'ô',  // ô
  0x94: 'ö',  // ö
  0x95: 'ò',  // ò
  0x96: 'û',  // û
  0x97: 'ù',  // ù
  0x98: 'ÿ',  // ÿ
  0x99: 'Ö',  // Ö
  0x9a: 'Ü',  // Ü
  0x9b: 'ø',  // ø (Norwegian)
  0x9c: '£',  // £
  0x9d: 'Ø',  // Ø (Norwegian)
  0x9e: '×',  // ×
  0x9f: 'ƒ',  // ƒ
}

// Windows-1252 bytes for Swedish characters (superset of ISO-8859-1)
// These bytes are NOT in the CP437 map, so they need separate detection.
const WIN1252_SWEDISH_BYTES = new Set([
  0xe5, // å
  0xe4, // ä
  0xf6, // ö
  0xc5, // Å
  0xc4, // Ä
  0xd6, // Ö
])

/**
 * Detect the encoding of a SIE file by looking for Swedish characters.
 *
 * Strategy:
 * 1. UTF-8 BOM → utf8
 * 2. `#FORMAT PC8` in raw bytes → cp437 (SIE standard header for CP437)
 * 3. Range-based discrimination: CP437 Swedish chars live in 0x80-0x9F,
 *    Windows-1252 Swedish chars live in 0xC0-0xFF. These ranges don't overlap,
 *    so presence in one range rules out the other.
 * 4. UTF-8 multi-byte sequences (0xC3 + continuation) are detected with proper
 *    skipping of continuation bytes to avoid false CP437 counts.
 *
 * Scans the entire buffer (not a sample): SIE files are capped at 50 MB and
 * Swedish characters often only appear deep in voucher descriptions, well past
 * any small header sample.
 */
export function detectEncoding(buffer: ArrayBuffer): SIEEncoding {
  const bytes = new Uint8Array(buffer)

  // Check for UTF-8 BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf8'
  }

  // NOTE: #FORMAT PC8 is NOT used for encoding detection.
  // Almost all SIE files declare #FORMAT PC8 regardless of actual encoding
  // (Fortnox, Bokio, Dooer etc. export UTF-8 with #FORMAT PC8).
  // Instead, we detect encoding from actual byte patterns.

  let cp437Count = 0   // Swedish chars in 0x80-0x9F (CP437 range)
  let utf8Count = 0     // Valid UTF-8 multi-byte Swedish sequences
  let win1252Count = 0  // Swedish chars in 0xC0-0xFF (Win-1252 range)

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]

    // Check for UTF-8 multi-byte sequences for Swedish chars FIRST
    // to avoid false CP437/Win-1252 counts from continuation bytes.
    // Ä = C3 84, Å = C3 85, Ö = C3 96, ä = C3 A4, å = C3 A5, ö = C3 B6, é = C3 A9
    if (byte === 0xc3 && i + 1 < bytes.length) {
      const nextByte = bytes[i + 1]
      if ([0x84, 0x85, 0x96, 0xa4, 0xa5, 0xb6, 0xa9].includes(nextByte)) {
        utf8Count++
        i++ // Skip continuation byte to avoid false CP437 count (e.g. 0x84 = ä in CP437)
        continue
      }
    }

    // Check for CP437 Swedish characters (0x80-0x9F range)
    if (CP437_MAP[byte]) {
      cp437Count++
    }

    // Check for Windows-1252 Swedish characters (0xC0-0xFF range)
    if (WIN1252_SWEDISH_BYTES.has(byte)) {
      win1252Count++
    }
  }

  if (utf8Count > cp437Count && utf8Count > win1252Count) return 'utf8'
  if (cp437Count > win1252Count) return 'cp437'
  if (win1252Count > 0) return 'windows1252'

  // Pure ASCII (no high bytes): UTF-8 is a superset of ASCII
  return 'utf8'
}

/**
 * Decode a buffer to string using the specified encoding.
 *
 * After decoding, validates the result for U+FFFD replacement characters
 * (which signal that the chosen encoding was wrong). When found, retries
 * with each alternate encoding and returns the first result without U+FFFD.
 * This guards against `detectEncoding` heuristic misses on files where
 * Swedish characters are rare or absent in the bytes the detector looked at.
 */
export function decodeBuffer(buffer: ArrayBuffer, encoding: SIEEncoding): string {
  const primary = decodeBufferRaw(buffer, encoding)
  if (!primary.includes('\uFFFD')) return primary

  const alternates: SIEEncoding[] = (['utf8', 'windows1252', 'cp437'] as const).filter(
    (e) => e !== encoding
  )
  for (const alt of alternates) {
    const candidate = decodeBufferRaw(buffer, alt)
    if (!candidate.includes('\uFFFD')) return candidate
  }
  return primary
}

function decodeBufferRaw(buffer: ArrayBuffer, encoding: SIEEncoding): string {
  if (encoding === 'utf8') {
    const decoder = new TextDecoder('utf-8')
    return decoder.decode(buffer)
  }

  if (encoding === 'windows1252') {
    const decoder = new TextDecoder('windows-1252')
    return decoder.decode(buffer)
  }

  // CP437 decoding
  const bytes = new Uint8Array(buffer)
  let result = ''

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]

    if (CP437_MAP[byte]) {
      result += CP437_MAP[byte]
    } else if (byte < 128) {
      result += String.fromCharCode(byte)
    } else {
      // For other high bytes, try to preserve as-is
      result += String.fromCharCode(byte)
    }
  }

  return result
}

/**
 * Parse a date from SIE format (YYYYMMDD) into a Date object.
 * Used for voucher dates where Date arithmetic is needed.
 */
function parseSIEDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.length !== 8) {
    return null
  }

  const year = parseInt(dateStr.substring(0, 4), 10)
  const month = parseInt(dateStr.substring(4, 6), 10) - 1
  const day = parseInt(dateStr.substring(6, 8), 10)

  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    return null
  }

  const date = new Date(year, month, day)

  // Reject invalid dates that auto-roll (e.g. Feb 30 → Mar 2)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null
  }

  return date
}

/**
 * Parse a date from SIE format (YYYYMMDD) into an ISO date string "YYYY-MM-DD".
 * Used for fiscal year dates and generated dates to avoid timezone issues
 * during JSON serialization (Date objects shift when crossing UTC boundaries).
 */
function parseSIEDateString(dateStr: string): string | null {
  if (!dateStr || dateStr.length !== 8) {
    return null
  }

  const year = dateStr.substring(0, 4)
  const month = dateStr.substring(4, 6)
  const day = dateStr.substring(6, 8)

  const y = parseInt(year, 10)
  const m = parseInt(month, 10)
  const d = parseInt(day, 10)

  if (isNaN(y) || isNaN(m) || isNaN(d)) {
    return null
  }

  // Validate by round-tripping through Date (rejects Feb 30, etc.)
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null
  }

  return `${year}-${month}-${day}`
}

/**
 * Parse a quoted string field from SIE
 * Handles: "value" or value
 */
function parseStringField(field: string): string {
  if (!field) return ''

  // Remove surrounding quotes if present
  if (field.startsWith('"') && field.endsWith('"')) {
    return field.slice(1, -1).replace(/\\"/g, '"')
  }

  return field
}

/**
 * Parse a numeric field from SIE
 */
function parseNumberField(field: string): number {
  if (!field) return 0
  // Strip quotes and use dot as decimal separator
  const cleaned = parseStringField(field)
  return parseFloat(cleaned.replace(',', '.')) || 0
}

/**
 * Split a SIE line into fields, respecting quoted strings and braced object lists
 */
function splitSIELine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  let braceDepth = 0
  let escaped = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      current += char
      continue
    }

    if (char === '"' && braceDepth === 0) {
      inQuotes = !inQuotes
      current += char
      continue
    }

    // Track brace depth for object lists like {1 "ProjectA"}
    if (char === '{' && !inQuotes) {
      braceDepth++
      current += char
      continue
    }

    if (char === '}' && !inQuotes) {
      braceDepth = Math.max(0, braceDepth - 1)
      current += char
      continue
    }

    // SIE 4 spec allows either space or tab as field separator (programs like
    // Bollbok export tab-separated lines). Quoted strings and brace-bounded
    // dimension lists preserve any interior whitespace via the guards above.
    if ((char === ' ' || char === '\t') && !inQuotes && braceDepth === 0) {
      if (current) {
        fields.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    fields.push(current)
  }

  return fields
}

/**
 * Parse a #TRANS object list (`{1 "KS01" 6 "P001"}`) into an SIE dim
 * number → object code map. The list arrives as ONE field thanks to the
 * brace-aware splitter; the inner content is itself space-separated with
 * SIE quoting, so it re-runs through splitSIELine. Returns undefined for an
 * empty list ({}), malformed pairs are skipped with a warning issue.
 */
function parseObjectList(
  raw: string,
  issues: ParseIssue[],
  lineNum: number
): Record<string, string> | undefined {
  const inner = raw.replace(/^\{/, '').replace(/\}$/, '').trim()
  if (!inner) return undefined

  const parts = splitSIELine(inner)
  if (parts.length % 2 !== 0) {
    addIssue(issues, 'warning', lineNum, `Objektlista med udda antal fält ignoreras delvis: ${raw}`, 'TRANS')
  }

  const dims: Record<string, string> = {}
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const dimNoRaw = parseStringField(parts[i])
    const code = parseStringField(parts[i + 1]).trim()
    const dimNo = parseInt(dimNoRaw, 10)
    if (isNaN(dimNo) || dimNo < 1 || !code) {
      addIssue(issues, 'warning', lineNum, `Ogiltigt objektpar i objektlista: ${dimNoRaw} ${code}`, 'TRANS')
      continue
    }
    // Canonical numeric key ('01' → '1'): matches normalizeLineDimensions.
    dims[String(dimNo)] = code
  }
  return Object.keys(dims).length > 0 ? dims : undefined
}

/**
 * Add an issue to the issues list
 */
function addIssue(
  issues: ParseIssue[],
  severity: ParseIssueSeverity,
  line: number,
  message: string,
  tag?: string
): void {
  issues.push({ severity, line, message, tag })
}

/**
 * Parse a SIE file content string
 */
export function parseSIEFile(content: string): ParsedSIEFile {
  const lines = content.split(/\r?\n/)
  const issues: ParseIssue[] = []

  // Initialize header with defaults
  // Per SIE spec: if #SIETYP is absent, assume type 1 (closing balances only)
  const header: SIEHeader = {
    sieType: 1,
    flagga: null,
    program: null,
    programVersion: null,
    generatedDate: null,
    format: null,
    companyName: null,
    orgNumber: null,
    address: null,
    fiscalYears: [],
    currency: 'SEK',
    kontoPlanType: null,
  }

  const accounts: SIEAccount[] = []
  const openingBalances: SIEBalance[] = []
  const closingBalances: SIEBalance[] = []
  const resultBalances: SIEBalance[] = []
  const vouchers: SIEVoucher[] = []
  const dimensions: SIEDimension[] = []
  const dimensionValues: SIEDimensionValue[] = []
  let objectBalanceCount = 0

  // Track current voucher being parsed (inside #VER { ... })
  let currentVoucher: SIEVoucher | null = null

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    const line = lines[i].trim()

    // Skip empty lines
    if (!line) continue

    // Handle voucher block end
    if (line === '}') {
      if (currentVoucher) {
        // Validate voucher balance
        const total = currentVoucher.lines.reduce((sum, l) => sum + l.amount, 0)
        if (Math.abs(total) > 0.01) {
          addIssue(
            issues,
            'error',
            lineNum,
            `Verifikation ${currentVoucher.series}${currentVoucher.number} balanserar inte (differens: ${total.toFixed(2)} kr)`,
            'VER'
          )
        }
        vouchers.push(currentVoucher)
        currentVoucher = null
      }
      continue
    }

    // Handle voucher block start
    if (line === '{') {
      continue
    }

    // Skip lines that don't start with #
    if (!line.startsWith('#')) {
      continue
    }

    // Parse the tag and fields
    const fields = splitSIELine(line)
    const tag = fields[0].substring(1).toUpperCase()

    try {
      switch (tag) {
        case 'FLAGGA':
          header.flagga = parseInt(fields[1], 10) || 0
          break

        case 'FORMAT':
          header.format = parseStringField(fields[1])
          break

        case 'SIETYP':
          header.sieType = parseInt(fields[1], 10) as SIEType
          if (![1, 2, 3, 4].includes(header.sieType)) {
            addIssue(issues, 'warning', lineNum, `Okänd SIE-typ: ${fields[1]}. Filen tolkas som SIE4.`, tag)
            header.sieType = 4
          }
          break

        case 'PROGRAM':
          header.program = parseStringField(fields[1])
          header.programVersion = parseStringField(fields[2])
          break

        case 'GEN':
          if (fields[1]) {
            header.generatedDate = parseSIEDateString(fields[1])
          }
          break

        case 'ORGNR':
          header.orgNumber = parseStringField(fields[1])
          break

        case 'FNAMN':
          header.companyName = parseStringField(fields[1])
          break

        case 'ADRESS':
          header.address = [fields[1], fields[2], fields[3], fields[4]]
            .filter(Boolean)
            .map(parseStringField)
            .join(', ')
          break

        case 'VALUTA':
          header.currency = parseStringField(fields[1]) || 'SEK'
          break

        case 'KPTYP':
          header.kontoPlanType = parseStringField(fields[1])
          break

        case 'RAR': {
          // #RAR yearIndex start end
          const yearIndex = parseInt(fields[1], 10)
          const start = parseSIEDateString(fields[2])
          const end = parseSIEDateString(fields[3])

          if (start && end) {
            header.fiscalYears.push({ yearIndex, start, end })
          } else {
            addIssue(issues, 'warning', lineNum, 'Invalid fiscal year dates', tag)
          }
          break
        }

        case 'KONTO': {
          // #KONTO number "name"
          const number = fields[1]
          const name = parseStringField(fields[2])

          if (number && name) {
            accounts.push({ number, name })
          } else {
            addIssue(issues, 'warning', lineNum, 'Invalid account definition', tag)
          }
          break
        }

        case 'SRU': {
          // #SRU accountNumber sruCode
          const accountNum = fields[1]
          const sruCode = fields[2]
          const account = accounts.find((a) => a.number === accountNum)
          if (account) {
            account.sruCode = sruCode
          }
          break
        }

        case 'KTYP': {
          // #KTYP accountNumber type
          // Bollbok 2025 writes the type unquoted (T), Bollbok 2026 writes it
          // quoted ("T"). parseStringField strips the quotes in both cases.
          const accountNum = fields[1]
          const accountType = parseStringField(fields[2])
          const account = accounts.find((a) => a.number === accountNum)
          if (account) {
            account.accountType = accountType
          }
          break
        }

        case 'IB': {
          // #IB yearIndex accountNumber amount [quantity]
          const yearIndex = parseInt(fields[1], 10)
          const account = fields[2]
          const amountStr = fields[3]

          if (!amountStr || amountStr.trim() === '') {
            addIssue(issues, 'warning', lineNum, 'Belopp saknas i #IB: raden hoppas över', tag)
            break
          }

          const amount = parseNumberField(amountStr)
          const quantity = fields[4] ? parseNumberField(fields[4]) : undefined

          if (account) {
            openingBalances.push({ yearIndex, account, amount, quantity })
          }
          break
        }

        case 'UB': {
          // #UB yearIndex accountNumber amount [quantity]
          const yearIndex = parseInt(fields[1], 10)
          const account = fields[2]
          const amountStr = fields[3]

          if (!amountStr || amountStr.trim() === '') {
            addIssue(issues, 'warning', lineNum, 'Belopp saknas i #UB: raden hoppas över', tag)
            break
          }

          const amount = parseNumberField(amountStr)
          const quantity = fields[4] ? parseNumberField(fields[4]) : undefined

          if (account) {
            closingBalances.push({ yearIndex, account, amount, quantity })
          }
          break
        }

        case 'RES': {
          // #RES yearIndex accountNumber amount [quantity]
          const yearIndex = parseInt(fields[1], 10)
          const account = fields[2]
          const amountStr = fields[3]

          if (!amountStr || amountStr.trim() === '') {
            addIssue(issues, 'warning', lineNum, 'Belopp saknas i #RES: raden hoppas över', tag)
            break
          }

          const amount = parseNumberField(amountStr)
          const quantity = fields[4] ? parseNumberField(fields[4]) : undefined

          if (account) {
            resultBalances.push({ yearIndex, account, amount, quantity })
          }
          break
        }

        case 'VER': {
          // #VER series number date "description" [regdate] [signature]
          // Some programs quote all fields, so strip quotes from number/date too
          const series = parseStringField(fields[1])
          const number = parseInt(parseStringField(fields[2]), 10)
          const date = parseSIEDate(parseStringField(fields[3]))
          const description = parseStringField(fields[4])

          if (!isNaN(number) && date) {
            currentVoucher = {
              series,
              number,
              date,
              description: description || '',
              lines: [],
            }

            // Optional registration date and signature
            if (fields[5]) {
              currentVoucher.registrationDate = parseSIEDate(parseStringField(fields[5])) || undefined
            }
            if (fields[6]) {
              currentVoucher.signature = parseStringField(fields[6])
            }
          } else {
            addIssue(issues, 'error', lineNum, 'Ogiltig verifikationsdefinition: nummer eller datum kunde inte tolkas', tag)
          }
          break
        }

        case 'TRANS':
        case 'RTRANS':
        case 'BTRANS': {
          // #TRANS = final transaction lines (the current state of the voucher)
          // #RTRANS = supplementary/corrected transaction (must be followed by identical #TRANS for backward compat)
          // #BTRANS = removed/cancelled transaction (programs not understanding BTRANS simply ignore it)
          //
          // When a voucher has been corrected, Fortnox/Visma emit all three types.
          // Only #TRANS represents the final voucher state; #RTRANS and #BTRANS are
          // supplementary history. We skip RTRANS/BTRANS to avoid double-counting
          // which would make balanced vouchers appear unbalanced.
          if (!currentVoucher) {
            addIssue(issues, 'error', lineNum, `#${tag} utanför verifikationsblock (#VER): filen kan vara skadad`, tag)
            break
          }

          // Skip RTRANS/BTRANS: they are correction audit trail, not final state
          if (tag === 'RTRANS' || tag === 'BTRANS') {
            break
          }

          // Parse account and capture the object list (in braces)
          let fieldIndex = 1
          const account = parseStringField(fields[fieldIndex++])

          // Object list (single field thanks to brace-aware splitting):
          // dimension tags like {1 "KS01" 6 "P001"}. Parsed onto the line so
          // import is lossless (dimensions plan PR5).
          let objectListRaw: string | null = null
          if (fields[fieldIndex]?.startsWith('{')) {
            objectListRaw = fields[fieldIndex]
            fieldIndex++
          }

          const transAmountStr = fields[fieldIndex]
          if (!transAmountStr || transAmountStr.trim() === '') {
            addIssue(issues, 'warning', lineNum, `Belopp saknas i #${tag}: raden hoppas över`, tag)
            break
          }

          const amount = parseNumberField(fields[fieldIndex++])

          const transLine: SIETransactionLine = {
            account,
            amount,
          }

          if (objectListRaw) {
            const dims = parseObjectList(objectListRaw, issues, lineNum)
            if (dims) {
              transLine.dimensions = dims
            }
          }

          // Optional fields
          if (fields[fieldIndex]) {
            transLine.date = parseSIEDate(parseStringField(fields[fieldIndex++])) || undefined
          }
          if (fields[fieldIndex]) {
            transLine.description = parseStringField(fields[fieldIndex++])
          }
          if (fields[fieldIndex]) {
            transLine.quantity = parseNumberField(fields[fieldIndex++])
          }
          if (fields[fieldIndex]) {
            transLine.signature = parseStringField(fields[fieldIndex++])
          }

          currentVoucher.lines.push(transLine)
          break
        }

        case 'DIM': {
          // #DIM dimNo "name"
          const dimNo = parseInt(parseStringField(fields[1]), 10)
          const name = parseStringField(fields[2])
          if (!isNaN(dimNo) && dimNo >= 1) {
            dimensions.push({ sieDimNo: dimNo, name: name || '' })
          } else {
            addIssue(issues, 'warning', lineNum, 'Ogiltig dimensionsdefinition: numret kunde inte tolkas', tag)
          }
          break
        }

        case 'UNDERDIM': {
          // #UNDERDIM dimNo "name" parentDimNo
          const dimNo = parseInt(parseStringField(fields[1]), 10)
          const name = parseStringField(fields[2])
          const parent = parseInt(parseStringField(fields[3]), 10)
          if (!isNaN(dimNo) && dimNo >= 1 && !isNaN(parent) && parent >= 1) {
            dimensions.push({ sieDimNo: dimNo, name: name || '', parentSieDimNo: parent })
          } else {
            addIssue(issues, 'warning', lineNum, 'Ogiltig underdimension: nummer eller överdimension kunde inte tolkas', tag)
          }
          break
        }

        case 'OBJEKT': {
          // #OBJEKT dimNo "code" "name"
          const dimNo = parseInt(parseStringField(fields[1]), 10)
          const code = parseStringField(fields[2]).trim()
          const name = parseStringField(fields[3])
          if (!isNaN(dimNo) && dimNo >= 1 && code) {
            dimensionValues.push({ sieDimNo: dimNo, code, name: name || code })
          } else {
            addIssue(issues, 'warning', lineNum, 'Ogiltigt objekt: dimension eller kod kunde inte tolkas', tag)
          }
          break
        }

        default:
          // Unknown tag - add info issue for notable ones. OIB/OUB (per-object
          // opening/closing balances) are counted and surfaced as ONE info
          // issue below: dimension reporting is P&L-only in v1, so
          // object-level balance records have no consumer yet, but dropping
          // them must never be silent (#866 review).
          if (tag === 'OIB' || tag === 'OUB') {
            objectBalanceCount++
          } else if (!['KSUMMA', 'BKOD', 'TAXAR', 'OMFATTN', 'PBUDGET', 'PSALDO'].includes(tag)) {
            addIssue(issues, 'info', lineNum, `Okänd tagg: #${tag}, ignoreras`, tag)
          }
      }
    } catch (error) {
      addIssue(
        issues,
        'error',
        lineNum,
        `Fel vid tolkning av #${tag}: ${error instanceof Error ? error.message : 'Okänt fel'}`,
        tag
      )
    }
  }

  // Collect accounts referenced in balances and vouchers but missing from #KONTO
  const definedAccountNumbers = new Set(accounts.map((a) => a.number))
  const referencedAccounts = new Set<string>()

  for (const balance of [...openingBalances, ...closingBalances, ...resultBalances]) {
    if (balance.account && !definedAccountNumbers.has(balance.account)) {
      referencedAccounts.add(balance.account)
    }
  }
  for (const voucher of vouchers) {
    for (const line of voucher.lines) {
      if (line.account && !definedAccountNumbers.has(line.account)) {
        referencedAccounts.add(line.account)
      }
    }
  }

  for (const accountNumber of referencedAccounts) {
    accounts.push({ number: accountNumber, name: '' })
    addIssue(issues, 'info', 0, `Account ${accountNumber} added from transaction data (not in #KONTO)`)
  }

  // Silent-failure diagnostic: if the raw input declares #IB / #VER records
  // but parsing produced none, surface a warning instead of letting the file
  // look empty. Historically a tab-separator or encoding mismatch could swallow
  // all balance/voucher records without any visible signal.
  //
  // Suppressed when per-record 'error' issues already exist for the same tag:
  // in that case the parser already pinpointed the root cause (e.g. malformed
  // verification definition), so the generic "check separator/encoding" hint
  // would be misleading.
  const rawIBCount = lines.filter((l) => /^\s*#IB\b/.test(l)).length
  const rawVERCount = lines.filter((l) => /^\s*#VER\b/.test(l)).length
  const hasIBError = issues.some((i) => i.severity === 'error' && i.tag === 'IB')
  const hasVERError = issues.some((i) => i.severity === 'error' && i.tag === 'VER')
  if (rawIBCount > 0 && openingBalances.length === 0 && !hasIBError) {
    addIssue(
      issues,
      'warning',
      0,
      `${rawIBCount} #IB-rader hittades men inga ingående saldon kunde tolkas: kontrollera fältavskiljare och teckenkodning`,
      'IB'
    )
  }
  if (rawVERCount > 0 && vouchers.length === 0 && !hasVERError) {
    addIssue(
      issues,
      'warning',
      0,
      `${rawVERCount} #VER-rader hittades men inga verifikationer kunde tolkas: kontrollera fältavskiljare och teckenkodning`,
      'VER'
    )
  }

  // Dimension visibility: the preview step renders parse issues, so these
  // make dimension handling explicit BEFORE the user executes the import.
  if (objectBalanceCount > 0) {
    addIssue(
      issues,
      'info',
      0,
      `${objectBalanceCount} objektbalansrader (#OIB/#OUB) hoppades över: balanser per objekt stöds inte ännu`,
      'OIB'
    )
  }
  const taggedLineCount = vouchers.reduce(
    (sum, v) => sum + v.lines.filter((l) => l.dimensions).length,
    0
  )
  if (dimensions.length > 0 || dimensionValues.length > 0 || taggedLineCount > 0) {
    addIssue(
      issues,
      'info',
      0,
      `Filen innehåller dimensionsdata (kostnadsställen/projekt): ${taggedLineCount} taggade rader, dimensionerna följer med importen`,
      'DIM'
    )
  }

  // Calculate statistics
  const currentFiscalYear = header.fiscalYears.find((fy) => fy.yearIndex === 0)
  const totalTransactionLines = vouchers.reduce((sum, v) => sum + v.lines.length, 0)

  return {
    header,
    accounts,
    openingBalances,
    closingBalances,
    resultBalances,
    vouchers,
    dimensions,
    dimensionValues,
    issues,
    stats: {
      totalAccounts: accounts.length,
      totalVouchers: vouchers.length,
      totalTransactionLines,
      fiscalYearStart: currentFiscalYear?.start || null,
      fiscalYearEnd: currentFiscalYear?.end || null,
    },
  }
}

/**
 * Wording that identifies a voucher as the year's opening balance
 * (ingående balans). Shared between the parser's OB-voucher candidate
 * detection below and the importer's isLikelyOpeningBalance tagging
 * (lib/import/sie-import.ts) so the two checks can never drift apart.
 */
export const OPENING_BALANCE_DESCRIPTION_RE = /ing[åa]ende balans|ing[åa]ende saldo|opening balance/i

/**
 * Vouchers mentioning share capital are never treated as opening balances:
 * a share-capital deposit dated on the FY start is a real bank movement.
 */
export const SHARE_CAPITAL_DESCRIPTION_RE = /aktiekapital/i

/**
 * Determine if an account is balance sheet (class 1-2) or P&L (class 3-8)
 */
export function isBalanceSheetAccount(accountNumber: string): boolean {
  const firstDigit = parseInt(accountNumber.charAt(0), 10)
  return firstDigit >= 1 && firstDigit <= 2
}

/**
 * Format a Date to "YYYY-MM-DD" using LOCAL components.
 * parseSIEDate() builds local-time Dates, so toISOString() would shift the
 * day across the UTC boundary in non-UTC timezones: never use it here.
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * True when the file contains a voucher that looks like the year's opening
 * balance: dated on the fiscal-year start, only balance-sheet accounts,
 * IB wording in the description and no share-capital mention.
 *
 * Raw-file mirror of the importer's isLikelyOpeningBalance check
 * (lib/import/sie-import.ts), but deliberately MORE eager: it runs on
 * source account numbers with no knowledge of account mappings, so a
 * candidate containing an unmapped line still counts here even though the
 * importer would later skip that voucher as unmapped. In that residual case
 * no IB is created at all: the user falls back to the manual
 * "Märk som ingående balans" action in Bankavstämning.
 */
export function hasOpeningBalanceVoucherCandidate(parsed: ParsedSIEFile): boolean {
  const fyStart = parsed.stats.fiscalYearStart
  if (!fyStart) return false

  return parsed.vouchers.some(
    (v) =>
      v.lines.length > 0 &&
      formatLocalDate(v.date) === fyStart.slice(0, 10) &&
      v.lines.every((l) => isBalanceSheetAccount(l.account)) &&
      OPENING_BALANCE_DESCRIPTION_RE.test(v.description || '') &&
      !SHARE_CAPITAL_DESCRIPTION_RE.test(v.description || '')
  )
}

/**
 * Resolve the opening balances the import should actually book (issue #675).
 *
 * Some systems export no #IB 0 records at all: the current year's IB exists
 * only implicitly via the SIE continuity invariant IB(year 0) = UB(year -1).
 * Every IB consumer goes through this helper so the precedence below is the
 * single source of truth:
 *
 *   1. Explicit #IB 0 records: trusted as-is, never merged with #UB -1.
 *   2. An opening-balance #VER candidate: the voucher itself serves as IB
 *      during voucher import (tagged source_type 'opening_balance');
 *      deriving from #UB -1 as well would double-count every
 *      balance-sheet account.
 *   3. #UB -1 records, re-labeled to yearIndex 0 and filtered to
 *      balance-sheet accounts (result accounts must always open at zero).
 *   4. Nothing: the file genuinely carries no opening balances.
 */
export function getEffectiveOpeningBalances(parsed: ParsedSIEFile): {
  balances: SIEBalance[]
  derivedFromPriorYearUB: boolean
} {
  const explicit = parsed.openingBalances.filter((b) => b.yearIndex === 0)
  if (explicit.length > 0) {
    return { balances: explicit, derivedFromPriorYearUB: false }
  }

  if (hasOpeningBalanceVoucherCandidate(parsed)) {
    return { balances: [], derivedFromPriorYearUB: false }
  }

  const derived = parsed.closingBalances
    .filter((b) => b.yearIndex === -1 && isBalanceSheetAccount(b.account))
    .map((b) => ({ ...b, yearIndex: 0 }))

  return { balances: derived, derivedFromPriorYearUB: derived.length > 0 }
}

/**
 * Validate a parsed SIE file
 */
export function validateSIEFile(parsed: ParsedSIEFile): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Check #FLAGGA for already-imported files
  if (parsed.header.flagga === 1) {
    warnings.push('Filen är markerad som redan importerad (#FLAGGA 1). Kontrollera att den inte redan har importerats i ett annat system.')
  }

  // Check for SIE type
  if (!parsed.header.sieType) {
    errors.push('SIE-typ saknas (#SIETYP). Filen kanske inte är en giltig SIE-fil: kontrollera att du exporterat i rätt format.')
  }

  // Check for company info
  if (!parsed.header.companyName) {
    warnings.push('Företagsnamn saknas (#FNAMN): vanligtvis ofarligt men bör kontrolleras')
  }

  // Check for fiscal year
  if (parsed.header.fiscalYears.length === 0) {
    errors.push('Inget räkenskapsår definierat (#RAR). Filen saknar information om vilken period bokföringen gäller: kontrollera att exporten inkluderar räkenskapsårsdata.')
  }

  // Check for accounts
  if (parsed.accounts.length === 0) {
    warnings.push('Inga konton hittades (#KONTO). Om filen bara innehåller saldon (SIE1) är detta normalt.')
  }

  // Warn if non-BAS kontoplan declared: mapping logic assumes BAS number ranges
  if (parsed.header.kontoPlanType) {
    const planType = parsed.header.kontoPlanType.toUpperCase()
    const isBAS = planType.startsWith('BAS') || planType === 'EUBAS' || planType === 'EU-BAS'
    if (!isBAS) {
      warnings.push(
        `Kontoplanstyp "${parsed.header.kontoPlanType}" är inte BAS-baserad. Automatisk kontomappning kan bli felaktig: granska alla mappningar manuellt i nästa steg.`
      )
    }
  }

  // Check for unbalanced vouchers
  const unbalancedVouchers: string[] = []
  for (const voucher of parsed.vouchers) {
    const total = voucher.lines.reduce((sum, l) => sum + l.amount, 0)
    if (Math.abs(total) > 0.01) {
      unbalancedVouchers.push(
        `${voucher.series}${voucher.number} (${voucher.date.toISOString().split('T')[0]}, diff: ${total.toFixed(2)} kr)`
      )
    }
  }
  if (unbalancedVouchers.length > 0) {
    const shown = unbalancedVouchers.slice(0, 5)
    const remaining = unbalancedVouchers.length - shown.length
    errors.push(
      `${unbalancedVouchers.length} verifikation(er) balanserar inte (debet ≠ kredit): ${shown.join(', ')}${remaining > 0 ? ` och ${remaining} till` : ''}. Kontrollera att exporten från källsystemet är komplett.`
    )
  }

  // Check for accounts referenced but not defined
  const definedAccounts = new Set(parsed.accounts.map((a) => a.number))
  const referencedAccounts = new Set<string>()

  for (const balance of [...parsed.openingBalances, ...parsed.closingBalances, ...parsed.resultBalances]) {
    referencedAccounts.add(balance.account)
  }

  for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) {
      referencedAccounts.add(line.account)
    }
  }

  const undefinedAccounts: string[] = []
  for (const account of referencedAccounts) {
    if (!definedAccounts.has(account)) {
      undefinedAccounts.push(account)
    }
  }
  if (undefinedAccounts.length > 0) {
    const shown = undefinedAccounts.slice(0, 10)
    const remaining = undefinedAccounts.length - shown.length
    warnings.push(
      `${undefinedAccounts.length} konto(n) används i verifikationer men definieras inte i #KONTO: ${shown.join(', ')}${remaining > 0 ? ` och ${remaining} till` : ''}. Kontona skapas automatiskt vid import.`
    )
  }

  // Check opening balance is balanced (for balance sheet accounts).
  // Uses the effective set so files without #IB 0 (where IB is derived from
  // #UB -1, issue #675) still get the 2099-adjustment heads-up.
  const effectiveIB = getEffectiveOpeningBalances(parsed)

  if (effectiveIB.derivedFromPriorYearUB) {
    warnings.push(
      'Filen saknar ingående balanser (#IB) för aktuellt räkenskapsår: de härleds från föregående års utgående balans (#UB -1) vid import.'
    )
  }

  const ibTotal = effectiveIB.balances.reduce((sum, b) => sum + b.amount, 0)

  if (Math.abs(ibTotal) > 0.01) {
    warnings.push(`Ingående balanser balanserar inte (differens: ${ibTotal.toFixed(2)} kr). En automatisk justeringspost mot konto 2099 skapas vid import.`)
  }

  // Completed fiscal year whose vouchers leave a residual on P&L accounts:
  // the year's result was never transferred to equity (omföring saknas).
  // Later years derive their opening balance from balance-sheet accounts
  // only, so the residual becomes a permanent balansräkning differens for
  // every subsequent year. SIE amounts are debit-positive, so the class 3-8
  // sum is the un-transferred result with flipped sign.
  const currentFiscalYear = parsed.header.fiscalYears.find((fy) => fy.yearIndex === 0)
  if (currentFiscalYear?.end && currentFiscalYear.end < formatLocalDate(new Date())) {
    const plResidual = parsed.vouchers.reduce(
      (sum, voucher) =>
        sum +
        voucher.lines.reduce(
          (lineSum, line) =>
            lineSum + (isBalanceSheetAccount(line.account) ? 0 : line.amount),
          0
        ),
      0
    )
    if (Math.abs(plResidual) > 0.01) {
      warnings.push(
        `Räkenskapsåret är avslutat men filen saknar omföring av årets resultat (${Math.abs(plResidual).toFixed(2)} kr ligger kvar på resultatkonton). ` +
        `Om senare räkenskapsår importeras kommer balansräkningen att visa en differens på ${Math.abs(plResidual).toFixed(2)} kr tills omföringen bokförs.`
      )
    }
  }

  // Add parse issues as errors/warnings
  for (const issue of parsed.issues) {
    if (issue.severity === 'error') {
      errors.push(`Line ${issue.line}: ${issue.message}`)
    } else if (issue.severity === 'warning') {
      warnings.push(`Line ${issue.line}: ${issue.message}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Calculate a hash of the file content for duplicate detection
 */
export async function calculateFileHash(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
