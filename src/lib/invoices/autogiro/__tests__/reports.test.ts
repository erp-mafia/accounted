import { describe, expect, it } from 'vitest'
import {
  detectAutogiroReport,
  parseAutogiroReport,
  parseInternetBankMandates,
  parseMandateNotice,
  parseMandateRegister,
  parsePaymentSpecification,
  parseRejectedPayments,
} from '../reports'
import { sealAutogiroFile } from '../seal'
import { CUSTOMER_NUMBER, PAYEE_BG, PAYEE_BG_DIGITS, PAYER_BG_DIGITS, file, record, reportOpening, zero } from './autogiro-fixture'

const BG10 = zero(PAYEE_BG_DIGITS, 10)

/** A Betalningsspecifikation TK82/TK32: payment day, payer, öre, reference and status code. */
function payment(tk: '82' | '32', date: string, payer: string, ore: number, reference: string, status: string): string {
  return record(tk, [
    [3, date],
    [11, '0'],
    [16, zero(payer, 16)],
    [32, zero(ore, 12)],
    [44, BG10],
    [54, reference],
    [80, status],
  ])
}

/** A TK15, TK16 or TK17: account, day, serial, öre and count. */
function batch(tk: '15' | '16' | '17', date: string, serial: string, ore: number, count: number): string {
  return record(tk, [
    [3, zero('50001234567', 35)],
    [38, date],
    [46, serial],
    [51, zero(ore, 18)],
    [72, zero(count, 8)],
  ])
}

function specificationEnd(counts: { tk15: number; tk82: number; tk16?: number; tk32?: number; tk17?: number; tk77?: number }): string {
  return record('09', [
    [3, '20261030'],
    [11, '9900'],
    [15, zero(counts.tk15, 6)],
    [21, zero(counts.tk82, 12)],
    [33, zero(counts.tk16 ?? 0, 6)],
    [39, zero(counts.tk32 ?? 0, 12)],
    [51, zero(counts.tk17 ?? 0, 6)],
    [57, zero(counts.tk77 ?? 0, 12)],
  ])
}

const SPECIFICATION = file([
  reportOpening('BET. SPEC & STOPP TK'),
  batch('15', '20261030', '00012', 150050 + 49900, 2),
  payment('82', '20261030', '1001', 150050, '1001234', '0'),
  payment('82', '20261030', '1002', 49900, '1002232', '0'),
  payment('82', '20261030', '1003', 30000, '1003230', '1'),
  batch('17', '20261030', '00013', 49900, 1),
  record('77', [
    [3, '20260930'],
    [11, '0'],
    [16, zero('1002', 16)],
    [32, zero(49900, 12)],
    [44, BG10],
    [54, '0999236'],
    [70, '20261029'],
    [78, '02'],
  ]),
  specificationEnd({ tk15: 1, tk82: 2, tk17: 1, tk77: 1 }),
])

describe('parsePaymentSpecification', () => {
  it('reads each deposit with its completed and stopped debits, and refunds with their origin', () => {
    const result = parsePaymentSpecification(SPECIFICATION)

    expect(result.issues).toEqual([])
    expect(result.sealed).toBe(false)
    expect(result.sections).toHaveLength(1)
    const [section] = result.sections
    expect(section).toMatchObject({ customer_number: CUSTOMER_NUMBER, bankgiro: PAYEE_BG, written_on: '2026-10-30' })
    expect(section!.deposits).toHaveLength(1)
    const [deposit] = section!.deposits
    expect(deposit).toMatchObject({ date: '2026-10-30', serial: '00012', bank_account: '50001234567', amount: 1999.5, balanced: true })
    expect(deposit!.debits.map((d) => [d.payer_number, d.amount, d.reference, d.status, d.completed])).toEqual([
      ['1001', 1500.5, '1001234', '0', true],
      ['1002', 499, '1002232', '0', true],
      ['1003', 300, '1003230', '1', false],
    ])
    expect(section!.refunds).toEqual([
      {
        line: 7,
        date: '2026-10-29',
        amount: 499,
        payer_number: '1002',
        original_date: '2026-09-30',
        original_amount: 499,
        original_reference: '0999236',
        reason_code: '02',
      },
    ])
  })

  it('marks a deposit whose completed debits do not add up as unbalanced', () => {
    const result = parsePaymentSpecification(SPECIFICATION.replace(zero(150050 + 49900, 18), zero(150050 + 49901, 18)))

    expect(result.sections[0]!.deposits[0]!.balanced).toBe(false)
    expect(result.issues).toEqual([expect.objectContaining({ line: 2, severity: 'error', message: expect.stringContaining('Insättningen stämmer inte') })])
  })

  it('refuses a debit outside a deposit and warns when the end record counts differently', () => {
    const result = parsePaymentSpecification(
      file([
        reportOpening('BET. SPEC & STOPP TK'),
        payment('82', '20261030', '1001', 100, '1', '0'),
        batch('15', '20261030', '00001', 100, 1),
        payment('82', '20261030', '1001', 100, '1', '0'),
        specificationEnd({ tk15: 2, tk82: 1 }),
      ]),
    )

    expect(result.issues.map((i) => [i.line, i.severity])).toEqual([
      [2, 'error'],
      [5, 'warning'],
    ])
    expect(result.sections[0]!.deposits[0]!.balanced).toBe(true)
  })

  it('reads a file Bankgirot sealed the same way and says so', () => {
    const sealed = sealAutogiroFile(SPECIFICATION, '1234567890ABCDEF1234567890ABCDEF', '2026-10-30')
    const result = parsePaymentSpecification(sealed)

    expect(result.sealed).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.sections[0]!.deposits[0]!.amount).toBe(1999.5)
  })

  it('reports a file that ends without its end record', () => {
    const result = parsePaymentSpecification(file([reportOpening('BET. SPEC & STOPP TK'), batch('15', '20261030', '00001', 100, 1), payment('82', '20261030', '1', 100, '1', '0')]))
    expect(result.sections[0]!.deposits).toHaveLength(1)
    expect(result.issues).toEqual([expect.objectContaining({ line: 0, message: 'Filen slutar utan slutpost (TK09).' })])
  })
})

describe('parseMandateNotice', () => {
  const notice = (records: string[], stated: number) =>
    file([reportOpening('AG-MEDAVI'), ...records, record('09', [[3, '20261030'], [11, '9900'], [15, zero(stated, 7)]])])
  const tk73 = (payer: string, account: string, identity: string, info: string, comment: string) =>
    record('73', [
      [3, BG10],
      [13, zero(payer, 16)],
      [29, account],
      [45, identity],
      [62, info],
      [64, comment],
      [66, '20261029'],
    ])

  it('reads new and cancelled mandates with account, identity and the manual text for each code', () => {
    const result = parseMandateNotice(
      notice(
        [
          tk73('1001', '5000000001234567', '190001010000', '04', '32'),
          tk73('1002', ' '.repeat(16), ' '.repeat(12), '03', '33'),
          tk73(PAYER_BG_DIGITS, '0'.repeat(16), '995566778899', '46', '02'),
        ],
        3,
      ),
    )

    expect(result.issues).toEqual([])
    expect(result.sections[0]!.mandates).toEqual([
      {
        line: 2,
        payer_number: '1001',
        bank_account: { clearing: '5000', number: '1234567' },
        identity_number: '190001010000',
        information_code: '04',
        comment_code: '32',
        information: 'Nyupplägg, initierat av betalningsmottagaren.',
        comment: 'Nytt medgivande.',
        action_date: '2026-10-29',
      },
      expect.objectContaining({ payer_number: '1002', bank_account: null, identity_number: null, information_code: '03', comment: 'Makulerad.' }),
      expect.objectContaining({ payer_number: PAYER_BG_DIGITS, bank_account: null, identity_number: '5566778899', information_code: '46' }),
    ])
  })

  it('warns when the end record counts another number of records', () => {
    const result = parseMandateNotice(notice([tk73('1', ' '.repeat(16), ' '.repeat(12), '03', '33')], 2))
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'warning', message: 'Slutposten anger 2 poster, avsnittet innehåller 1.' })])
  })
})

describe('parseRejectedPayments', () => {
  const rejected = (tk: '82' | '32', payer: string, ore: number, comment: string) =>
    record(tk, [
      [3, '20261030'],
      [11, '0'],
      [15, zero(payer, 16)],
      [31, zero(ore, 12)],
      [43, '1001234'],
      [59, comment],
    ])
  const end = (debits: number, debitOre: number) =>
    record('09', [
      [3, '20261030'],
      [11, '9900'],
      [15, zero(0, 6)],
      [21, zero(0, 12)],
      [33, zero(debits, 6)],
      [39, zero(debitOre, 12)],
    ])

  it('reads each rejected debit with its comment code one position left of the specification layout', () => {
    const result = parseRejectedPayments(file([reportOpening('AVVISADE BET UPPDR'), rejected('82', '1001', 150050, '01'), end(1, 150050)]))

    expect(result.issues).toEqual([])
    expect(result.sections[0]!.payments).toEqual([
      {
        line: 2,
        direction: 'debit',
        date: '2026-10-30',
        payer_number: '1001',
        amount: 1500.5,
        reference: '1001234',
        comment_code: '01',
        comment: 'Utgår, medgivande saknas.',
      },
    ])
  })

  it('reports an end record whose sums differ', () => {
    const result = parseRejectedPayments(file([reportOpening('AVVISADE BET UPPDR'), rejected('82', '1001', 150050, '13'), end(1, 150051)]))
    expect(result.issues).toEqual([expect.objectContaining({ line: 3, severity: 'error' })])
  })
})

describe('parseInternetBankMandates', () => {
  it('reads each mandate with the payer text, name, address, postal code and city', () => {
    const result = parseInternetBankMandates(
      file([
        record('51', [[3, '20261030'], [11, '9900'], [15, BG10], [25, 'AG-EMEDGIV']]),
        record('52', [[3, BG10], [13, zero('1001', 16)], [29, '5000000001234567'], [45, '190001010000'], [62, '0']]),
        record('53', [[3, 'Elevavgift HT']]),
        record('54', [[3, 'Åsa Öberg'], [39, 'c/o Svensson']]),
        record('55', [[3, 'Storgatan 1']]),
        record('56', [[3, '21134'], [8, 'MALMÖ']]),
        record('59', [[3, '20261030'], [11, '9900'], [15, zero(1, 7)]]),
      ]),
    )

    expect(result.issues).toEqual([])
    expect(result.sections[0]).toMatchObject({ bankgiro: PAYEE_BG, written_on: '2026-10-30' })
    expect(result.sections[0]!.mandates).toEqual([
      {
        line: 2,
        payer_number: '1001',
        bank_account: { clearing: '5000', number: '1234567' },
        identity_number: '190001010000',
        message_type: 'new',
        information: 'Elevavgift HT',
        name_and_address: ['Åsa Öberg', 'c/o Svensson', 'Storgatan 1'],
        postal_code: '21134',
        city: 'MALMÖ',
      },
    ])
  })
})

describe('parseMandateRegister', () => {
  const entry = (payer: string, type: string, status: string, account: string, changed = '00000000') =>
    record(BG10.slice(0, 2), [
      [3, BG10.slice(2)],
      [11, '190001010000'],
      [23, zero(payer, 16)],
      [39, type],
      [40, '26'],
      [42, '20240115'],
      [50, changed],
      [58, status],
      [65, account],
    ])

  it('reads every mandate Bankgirot holds, so existing mandates come along without retyping', () => {
    const result = parseMandateRegister(file([entry('1001', '1', '1', '5000000001234567'), entry('1002', '2', '2', ' '.repeat(16), '20260301')]))

    expect(result.issues).toEqual([])
    expect(result.mandates).toEqual([
      {
        line: 1,
        bankgiro: PAYEE_BG,
        identity_number: '190001010000',
        payer_number: '1001',
        initiated_by: 'payee',
        last_activity_year: '26',
        created_on: '2024-01-15',
        changed_on: null,
        status: 'approved',
        bank_account: { clearing: '5000', number: '1234567' },
      },
      expect.objectContaining({ payer_number: '1002', initiated_by: 'internet_bank', changed_on: '2026-03-01', status: 'pending', bank_account: null }),
    ])
  })

  it('refuses a line that is not a register record', () => {
    const result = parseMandateRegister(file([entry('1', '1', '1', '0'.repeat(16)), 'Kundnummer;Betalarnummer']))
    expect(result.mandates).toHaveLength(1)
    expect(result.issues).toEqual([expect.objectContaining({ line: 2, severity: 'error' })])
  })
})

describe('detectAutogiroReport', () => {
  it('tells the reports apart by their opening record', () => {
    expect(detectAutogiroReport(SPECIFICATION)).toEqual({ kind: 'payment_specification' })
    expect(detectAutogiroReport(file([reportOpening('AG-MEDAVI')]))).toEqual({ kind: 'mandate_notice' })
    expect(detectAutogiroReport(file([reportOpening('AVVISADE BET UPPDR')]))).toEqual({ kind: 'rejected_payments' })
    expect(detectAutogiroReport(file([record('51', [[3, '20261030'], [11, '9900'], [15, BG10], [25, 'AG-EMEDGIV']])]))).toEqual({
      kind: 'internet_bank_mandates',
    })
    expect(detectAutogiroReport(sealAutogiroFile(SPECIFICATION, '1234567890ABCDEF1234567890ABCDEF', '2026-10-30'))).toEqual({
      kind: 'payment_specification',
    })
  })

  it('recognises the old layout and reports v1 does not read, instead of misreading them', () => {
    const oldSpecification = record('01', [[3, '20261030'], [11, 'AUTOGIRO'], [19, '9900'], [63, CUSTOMER_NUMBER], [69, BG10]])
    const oldNotice = record('01', [[3, '20261030'], [11, '9900'], [15, BG10], [25, 'AG-MEDAVI']])
    expect(detectAutogiroReport(file([oldSpecification]))).toEqual({ kind: 'unsupported', reason: 'old_layout', content: null })
    expect(detectAutogiroReport(file([oldNotice]))).toEqual({ kind: 'unsupported', reason: 'old_layout', content: null })
    expect(detectAutogiroReport(file([reportOpening('MAKULERING/ÄNDRING')]))).toEqual({
      kind: 'unsupported',
      reason: 'other_report',
      content: 'MAKULERING/ÄNDRING',
    })
  })

  it('takes neither a BG Max file nor a bank statement for an Autogiro report', () => {
    expect(detectAutogiroReport(`01BGMAX               0120261030101530000000P${' '.repeat(34)}\r\n`)).toBeNull()
    expect(detectAutogiroReport('Bokföringsdag;Text;Belopp\n2026-10-30;AUTOGIRO;-499,00')).toBeNull()
    expect(detectAutogiroReport('')).toBeNull()
  })
})

describe('parseAutogiroReport', () => {
  it('parses what it detects and hands back the detection for the rest', () => {
    const parsed = parseAutogiroReport(SPECIFICATION)
    expect(parsed.report?.kind).toBe('payment_specification')

    const old = parseAutogiroReport(file([record('01', [[3, '20261030'], [11, 'AUTOGIRO']])]))
    expect(old).toEqual({ report: null, detection: { kind: 'unsupported', reason: 'old_layout', content: null } })
  })
})
