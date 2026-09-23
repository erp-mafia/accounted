/**
 * The contract behind "one definition of a payable account".
 *
 * A clearing/account pair accepted at entry (employee form, server schema,
 * supplier payee resolver) must be one that every payment-file generator
 * carries, and a pair no generator can carry must be refused at entry. The
 * two used to be defined separately (entry took 5-11 account digits, the
 * Bankgirot LB field takes 10), so a value the form accepted failed the whole
 * salary file on payday with the raw account number in the error.
 *
 * This file walks a table of shapes through every surface. Every number in it
 * is invented.
 */
import { describe, it, expect } from 'vitest'
import {
  PayeeAccountError,
  resolveDomesticBankAccount,
  validateEmployeeBankAccount,
} from '@/lib/salary/payment/bank-account'
import { generateBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { generatePain001 } from '@/lib/salary/payment/pain001-generator'
import { generateSupplierPain001 } from '@/lib/payments/pain001-supplier'
import { resolveSupplierPayee } from '@/lib/payments/supplier-payee'

const PAYEE_NAME = 'Sara Svensson'

const lbCompany = { name: 'Testbolaget AB', senderBankgiro: '123-4567' }
const lbOptions = { paymentDate: '2026-09-25', periodLabel: '2026-09' }
const painCompany = {
  name: 'Testbolaget AB',
  orgNumber: '556677-8899',
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
}
const painOptions = { messageId: 'TEST-5566778899-2026-09', paymentDate: '2026-09-25', periodLabel: '2026-09' }
const supplierOptions = { messageId: 'TEST-5566778899-B1', createdAt: '2026-09-21T08:00:00.000Z' }

function runBgLb(clearing: string, account: string) {
  return generateBgLb(
    lbCompany,
    [{ name: PAYEE_NAME, clearingNumber: clearing, bankAccountNumber: account, netSalary: 25000 }],
    lbOptions,
  )
}

function runSalaryPain001(clearing: string, account: string) {
  return generatePain001(
    painCompany,
    [{ name: PAYEE_NAME, clearingNumber: clearing, bankAccountNumber: account, netSalary: 25000 }],
    painOptions,
  )
}

function runSupplierPain001(clearing: string, account: string) {
  return generateSupplierPain001(
    painCompany,
    [
      {
        payee: { type: 'bank_account', clearing, account },
        payeeName: PAYEE_NAME,
        payeeCity: 'Lund',
        amount: 25000,
        paymentDate: '2026-09-25',
        reference: { type: 'invoice_number', value: 'F-1001' },
      },
    ],
    supplierOptions,
  )
}

const GENERATORS = [
  { label: 'Bankgirot LB (salary)', format: 'bg_lb', run: runBgLb },
  { label: 'pain.001 (salary)', format: 'pain001', run: runSalaryPain001 },
  { label: 'pain.001 (supplier)', format: 'pain001', run: runSupplierPain001 },
] as const

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

/** Digits of a payee's clearing/account must never reach an error text. */
function expectNoNumbersIn(message: string, clearing: string, account: string) {
  const digits = (v: string) => v.replace(/\D/g, '')
  if (digits(account).length >= 4) expect(message).not.toContain(digits(account))
  if (digits(clearing).length >= 4) expect(message).not.toContain(digits(clearing))
  expect(message.replace('ISO 20022', '')).not.toMatch(/\d{4,}/)
}

// ── The shape table ─────────────────────────────────────────────
// Clearings: ordinary 4-digit ranges, a 4-digit 8xxx, 5-digit 8xxxx, and the
// malformed ones. Accounts: every length from 1 to 13, plus the 11-digit form
// that repeats a 4-digit clearing, plus separators and a stray letter.
const CLEARINGS = ['6000', '3300', '1708', '5037', '9960', '8327', '83279', '81059', '8327-9', '123', '12345', '90001', '']
const ACCOUNT_DIGITS = '9612345678012'

interface Shape {
  clearing: string
  account: string
}

const SHAPES: Shape[] = []
for (const clearing of CLEARINGS) {
  for (let length = 1; length <= ACCOUNT_DIGITS.length; length++) {
    SHAPES.push({ clearing, account: ACCOUNT_DIGITS.slice(0, length) })
  }
  const clearingDigits = clearing.replace(/\D/g, '')
  SHAPES.push({ clearing, account: `${clearingDigits.slice(0, 4)}2042825` })
  SHAPES.push({ clearing, account: '961 234-5' })
  SHAPES.push({ clearing, account: '96a2345' })
  SHAPES.push({ clearing, account: '' })
}

const label = (s: Shape) => `clearing "${s.clearing}" (${s.clearing.replace(/\D/g, '').length}) + account of ${s.account.replace(/\D/g, '').length} digits "${s.account}"`

describe('payable account contract: entry and payout share one definition', () => {
  it('covers both accepted and refused shapes (the table is not vacuous)', () => {
    const accepted = SHAPES.filter((s) => resolveDomesticBankAccount(s.clearing, s.account).ok)
    expect(accepted.length).toBeGreaterThan(40)
    expect(SHAPES.length - accepted.length).toBeGreaterThan(40)
    expect(accepted.some((s) => !(resolveDomesticBankAccount(s.clearing, s.account) as { fitsBgLb: boolean }).fitsBgLb)).toBe(true)
  })

  it.each(SHAPES.map((s) => [label(s), s] as const))('%s', (_label, shape) => {
    const { clearing, account } = shape
    const resolved = resolveDomesticBankAccount(clearing, account)

    // Entry: the employee form / server schema and the supplier payee
    // resolver accept exactly what resolves.
    if (clearing !== '' && account !== '') {
      expect(validateEmployeeBankAccount(clearing, account).length === 0).toBe(resolved.ok)
    }
    if (clearing.replace(/\D/g, '') !== '' || account.replace(/\D/g, '') !== '') {
      const payee = resolveSupplierPayee({
        bankgiro: null,
        plusgiro: null,
        bank_account: null,
        clearing_number: clearing,
        account_number: account,
      })
      // The supplier resolver strips non-digits before judging (its columns
      // are digits-only at entry), so compare on the digits it sees.
      const seen = resolveDomesticBankAccount(clearing.replace(/\D/g, ''), account.replace(/\D/g, ''))
      expect(payee.ok).toBe(seen.ok)
    }

    for (const generator of GENERATORS) {
      const error = caught(() => generator.run(clearing, account))

      if (!resolved.ok) {
        // Refused at entry: refused by every generator, by name, no numbers.
        expect(error, generator.label).toBeInstanceOf(PayeeAccountError)
        const payeeError = error as PayeeAccountError
        expect(payeeError.problem).toBe(resolved.problem)
        expect(payeeError.message).toContain(PAYEE_NAME)
        expectNoNumbersIn(payeeError.message, clearing, account)
        continue
      }

      if (generator.format === 'bg_lb' && !resolved.fitsBgLb) {
        // The one accepted shape the fixed-width LB field cannot hold: a
        // named refusal that points at pain.001, never a truncated number.
        expect(error, generator.label).toBeInstanceOf(PayeeAccountError)
        const payeeError = error as PayeeAccountError
        expect(payeeError.problem).toBe('bg_lb_account_too_long')
        expect(payeeError.message).toContain(PAYEE_NAME)
        expect(payeeError.message).toContain('pain.001')
        expectNoNumbersIn(payeeError.message, clearing, account)
        continue
      }

      // Accepted at entry implies the generator carries it, with the routing
      // the shared definition resolved.
      expect(error, generator.label).toBeNull()
    }

    if (!resolved.ok) return

    const salaryXml = runSalaryPain001(clearing, account)
    const supplierXml = runSupplierPain001(clearing, account)
    for (const xml of [salaryXml, supplierXml]) {
      expect(xml).toContain(`<MmbId>${resolved.clearing4}</MmbId>`)
      expect(xml).toContain(`<Id>${resolved.accountDigits}</Id>`)
    }

    if (resolved.fitsBgLb) {
      const lines = runBgLb(clearing, account).content.split('\r\n').filter((l) => l.length > 0)
      for (const line of lines) expect(line).toHaveLength(80)
      const payment = lines[1]
      expect(payment.slice(0, 2)).toBe('54')
      expect(payment.slice(2, 6)).toBe(resolved.clearing4)
      expect(payment.slice(6, 16)).toBe(resolved.accountDigits.padStart(10, '0'))
    }
  })
})

describe('the support ticket, reproduced with an invented number', () => {
  // A Swedbank employee: 5-digit clearing ending in 9 and a 10-digit account
  // beginning 96. The LB account field would need "996..." in 11 positions.
  const clearing = '83279'
  const account = '9612345678'

  it('used to surface as "Numeriskt fält för långt (11 > 10): 996..."; now names the employee and the way out', () => {
    expect(validateEmployeeBankAccount(clearing, account)).toEqual([])

    const error = caught(() => runBgLb(clearing, account))
    expect(error).toBeInstanceOf(PayeeAccountError)
    const message = (error as Error).message
    expect(message).toBe(
      'Sara Svensson: kontonumret ryms inte i Bankgirot LB-filen (femsiffrigt clearingnummer med tiosiffrigt kontonummer). Skapa betalfilen som ISO 20022 (pain.001) i stället.',
    )
    expect(message).not.toContain('996')
    expect(message).not.toContain('Numeriskt')
  })

  it('is paid by the pain.001 file, which has no fixed-width account field', () => {
    const xml = runSalaryPain001(clearing, account)
    expect(xml).toContain('<MmbId>8327</MmbId>')
    expect(xml).toContain('<Id>99612345678</Id>')
  })

  it('leaves every other employee payable in the LB file once that one is handled', () => {
    const result = generateBgLb(
      lbCompany,
      [{ name: 'Bo Ek', clearingNumber: '83271', bankAccountNumber: '123456789', netSalary: 1000 }],
      lbOptions,
    )
    expect(result.recordCount).toBe(1)
  })
})
