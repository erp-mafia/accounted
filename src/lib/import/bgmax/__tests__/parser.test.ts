import { describe, expect, it } from 'vitest'
import { parseBankFile } from '@/lib/import/bank-file/parser'
import { detectBgMax, parseBgMax } from '../parser'
import {
  OWN_BG,
  PAYER_BG_DIGITS,
  depositRecord,
  end,
  opening,
  payment,
  record,
  septemberFile,
  start,
} from './bgmax-fixture'
import { formatBankgiroNumber } from '@/lib/bankgiro/luhn'

describe('detectBgMax', () => {
  it('knows a BG Max file by its start record, whatever the file is called', () => {
    expect(detectBgMax(septemberFile())).toBe(true)
    expect(detectBgMax(`﻿\r\n${septemberFile()}`)).toBe(true)
  })

  it('does not take a bank statement CSV or an empty file for one', () => {
    expect(detectBgMax('Bokföringsdag;Valutadag;Text;Belopp\n2026-09-14;2026-09-14;BG 123-4567;1500,00')).toBe(false)
    expect(detectBgMax('')).toBe(false)
    expect(detectBgMax('01LBIN               01')).toBe(false)
  })
})

describe('parseBgMax', () => {
  it('reads each deposit with its payments: OCR, payer name, organisationsnummer, message and further references', () => {
    const result = parseBgMax(septemberFile())

    expect(result.issues).toEqual([])
    expect(result.test_file).toBe(false)
    expect(result.rejected_deposits).toBe(0)
    expect(result.date_from).toBe('2026-09-14')
    expect(result.date_to).toBe('2026-09-30')
    expect(result.deposits.map((d) => [d.date, d.serial, d.amount, d.bankgiro, d.payments.length])).toEqual([
      ['2026-09-14', '00012', 1500, OWN_BG, 2],
      ['2026-09-15', '00013', 200, OWN_BG, 2],
      ['2026-09-16', '00014', 750, OWN_BG, 1],
      ['2026-09-30', '00015', 999, OWN_BG, 1],
    ])

    const [first, second] = result.deposits[0]!.payments
    expect(first).toEqual({
      kind: 'payment',
      amount: 500,
      payer_bankgiro: formatBankgiroNumber(PAYER_BG_DIGITS),
      reference: '10017',
      reference_code: '2',
      extra_references: [],
      message: null,
      payer_name: 'Kund AB',
      payer_org_number: '5560160680',
      bgc_serial: '000000000101',
    })
    expect(second).toMatchObject({
      amount: 1000,
      payer_bankgiro: null,
      reference: 'Faktura 1002',
      reference_code: '3',
      extra_references: ['10025'],
      message: 'Tack för leveransen',
      // The name record's extra field joins the name; the address records are not kept.
      payer_name: 'Bolaget i Norr AB',
      payer_org_number: null,
    })
    expect(result.deposits[0]!.bank_account).toBe('84800000123456')
  })

  it('signs a deduction against its deposit, so the payments always sum to the deposit', () => {
    const [deposit] = parseBgMax(septemberFile()).deposits.slice(1, 2)
    expect(deposit!.payments.map((p) => [p.kind, p.amount, p.reference])).toEqual([
      ['payment', 250, '10033'],
      ['deduction', -50, '9999'],
    ])
    expect(deposit!.payments.reduce((sum, p) => sum + p.amount, 0)).toBe(deposit!.amount)
  })

  it('leaves out a blank reference (reference code 0)', () => {
    const last = parseBgMax(septemberFile()).deposits[3]!
    expect(last.payments[0]!.reference).toBeNull()
  })

  it('refuses a deposit whose payments do not add up to it, and keeps the others', () => {
    const content = [
      start(),
      opening(),
      payment({ ore: 10000, reference: '10017' }),
      depositRecord({ date: '20260914', serial: 1, ore: 20000, count: 1 }),
      opening(),
      payment({ ore: 30000, reference: '10025' }),
      depositRecord({ date: '20260915', serial: 2, ore: 30000, count: 1 }),
      end({ payments: 2, deductions: 0, extra: 0, deposits: 2 }),
    ].join('\n')
    const result = parseBgMax(content)
    expect(result.deposits.map((d) => d.date)).toEqual(['2026-09-15'])
    expect(result.rejected_deposits).toBe(1)
    expect(result.issues).toEqual([expect.objectContaining({ line: 4, severity: 'error' })])
  })

  it('never offers a test file for attaching', () => {
    const content = septemberFile().replace(start(), start('T'))
    const result = parseBgMax(content)
    expect(result.test_file).toBe(true)
    expect(result.deposits).toEqual([])
    expect(result.rejected_deposits).toBe(4)
  })

  it('ignores record types it does not know, trailing blanks trimmed away and plain LF line ends', () => {
    const lines = septemberFile().split('\r\n')
    lines.splice(3, 0, record('99', [[3, 'NYTT FÄLT I EN SENARE LAYOUT']]))
    const content = lines.map((l) => l.trimEnd()).join('\n')
    const result = parseBgMax(content)
    expect(result.deposits).toHaveLength(4)
    expect(result.deposits[0]!.payments[0]!.payer_name).toBe('Kund AB')
  })

  it('reports a truncated file: the last section has no deposit record and no end record follows', () => {
    const lines = septemberFile().split('\r\n')
    const truncated = lines.slice(0, lines.length - 2).join('\r\n')
    const result = parseBgMax(truncated)
    expect(result.deposits).toHaveLength(3)
    expect(result.rejected_deposits).toBe(1)
    expect(result.issues.map((i) => i.severity)).toEqual(['error', 'warning'])
  })

  it('warns when the end record counts disagree with the file', () => {
    const content = septemberFile().replace(
      end({ payments: 5, deductions: 1, extra: 1, deposits: 4 }),
      end({ payments: 9, deductions: 1, extra: 1, deposits: 4 }),
    )
    const result = parseBgMax(content)
    expect(result.deposits).toHaveLength(4)
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'warning' })])
  })
})

describe('the bank statement parser', () => {
  it('would read no rows from a BG Max file: the deposit route, not a statement import, takes it', () => {
    const parsed = parseBankFile(septemberFile(), 'BGMAX.txt')
    expect(parsed.transactions).toHaveLength(0)
  })
})
