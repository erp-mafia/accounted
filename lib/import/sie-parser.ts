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
  ParsedSIEFile,
  ParseIssue,
  ParseIssueSeverity,
  ValidationResult,
} from './types'

// CP437 to UTF-8 mapping — full 0x80-0x9F range
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
 */
export function detectEncoding(buffer: ArrayBuffer): SIEEncoding {
  const bytes = new Uint8Array(buffer)

  // Check for UTF-8 BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf8'
  }

  // Check for #FORMAT PC8 in the first 500 bytes (ASCII-safe, works regardless of encoding)
  const headerSize = Math.min(bytes.length, 500)
  const FORMAT_PC8 = [0x23, 0x46, 0x4f, 0x52, 0x4d, 0x41, 0x54, 0x20, 0x50, 0x43, 0x38]
  for (let i = 0; i <= headerSize - FORMAT_PC8.length; i++) {
    let match = true
    for (let j = 0; j < FORMAT_PC8.length; j++) {
      if (bytes[i + j] !== FORMAT_PC8[j]) {
        match = false
        break
      }
    }
    if (match) {
      return 'cp437'
    }
  }

  // Scan sample for encoding-specific byte ranges
  const sampleSize = Math.min(bytes.length, 2000)
  let cp437Count = 0   // Swedish chars in 0x80-0x9F (CP437 range)
  let utf8Count = 0     // Valid UTF-8 multi-byte Swedish sequences
  let win1252Count = 0  // Swedish chars in 0xC0-0xFF (Win-1252 range)

  for (let i = 0; i < sampleSize; i++) {
    const byte = bytes[i]

    // Check for CP437 Swedish characters
    if (CP437_MAP[byte]) {
      cp437Count++
    }

    // Check for Windows-1252 Swedish characters
    if (WIN1252_SWEDISH_BYTES.has(byte)) {
      win1252Count++
    }

    // Check for UTF-8 multi-byte sequences for Swedish chars
    // Ä = C3 84, Å = C3 85, Ö = C3 96, ä = C3 A4, å = C3 A5, ö = C3 B6
    if (byte === 0xc3 && i + 1 < sampleSize) {
      const nextByte = bytes[i + 1]
      if ([0x84, 0x85, 0x96, 0xa4, 0xa5, 0xb6].includes(nextByte)) {
        utf8Count++
        i++ // Skip continuation byte to avoid false CP437 count (e.g. 0x84 = ä in CP437)
        continue
      }
    }

  }

  if (utf8Count > cp437Count && utf8Count > win1252Count) return 'utf8'
  if (cp437Count > win1252Count) return 'cp437'
  if (win1252Count > 0) return 'windows1252'
  return 'cp437'
}

/**
 * Decode a buffer to string using the specified encoding
 */
export function decodeBuffer(buffer: ArrayBuffer, encoding: SIEEncoding): string {
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

    if (char === ' ' && !inQuotes && braceDepth === 0) {
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
  const header: SIEHeader = {
    sieType: 4,
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
            `Voucher ${currentVoucher.series}${currentVoucher.number} is not balanced (diff: ${total.toFixed(2)})`,
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
          // Flag for file handling - ignore
          break

        case 'FORMAT':
          header.format = parseStringField(fields[1])
          break

        case 'SIETYP':
          header.sieType = parseInt(fields[1], 10) as SIEType
          if (![1, 2, 3, 4].includes(header.sieType)) {
            addIssue(issues, 'warning', lineNum, `Unknown SIE type: ${fields[1]}`, tag)
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
          const accountNum = fields[1]
          const accountType = fields[2]
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
            addIssue(issues, 'warning', lineNum, 'Missing amount in #IB, skipping line', tag)
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
            addIssue(issues, 'warning', lineNum, 'Missing amount in #UB, skipping line', tag)
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
            addIssue(issues, 'warning', lineNum, 'Missing amount in #RES, skipping line', tag)
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
            addIssue(issues, 'error', lineNum, 'Invalid voucher definition', tag)
          }
          break
        }

        case 'TRANS':
        case 'RTRANS':
        case 'BTRANS': {
          // #TRANS = final transaction lines (the current state of the voucher)
          // #RTRANS = removed lines (correction audit trail — original lines that were undone)
          // #BTRANS = added lines (correction audit trail — new lines that replaced removed ones)
          //
          // When a voucher has been corrected, Fortnox/Visma emit all three types.
          // Only #TRANS represents the final voucher state; #RTRANS and #BTRANS are
          // supplementary history. We skip RTRANS/BTRANS to avoid double-counting
          // which would make balanced vouchers appear unbalanced.
          if (!currentVoucher) {
            addIssue(issues, 'error', lineNum, `${tag} outside of VER block`, tag)
            break
          }

          // Skip RTRANS/BTRANS — they are correction audit trail, not final state
          if (tag === 'RTRANS' || tag === 'BTRANS') {
            break
          }

          // Parse account and skip object list (in braces)
          let fieldIndex = 1
          const account = parseStringField(fields[fieldIndex++])

          // Skip object list if present (now a single field thanks to brace-aware splitting)
          if (fields[fieldIndex]?.startsWith('{')) {
            fieldIndex++
          }

          const transAmountStr = fields[fieldIndex]
          if (!transAmountStr || transAmountStr.trim() === '') {
            addIssue(issues, 'warning', lineNum, `Missing amount in #${tag}, skipping line`, tag)
            break
          }

          const amount = parseNumberField(fields[fieldIndex++])

          const transLine: SIETransactionLine = {
            account,
            amount,
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

        default:
          // Unknown tag - add info issue for notable ones
          if (!['KSUMMA', 'BKOD', 'TAXAR', 'OMFATTN', 'DIM', 'OBJEKT', 'OIB', 'OUB', 'PBUDGET', 'PSALDO'].includes(tag)) {
            addIssue(issues, 'info', lineNum, `Unknown tag: #${tag}`, tag)
          }
      }
    } catch (error) {
      addIssue(
        issues,
        'error',
        lineNum,
        `Error parsing ${tag}: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
 * Validate a parsed SIE file
 */
export function validateSIEFile(parsed: ParsedSIEFile): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Check for SIE type
  if (!parsed.header.sieType) {
    errors.push('Missing SIE type (#SIETYP)')
  }

  // Check for company info
  if (!parsed.header.companyName) {
    warnings.push('No company name found (#FNAMN)')
  }

  // Check for fiscal year
  if (parsed.header.fiscalYears.length === 0) {
    errors.push('No fiscal year defined (#RAR)')
  }

  // Check for accounts
  if (parsed.accounts.length === 0) {
    warnings.push('No accounts found (#KONTO)')
  }

  // Warn if non-BAS kontoplan declared — mapping logic assumes BAS number ranges
  if (parsed.header.kontoPlanType) {
    const planType = parsed.header.kontoPlanType.toUpperCase()
    const isBAS = planType.startsWith('BAS') || planType === 'EUBAS' || planType === 'EU-BAS'
    if (!isBAS) {
      warnings.push(
        `Kontoplanstyp "${parsed.header.kontoPlanType}" är inte BAS-baserad. Alla kontomappningar bör granskas manuellt.`
      )
    }
  }

  // Check for unbalanced vouchers
  for (const voucher of parsed.vouchers) {
    const total = voucher.lines.reduce((sum, l) => sum + l.amount, 0)
    if (Math.abs(total) > 0.01) {
      errors.push(
        `Voucher ${voucher.series}${voucher.number} on ${voucher.date.toISOString().split('T')[0]} is not balanced (diff: ${total.toFixed(2)})`
      )
    }
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

  for (const account of referencedAccounts) {
    if (!definedAccounts.has(account)) {
      warnings.push(`Account ${account} referenced but not defined in #KONTO`)
    }
  }

  // Check opening balance is balanced (for balance sheet accounts)
  const ibTotal = parsed.openingBalances
    .filter((b) => b.yearIndex === 0)
    .reduce((sum, b) => sum + b.amount, 0)

  if (Math.abs(ibTotal) > 0.01) {
    warnings.push(`Opening balances not balanced (diff: ${ibTotal.toFixed(2)})`)
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
