import { describe, it, expect } from 'vitest'
import { parseSIEFile, validateSIEFile, detectEncoding, decodeBuffer } from '../sie-parser'

// --- SIE content fixtures ---

const MINIMAL_SIE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#PROGRAM "TestProg" "1.0"',
  '#FORMAT PC8',
  '#GEN 20240101',
  '#FNAMN "Test AB"',
  '#ORGNR 5566778899',
  '#VALUTA SEK',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 3001 "Försäljning varor 25%"',
].join('\n')

const SIE_WITH_BALANCES = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Balans AB"',
  '#ORGNR 1234567890',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2440 "Leverantörsskulder"',
  '#IB 0 1510 50000.00',
  '#IB 0 1930 100000.00',
  '#IB 0 2440 -150000.00',
  '#UB 0 1510 75000.00',
  '#UB 0 1930 125000.00',
  '#UB 0 2440 -200000.00',
].join('\n')

const SIE_WITH_VOUCHERS = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Voucher AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 3001 "Försäljning"',
  '#KONTO 2611 "Utgående moms 25%"',
  '#VER A 1 20240115 "Faktura 1001"',
  '{',
  '#TRANS 1510 {} 12500.00',
  '#TRANS 3001 {} -10000.00',
  '#TRANS 2611 {} -2500.00',
  '}',
  '#VER A 2 20240220 "Inbetalning faktura 1001"',
  '{',
  '#TRANS 1930 {} 12500.00',
  '#TRANS 1510 {} -12500.00',
  '}',
].join('\n')

const SIE_TYPE_1 = [
  '#FLAGGA 0',
  '#SIETYP 1',
  '#FNAMN "SIE1 AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#IB 0 1510 50000.00',
  '#UB 0 1510 75000.00',
].join('\n')

const SIE_WITH_SRU = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "SRU AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#SRU 1510 7251',
  '#KONTO 3001 "Försäljning"',
  '#SRU 3001 7410',
].join('\n')

const SIE_UNBALANCED_VOUCHER = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Obalanserad AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 3001 "Försäljning"',
  '#VER A 1 20240115 "Obalanserad verifikation"',
  '{',
  '#TRANS 1510 {} 10000.00',
  '#TRANS 3001 {} -5000.00',
  '}',
].join('\n')

const SIE_WITH_OBJECT_LIST = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Objects AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 5010 "Lokalhyra"',
  '#KONTO 1930 "Företagskonto"',
  '#VER A 1 20240115 "Hyra januari"',
  '{',
  '#TRANS 5010 {1 "Kontor"} 15000.00',
  '#TRANS 1930 {} -15000.00',
  '}',
].join('\n')

// SIE file where all VER/TRANS fields are quoted (common from some accounting programs)
const SIE_QUOTED_FIELDS = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Quoted AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 3001 "Försäljning"',
  '#KONTO 2611 "Utgående moms 25%"',
  '#VER "A" "1" "20240115" "Faktura 1001"',
  '{',
  '#TRANS "1510" {} "12500.00"',
  '#TRANS "3001" {} "-10000.00"',
  '#TRANS "2611" {} "-2500.00"',
  '}',
].join('\n')

// SIE file with empty series (some programs use "" for series)
const SIE_EMPTY_SERIES = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Empty Series AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 3001 "Försäljning"',
  '#VER "" 1 20240115 "No series"',
  '{',
  '#TRANS 1930 {} 10000.00',
  '#TRANS 3001 {} -10000.00',
  '}',
].join('\n')

// SIE file with { on same line as #VER
const SIE_BRACE_ON_VER_LINE = [
  '#FLAGGA 0',
  '#SIETYP 4',
  '#FNAMN "Brace AB"',
  '#RAR 0 20240101 20241231',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 3001 "Försäljning"',
  '#VER A 1 20240115 "Inline brace" {',
  '#TRANS 1930 {} 10000.00',
  '#TRANS 3001 {} -10000.00',
  '}',
].join('\n')

// --- parseSIEFile tests ---

describe('parseSIEFile', () => {
  describe('header parsing', () => {
    it('parses SIE type', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.sieType).toBe(4)
    })

    it('parses company name from #FNAMN', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.companyName).toBe('Test AB')
    })

    it('parses org number from #ORGNR', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.orgNumber).toBe('5566778899')
    })

    it('parses fiscal year from #RAR', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.fiscalYears).toHaveLength(1)
      expect(result.header.fiscalYears[0].yearIndex).toBe(0)
      expect(result.header.fiscalYears[0].start).toBe('2024-01-01')
      expect(result.header.fiscalYears[0].end).toBe('2024-12-31')
    })

    it('parses currency from #VALUTA', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.currency).toBe('SEK')
    })

    it('defaults currency to SEK when not specified', () => {
      const content = '#FLAGGA 0\n#SIETYP 4\n#FNAMN "Test"\n#RAR 0 20240101 20241231'
      const result = parseSIEFile(content)
      expect(result.header.currency).toBe('SEK')
    })

    it('parses program info', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.program).toBe('TestProg')
      expect(result.header.programVersion).toBe('1.0')
    })

    it('parses generated date', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.header.generatedDate).toBe('2024-01-01')
    })

    it('parses SIE type 1', () => {
      const result = parseSIEFile(SIE_TYPE_1)
      expect(result.header.sieType).toBe(1)
    })
  })

  describe('account parsing', () => {
    it('parses #KONTO with number and name', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.accounts).toHaveLength(3)
      expect(result.accounts[0]).toEqual({ number: '1510', name: 'Kundfordringar' })
      expect(result.accounts[1]).toEqual({ number: '1930', name: 'Företagskonto' })
    })

    it('parses #SRU codes onto accounts', () => {
      const result = parseSIEFile(SIE_WITH_SRU)
      const account1510 = result.accounts.find((a) => a.number === '1510')
      expect(account1510?.sruCode).toBe('7251')
      const account3001 = result.accounts.find((a) => a.number === '3001')
      expect(account3001?.sruCode).toBe('7410')
    })
  })

  describe('balance parsing', () => {
    it('parses opening balances (#IB) with positive amounts', () => {
      const result = parseSIEFile(SIE_WITH_BALANCES)
      const ib1510 = result.openingBalances.find((b) => b.account === '1510')
      expect(ib1510?.amount).toBe(50000)
      expect(ib1510?.yearIndex).toBe(0)
    })

    it('parses opening balances (#IB) with negative amounts', () => {
      const result = parseSIEFile(SIE_WITH_BALANCES)
      const ib2440 = result.openingBalances.find((b) => b.account === '2440')
      expect(ib2440?.amount).toBe(-150000)
    })

    it('parses closing balances (#UB)', () => {
      const result = parseSIEFile(SIE_WITH_BALANCES)
      expect(result.closingBalances).toHaveLength(3)
      const ub1930 = result.closingBalances.find((b) => b.account === '1930')
      expect(ub1930?.amount).toBe(125000)
    })
  })

  describe('voucher parsing', () => {
    it('parses #VER with series, number, date, description', () => {
      const result = parseSIEFile(SIE_WITH_VOUCHERS)
      expect(result.vouchers).toHaveLength(2)

      const v1 = result.vouchers[0]
      expect(v1.series).toBe('A')
      expect(v1.number).toBe(1)
      expect(v1.date).toEqual(new Date(2024, 0, 15))
      expect(v1.description).toBe('Faktura 1001')
    })

    it('parses #TRANS lines within a voucher', () => {
      const result = parseSIEFile(SIE_WITH_VOUCHERS)
      const v1 = result.vouchers[0]

      expect(v1.lines).toHaveLength(3)
      expect(v1.lines[0]).toMatchObject({ account: '1510', amount: 12500 })
      expect(v1.lines[1]).toMatchObject({ account: '3001', amount: -10000 })
      expect(v1.lines[2]).toMatchObject({ account: '2611', amount: -2500 })
    })

    it('handles object lists in braces', () => {
      const result = parseSIEFile(SIE_WITH_OBJECT_LIST)
      expect(result.vouchers).toHaveLength(1)

      const v = result.vouchers[0]
      expect(v.lines).toHaveLength(2)
      expect(v.lines[0]).toMatchObject({ account: '5010', amount: 15000 })
      expect(v.lines[1]).toMatchObject({ account: '1930', amount: -15000 })
    })

    it('parses quoted VER fields (series, number, date)', () => {
      const result = parseSIEFile(SIE_QUOTED_FIELDS)
      expect(result.vouchers).toHaveLength(1)

      const v = result.vouchers[0]
      expect(v.series).toBe('A')
      expect(v.number).toBe(1)
      expect(v.date).toEqual(new Date(2024, 0, 15))
      expect(v.description).toBe('Faktura 1001')
      expect(v.lines).toHaveLength(3)
      expect(v.lines[0]).toMatchObject({ account: '1510', amount: 12500 })
      expect(v.lines[1]).toMatchObject({ account: '3001', amount: -10000 })
      expect(v.lines[2]).toMatchObject({ account: '2611', amount: -2500 })

      const errors = result.issues.filter((i) => i.severity === 'error')
      expect(errors).toHaveLength(0)
    })

    it('allows empty series in VER', () => {
      const result = parseSIEFile(SIE_EMPTY_SERIES)
      expect(result.vouchers).toHaveLength(1)

      const v = result.vouchers[0]
      expect(v.series).toBe('')
      expect(v.number).toBe(1)
      expect(v.lines).toHaveLength(2)

      const errors = result.issues.filter((i) => i.severity === 'error')
      expect(errors).toHaveLength(0)
    })

    it('handles { on same line as #VER', () => {
      const result = parseSIEFile(SIE_BRACE_ON_VER_LINE)
      expect(result.vouchers).toHaveLength(1)

      const v = result.vouchers[0]
      expect(v.series).toBe('A')
      expect(v.number).toBe(1)
      expect(v.lines).toHaveLength(2)

      const errors = result.issues.filter((i) => i.severity === 'error')
      expect(errors).toHaveLength(0)
    })

    it('detects unbalanced vouchers as errors', () => {
      const result = parseSIEFile(SIE_UNBALANCED_VOUCHER)
      expect(result.vouchers).toHaveLength(1)

      const errors = result.issues.filter((i) => i.severity === 'error')
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(errors.some((e) => e.message.includes('not balanced'))).toBe(true)
    })
  })

  describe('statistics', () => {
    it('calculates account count', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.stats.totalAccounts).toBe(3)
    })

    it('calculates voucher count', () => {
      const result = parseSIEFile(SIE_WITH_VOUCHERS)
      expect(result.stats.totalVouchers).toBe(2)
    })

    it('calculates transaction line count', () => {
      const result = parseSIEFile(SIE_WITH_VOUCHERS)
      // Voucher 1: 3 lines, Voucher 2: 2 lines
      expect(result.stats.totalTransactionLines).toBe(5)
    })

    it('sets fiscal year start/end from RAR 0', () => {
      const result = parseSIEFile(MINIMAL_SIE)
      expect(result.stats.fiscalYearStart).toBe('2024-01-01')
      expect(result.stats.fiscalYearEnd).toBe('2024-12-31')
    })

    it('returns null fiscal year dates when no RAR', () => {
      const content = '#FLAGGA 0\n#SIETYP 4\n#FNAMN "Test"'
      const result = parseSIEFile(content)
      expect(result.stats.fiscalYearStart).toBeNull()
      expect(result.stats.fiscalYearEnd).toBeNull()
    })
  })
})

// --- validateSIEFile tests ---

describe('validateSIEFile', () => {
  it('returns valid for a complete SIE file', () => {
    const parsed = parseSIEFile(SIE_WITH_VOUCHERS)
    const validation = validateSIEFile(parsed)

    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)
  })

  it('adds error for unbalanced vouchers', () => {
    const parsed = parseSIEFile(SIE_UNBALANCED_VOUCHER)
    const validation = validateSIEFile(parsed)

    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.includes('not balanced'))).toBe(true)
  })

  it('no longer warns about accounts referenced in #IB since parser auto-adds them', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#IB 0 9999 50000.00',
    ].join('\n')

    const parsed = parseSIEFile(content)
    // Parser now auto-adds 9999 to accounts list from #IB data
    expect(parsed.accounts.map((a) => a.number)).toContain('9999')

    const validation = validateSIEFile(parsed)
    // No warning since account was auto-added by the parser
    expect(validation.warnings.some((w) => w.includes('9999') && w.includes('not defined'))).toBe(false)
  })

  it('adds error for missing #RAR', () => {
    const content = '#FLAGGA 0\n#SIETYP 4\n#FNAMN "Test"\n#KONTO 1510 "Kund"'
    const parsed = parseSIEFile(content)
    const validation = validateSIEFile(parsed)

    expect(validation.valid).toBe(false)
    expect(validation.errors.some((e) => e.includes('fiscal year') || e.includes('#RAR'))).toBe(true)
  })

  it('adds warning for unbalanced opening balances', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#IB 0 1510 50000.00',
    ].join('\n')

    const parsed = parseSIEFile(content)
    const validation = validateSIEFile(parsed)

    expect(validation.warnings.some((w) => w.includes('Opening balances not balanced'))).toBe(true)
  })

  it('passes with balanced opening balances', () => {
    const parsed = parseSIEFile(SIE_WITH_BALANCES)
    const validation = validateSIEFile(parsed)

    // IB: 50000 + 100000 + (-150000) = 0 → balanced
    const ibWarning = validation.warnings.find((w) => w.includes('Opening balances not balanced'))
    expect(ibWarning).toBeUndefined()
  })
})

// --- Fix 2: Windows-1252 encoding detection and decoding ---

describe('detectEncoding — #FORMAT PC8 detection', () => {
  it('returns cp437 when #FORMAT PC8 is present in the first 500 bytes', () => {
    const text = '#FLAGGA 0\n#FORMAT PC8\n#SIETYP 4\n'
    const encoder = new TextEncoder()
    const buf = encoder.encode(text)
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('cp437')
  })

  it('returns cp437 even when Win-1252 bytes follow #FORMAT PC8', () => {
    // #FORMAT PC8 header should take priority over any byte analysis
    const prefix = new TextEncoder().encode('#FORMAT PC8\n#FNAMN F')
    const buf = new Uint8Array(prefix.length + 3)
    buf.set(prefix)
    buf[prefix.length] = 0xf6     // ö in Win-1252
    buf[prefix.length + 1] = 0xe4 // ä in Win-1252
    buf[prefix.length + 2] = 0xe5 // å in Win-1252
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('cp437')
  })
})

describe('detectEncoding — range-based discrimination', () => {
  it('detects CP437 when bytes are in 0x80-0x9F range only', () => {
    // 0x84=ä, 0x86=å, 0x94=ö in CP437 — all in 0x80-0x9F
    const buf = new Uint8Array([0x23, 0x84, 0x86, 0x94, 0x84, 0x86])
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('cp437')
  })

  it('detects Win-1252 when bytes are in 0xC0-0xFF range only', () => {
    // 0xE4=ä, 0xE5=å, 0xF6=ö in Win-1252 — all in 0xC0-0xFF
    const buf = new Uint8Array([0x23, 0xe4, 0xe5, 0xf6, 0xe4, 0xe5])
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('windows1252')
  })

  it('does not double-count UTF-8 continuation bytes as CP437', () => {
    // UTF-8: ä = C3 A4, å = C3 A5, ö = C3 B6
    // Without skipping, 0xA4/0xA5/0xB6 are NOT in CP437 map so no false count,
    // but 0x84/0x85 ARE in CP437 map — test that C3 84 (Ä in UTF-8) is not
    // counted as CP437 0x84 (ä)
    const buf = new Uint8Array([
      0x23, // #
      0xc3, 0x84, // Ä in UTF-8
      0xc3, 0x85, // Å in UTF-8
      0xc3, 0x96, // Ö in UTF-8
      0xc3, 0xa4, // ä in UTF-8
      0xc3, 0xa5, // å in UTF-8
    ])
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('utf8')
  })
})
describe('detectEncoding — Windows-1252', () => {
  it('detects Windows-1252 when Swedish chars use Win-1252 byte values', () => {
    // Build a buffer with Windows-1252 encoded Swedish text: "#FNAMN Företag"
    // å=0xE5, ä=0xE4, ö=0xF6 in Windows-1252 (NOT in CP437 map)
    const text = '#FNAMN F'
    const encoder = new TextEncoder()
    const prefix = encoder.encode(text)
    // Add ö (0xF6) r (0x72) e (0x65) t (0x74) a (0x61) g (0x67)
    const buf = new Uint8Array(prefix.length + 6)
    buf.set(prefix)
    buf[prefix.length] = 0xf6     // ö in Windows-1252
    buf[prefix.length + 1] = 0x72 // r
    buf[prefix.length + 2] = 0x65 // e
    buf[prefix.length + 3] = 0x74 // t
    buf[prefix.length + 4] = 0x61 // a
    buf[prefix.length + 5] = 0x67 // g
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('windows1252')
  })

  it('detects UTF-8 BOM even when Windows-1252 bytes are present', () => {
    const buf = new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0xe5]) // BOM + # + å-win1252
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('utf8')
  })

  it('detects CP437 when CP437-specific bytes are present', () => {
    // 0x86 = å in CP437 (not in Win-1252 Swedish set)
    const buf = new Uint8Array([0x23, 0x86, 0x86, 0x86])
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('cp437')
  })

  it('detects UTF-8 multi-byte Swedish chars', () => {
    // å in UTF-8 = C3 A5, ä = C3 A4
    const buf = new Uint8Array([0x23, 0xc3, 0xa5, 0xc3, 0xa4])
    const encoding = detectEncoding(buf.buffer)
    expect(encoding).toBe('utf8')
  })
})

describe('decodeBuffer — Windows-1252', () => {
  it('decodes Windows-1252 Swedish characters correctly', () => {
    // "åäö" in Windows-1252 = [0xE5, 0xE4, 0xF6]
    const buf = new Uint8Array([0xe5, 0xe4, 0xf6])
    const result = decodeBuffer(buf.buffer, 'windows1252')
    expect(result).toBe('åäö')
  })

  it('decodes Windows-1252 uppercase Swedish characters correctly', () => {
    // "ÅÄÖ" in Windows-1252 = [0xC5, 0xC4, 0xD6]
    const buf = new Uint8Array([0xc5, 0xc4, 0xd6])
    const result = decodeBuffer(buf.buffer, 'windows1252')
    expect(result).toBe('ÅÄÖ')
  })

  it('decodes CP437 Swedish characters correctly', () => {
    // å in CP437 = 0x86, ä = 0x84, ö = 0x94
    const buf = new Uint8Array([0x86, 0x84, 0x94])
    const result = decodeBuffer(buf.buffer, 'cp437')
    expect(result).toBe('åäö')
  })
})

// --- Fix 3: Invalid date rejection ---

describe('parseSIEFile — invalid date handling', () => {
  it('rejects Feb 30 (auto-rolled dates) in #RAR', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20240230',  // Feb 30 is invalid
    ].join('\n')

    const result = parseSIEFile(content)
    // RAR with invalid end date should produce a warning and not add the fiscal year
    expect(result.header.fiscalYears).toHaveLength(0)
    expect(result.issues.some((i) => i.message.includes('Invalid fiscal year dates'))).toBe(true)
  })

  it('rejects Apr 31 in #VER date', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1930 "Företagskonto"',
      '#KONTO 3001 "Försäljning"',
      '#VER A 1 20240431 "Invalid date"',  // Apr 31 is invalid
      '{',
      '#TRANS 1930 {} 1000.00',
      '#TRANS 3001 {} -1000.00',
      '}',
    ].join('\n')

    const result = parseSIEFile(content)
    // Voucher should not be created because date is invalid
    expect(result.vouchers).toHaveLength(0)
    expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('Invalid voucher definition'))).toBe(true)
  })

  it('accepts valid leap year date Feb 29', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1930 "Konto"',
      '#KONTO 3001 "Konto"',
      '#VER A 1 20240229 "Leap year"',
      '{',
      '#TRANS 1930 {} 1000.00',
      '#TRANS 3001 {} -1000.00',
      '}',
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.vouchers).toHaveLength(1)
    expect(result.vouchers[0].date).toEqual(new Date(2024, 1, 29))
  })

  it('rejects Feb 29 in non-leap year', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20230101 20231231',
      '#KONTO 1930 "Konto"',
      '#VER A 1 20230229 "Not a leap year"',
      '{',
      '#TRANS 1930 {} 1000.00',
      '}',
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.vouchers).toHaveLength(0)
    expect(result.issues.some((i) => i.message.includes('Invalid voucher definition'))).toBe(true)
  })
})

// --- Fix 4: Missing amount handling ---

describe('parseSIEFile — missing amount handling', () => {
  it('skips #IB with missing amount and adds warning', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#IB 0 1510',  // No amount field
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.openingBalances).toHaveLength(0)
    expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Missing amount in #IB'))).toBe(true)
  })

  it('skips #UB with missing amount and adds warning', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#UB 0 1510',  // No amount field
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.closingBalances).toHaveLength(0)
    expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Missing amount in #UB'))).toBe(true)
  })

  it('skips #RES with missing amount and adds warning', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 3001 "Försäljning"',
      '#RES 0 3001',  // No amount field
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.resultBalances).toHaveLength(0)
    expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Missing amount in #RES'))).toBe(true)
  })

  it('skips #TRANS with missing amount and adds warning', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1930 "Företagskonto"',
      '#VER A 1 20240115 "Test"',
      '{',
      '#TRANS 1930 {}',  // No amount field
      '}',
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.vouchers).toHaveLength(1)
    expect(result.vouchers[0].lines).toHaveLength(0)
    expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('Missing amount in #TRANS'))).toBe(true)
  })

  it('still parses valid #IB lines alongside missing-amount ones', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#KONTO 1930 "Företagskonto"',
      '#IB 0 1510',           // Missing → skipped
      '#IB 0 1930 100000.00', // Valid → kept
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.openingBalances).toHaveLength(1)
    expect(result.openingBalances[0].account).toBe('1930')
    expect(result.openingBalances[0].amount).toBe(100000)
  })
})

// --- Fix B4: Account collection from transaction data ---

describe('parseSIEFile — account collection from transaction data', () => {
  it('adds accounts from #TRANS that are missing from #KONTO', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      // 3001 is NOT defined in #KONTO but used in #TRANS
      '#VER A 1 20240115 "Test"',
      '{',
      '#TRANS 1510 {} 10000.00',
      '#TRANS 3001 {} -10000.00',
      '}',
    ].join('\n')

    const result = parseSIEFile(content)
    // Should have both 1510 (from #KONTO) and 3001 (from #TRANS)
    expect(result.accounts.map((a) => a.number)).toContain('1510')
    expect(result.accounts.map((a) => a.number)).toContain('3001')
    // The auto-added account should have empty name
    const added = result.accounts.find((a) => a.number === '3001')
    expect(added?.name).toBe('')
  })

  it('adds accounts from #IB that are missing from #KONTO', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#IB 0 1510 50000.00',
      '#IB 0 2440 -50000.00',  // 2440 not in #KONTO
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.accounts.map((a) => a.number)).toContain('2440')
  })

  it('does not duplicate accounts already in #KONTO', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#KONTO 3001 "Försäljning"',
      '#VER A 1 20240115 "Test"',
      '{',
      '#TRANS 1510 {} 10000.00',
      '#TRANS 3001 {} -10000.00',
      '}',
    ].join('\n')

    const result = parseSIEFile(content)
    const count1510 = result.accounts.filter((a) => a.number === '1510').length
    expect(count1510).toBe(1)
  })

  it('adds accounts from #UB and #RES that are missing from #KONTO', () => {
    const content = [
      '#FLAGGA 0',
      '#SIETYP 4',
      '#FNAMN "Test"',
      '#RAR 0 20240101 20241231',
      '#KONTO 1510 "Kundfordringar"',
      '#UB 0 1930 100000.00',  // 1930 not in #KONTO
      '#RES 0 3001 -50000.00', // 3001 not in #KONTO
    ].join('\n')

    const result = parseSIEFile(content)
    expect(result.accounts.map((a) => a.number)).toContain('1930')
    expect(result.accounts.map((a) => a.number)).toContain('3001')
  })
})
