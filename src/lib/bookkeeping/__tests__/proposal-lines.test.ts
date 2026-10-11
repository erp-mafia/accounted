import { describe, it, expect } from 'vitest'
import { applyVatAmountToLines, computeProposalLines, proposalLinesToFormLines, resolveTemplateAccountsForEntity, staticTemplateToFormLines } from '@/lib/bookkeeping/proposal-lines'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import { buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { buildMappingResultFromTemplate } from '@/lib/bookkeeping/booking-templates'
import { reconcileRcBasisWithCostLines } from '@/lib/bookkeeping/rc-basis-reconcile'
import { chartVatTreatmentsOf, type ChartVatTreatments } from '@/lib/bookkeeping/vat-entries'
import type { MappingResult, Transaction } from '@/types'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type { LinePatternEntry } from '@/types'

/** The company's momskoder: account -> momskod, or [momskod, momssats]. */
function chartOf(codes: Record<string, string | [string, number]> = {}): ChartVatTreatments {
  return chartVatTreatmentsOf(Object.entries(codes).map(([account_number, code]) => ({
    account_number,
    default_vat_treatment: Array.isArray(code) ? code[0] : code,
    default_vat_rate: Array.isArray(code) ? code[1] : null,
  })))
}

function sumSide(lines: ProposalLine[], side: 'debet' | 'kredit'): number {
  return roundOre(lines.filter(l => l.side === side).reduce((s, l) => s + l.amount, 0))
}

describe('computeProposalLines', () => {
  describe('category branch (AI suggestion / category booking)', () => {
    it('builds expense lines with extracted VAT and marks the bank leg as settlement', () => {
      const lines = computeProposalLines({
        amount: -123.45,
        category: 'expense_software',
        vatTreatment: 'standard_25',
      })
      // net 98.76 + VAT 24.69 = 123.45 (ore rounding preserved)
      expect(lines).toEqual([
        { side: 'debet', account: '5420', amount: 98.76 },
        { side: 'debet', account: '2641', amount: 24.69 },
        { side: 'kredit', account: '1930', amount: 123.45, settlement: true },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('applies the account override on the non-bank side (what the AI proposal edits)', () => {
      const lines = computeProposalLines({
        amount: -100,
        category: 'expense_software',
        vatTreatment: 'standard_25',
        accountOverride: '4010',
      })
      expect(lines[0]).toEqual({ side: 'debet', account: '4010', amount: 80 })
      // The bank leg keeps the settlement flag, never the override
      expect(lines[2]).toEqual({ side: 'kredit', account: '1930', amount: 100, settlement: true })
    })

    it('builds income lines with output VAT and settlement on the debit bank leg', () => {
      const lines = computeProposalLines({
        amount: 106,
        category: 'income_services',
        vatTreatment: 'reduced_6',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 106, settlement: true },
        { side: 'kredit', account: '2631', amount: 6 },
        { side: 'kredit', account: '3003', amount: 100 },
      ])
    })

    it('uses the SEK-equivalent magnitude for foreign-currency transactions', () => {
      const lines = computeProposalLines({
        amount: -100, // EUR
        amountSek: 1150,
        category: 'expense_other',
        vatTreatment: 'standard_25',
      })
      const bank = lines.find(l => l.settlement)
      expect(bank).toEqual({ side: 'kredit', account: '1930', amount: 1150, settlement: true })
      expect(sumSide(lines, 'debet')).toBe(1150)
    })

    it('adds the reverse-charge offsetting pair for category expenses', () => {
      const lines = computeProposalLines({
        amount: -1000,
        category: 'expense_other',
        vatTreatment: 'reverse_charge',
      })
      expect(lines).toContainEqual({ side: 'debet', account: '2645', amount: 250 })
      expect(lines).toContainEqual({ side: 'kredit', account: '2614', amount: 250 })
    })

    // #2919: the preview shows the basis pair the category path now books.
    it('shows the basis pair for a category reverse charge, exactly as the engine books it', () => {
      const tx = makeTransaction({ amount: -1000 })
      const lines = computeProposalLines({
        amount: -1000,
        category: 'expense_software',
        vatTreatment: 'reverse_charge',
        entityType: 'aktiebolag',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '5420', amount: 1000 },
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
        { side: 'debet', account: '2645', amount: 250 },
        { side: 'kredit', account: '2614', amount: 250 },
        { side: 'debet', account: '4535', amount: 1000 },
        { side: 'kredit', account: '4598', amount: 1000 },
      ])
      const engine = buildTransactionEntryLines(
        tx,
        buildMappingResultFromCategory('expense_software', tx, true, 'aktiebolag', 'reverse_charge'),
      )
      const asSet = (rows: Array<[string, number, number]>) => rows.map((r) => r.join(':')).sort()
      expect(asSet(lines.map((l) => [l.account, l.side === 'debet' ? l.amount : 0, l.side === 'kredit' ? l.amount : 0])))
        .toEqual(asSet(engine.map((l) => [l.account_number, l.debit_amount, l.credit_amount])))
    })

    it('puts the basis on the chosen kind and skips it on a basis-account override', () => {
      const nonEu = computeProposalLines({
        amount: -1000,
        category: 'expense_software',
        vatTreatment: 'reverse_charge',
        reverseChargeKind: 'non_eu_services',
      })
      expect(nonEu).toContainEqual({ side: 'debet', account: '4531', amount: 1000 })
      const onBasis = computeProposalLines({
        amount: -1000,
        category: 'expense_software',
        vatTreatment: 'reverse_charge',
        accountOverride: '4535',
      })
      expect(onBasis.map((l) => l.account)).toEqual(['4535', '1930', '2645', '2614'])
    })

    it('returns no lines without a category', () => {
      expect(computeProposalLines({ amount: -100 })).toEqual([])
    })

    it('balances 12% amounts that break independently-rounded net+VAT (skeptic counterexample)', () => {
      // 102.06 at 12%: the VAT is exactly 10.935, an exact half, so roundOre
      // takes it up to 10.94. Rounding net and VAT independently would give
      // 91.13 + 10.94 = 102.07 (off by 1 ore); the engine computes VAT once
      // (roundOre) and derives the net by subtraction: 91.12 + 10.94 = 102.06.
      const lines = computeProposalLines({
        amount: -102.06,
        category: 'expense_representation', // maps to reduced_12 by default
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6071', amount: 91.12 },
        { side: 'debet', account: '2641', amount: 10.94 },
        { side: 'kredit', account: '1930', amount: 102.06, settlement: true },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it("books no VAT for an explicit 'exempt' deviation (Ingen moms)", () => {
      // The dialog resolves a user's "Ingen moms" deviation to 'exempt'
      // before computing lines; the mapping must NOT re-derive the 25%
      // category default into the prefill.
      const lines = computeProposalLines({
        amount: -1000,
        category: 'expense_other',
        vatTreatment: 'exempt',
        accountOverride: '2350',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '2350', amount: 1000 },
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
      ])
    })
  })

  // crm#1136: money out on an income category is a refund to a customer, and
  // the preview has to show the entry the booking posts (ENGINE PARITY).
  describe('category branch: a row against its category is a refund', () => {
    const asSet = (rows: Array<[string, number, number]>) => rows.map((r) => r.join(':')).sort()
    const previewSet = (lines: ProposalLine[]) =>
      asSet(lines.map((l) => [l.account, l.side === 'debet' ? l.amount : 0, l.side === 'kredit' ? l.amount : 0]))

    it('previews a refund to a customer: revenue and utgående moms debited, the bank credited', () => {
      const lines = computeProposalLines({ amount: -125, category: 'income_services', vatTreatment: 'standard_25' })
      expect(lines).toEqual([
        { side: 'debet', account: '3001', amount: 100 },
        { side: 'debet', account: '2611', amount: 25 },
        { side: 'kredit', account: '1930', amount: 125, settlement: true },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('puts an account override on the business side of a refund, never on the bank leg', () => {
      const lines = computeProposalLines({
        amount: -125, category: 'income_services', vatTreatment: 'standard_25', accountOverride: '3051',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '3051', amount: 100 },
        { side: 'debet', account: '2611', amount: 25 },
        { side: 'kredit', account: '1930', amount: 125, settlement: true },
      ])
    })

    it('books no reverse-charge self-assessment on a refund of a sale to an EU business', () => {
      const lines = computeProposalLines({ amount: -125, category: 'income_services', vatTreatment: 'reverse_charge' })
      expect(lines).toEqual([
        { side: 'debet', account: '3308', amount: 125 },
        { side: 'kredit', account: '1930', amount: 125, settlement: true },
      ])
    })

    const categories = ['income_services', 'income_products', 'income_other', 'expense_software', 'expense_bank_fees'] as const
    const treatments = [undefined, 'standard_25', 'reduced_12', 'reduced_6', 'exempt', 'export', 'reverse_charge'] as const
    const amounts = [-125, 125, -102.06, 102.06, -0.07, 0.07]

    it('matches the engine line for line for every category, treatment and direction', () => {
      for (const category of categories) for (const vatTreatment of treatments) for (const amount of amounts) {
        const tx = makeTransaction({ amount })
        const engine = buildTransactionEntryLines(
          tx,
          buildMappingResultFromCategory(category, tx, true, 'enskild_firma', vatTreatment),
        )
        const preview = computeProposalLines({ amount, category, vatTreatment })
        expect(previewSet(preview), `${category} ${vatTreatment} ${amount}`)
          .toEqual(asSet(engine.map((l) => [l.account_number, l.debit_amount, l.credit_amount])))
      }
    })
  })

  describe('template branch (static review template)', () => {
    it('builds an expense from debit/credit pair with VAT rate', () => {
      const lines = computeProposalLines({
        amount: -125,
        templateDebitAccount: '6212',
        templateCreditAccount: '1930',
        templateVatRate: 0.25,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6212', amount: 100 },
        { side: 'debet', account: '2641', amount: 25 },
        { side: 'kredit', account: '1930', amount: 125, settlement: true },
      ])
    })

    it('builds an income booking with rate-mapped output VAT account', () => {
      const lines = computeProposalLines({
        amount: 112,
        templateDebitAccount: '1930',
        templateCreditAccount: '3002',
        templateVatRate: 0.12,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 112, settlement: true },
        { side: 'kredit', account: '3002', amount: 100 },
        { side: 'kredit', account: '2621', amount: 12 },
      ])
    })

    it('builds the full reverse-charge verifikation incl. fiktiv moms and basbelopp pairs', () => {
      const lines = computeProposalLines({
        amount: -1000,
        templateDebitAccount: '6540',
        templateCreditAccount: '1930',
        templateVatRate: 0,
        templateVatTreatment: 'reverse_charge',
        templateSupplierType: 'eu_business',
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6540', amount: 1000 },
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
        { side: 'debet', account: '2645', amount: 250 },
        { side: 'kredit', account: '2614', amount: 250 },
        { side: 'debet', account: '4535', amount: 1000 },
        { side: 'kredit', account: '4598', amount: 1000 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('skips the basbelopp pair when the debit account is already a basis account', () => {
      const lines = computeProposalLines({
        amount: -1000,
        templateDebitAccount: '4535',
        templateCreditAccount: '1930',
        templateVatTreatment: 'reverse_charge',
        templateSupplierType: 'eu_business',
      })
      expect(lines.map(l => l.account)).toEqual(['4535', '1930', '2645', '2614'])
    })

    it("uses the engine's plain rounding for fiktiv moms (no EPSILON nudge)", () => {
      // 8.62 * 0.25 = 2.155 stored as 2.1549999...: the engine's
      // Math.round(x*100)/100 gives 2.15; roundOre would give 2.16 and the
      // prefill would diverge from the booked verifikat by 1 ore.
      const lines = computeProposalLines({
        amount: -8.62,
        templateDebitAccount: '6540',
        templateCreditAccount: '1930',
        templateVatTreatment: 'reverse_charge',
        templateSupplierType: 'eu_business',
      })
      expect(lines.find(l => l.account === '2645')?.amount).toBe(2.15)
      expect(lines.find(l => l.account === '2614')?.amount).toBe(2.15)
    })

    it('balances 12% template amounts via net-by-subtraction', () => {
      const lines = computeProposalLines({
        amount: -100.94,
        templateDebitAccount: '5831',
        templateCreditAccount: '1930',
        templateVatRate: 0.12,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '5831', amount: 90.12 },
        { side: 'debet', account: '2641', amount: 10.82 },
        { side: 'kredit', account: '1930', amount: 100.94, settlement: true },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })
  })

  describe('legacy counterparty pair branch', () => {
    it('emits the fiktiv-moms pair and the basbelopp pair for a reverse-charge pair', () => {
      // Engine books D 6540 / K 1930 / D 2645 / K 2614 / D 4535 / K 4598 for
      // a learned RC counterparty (legacy path, #2919); the prefill dropping
      // either pair would understate ruta 30/48 or rutor 20-24.
      const lines = computeProposalLines({
        amount: -12500,
        templateDebitAccount: '6540',
        templateCreditAccount: '1930',
        templateVatTreatment: 'reverse_charge',
        counterpartyLegacy: true,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6540', amount: 12500 },
        { side: 'kredit', account: '1930', amount: 12500, settlement: true },
        { side: 'debet', account: '2645', amount: 3125 },
        { side: 'kredit', account: '2614', amount: 3125 },
        { side: 'debet', account: '4535', amount: 12500 },
        { side: 'kredit', account: '4598', amount: 12500 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('mirrors both reverse-charge pairs for a refund against an RC pair, like the engine', () => {
      const template = makeCategorizationTemplate({
        debit_account: '6540',
        credit_account: '1930',
        vat_treatment: 'reverse_charge',
      })
      const tx = makeTransaction({ amount: 1000 })
      const lines = computeProposalLines({
        amount: 1000,
        templateDebitAccount: '6540',
        templateCreditAccount: '1930',
        templateVatTreatment: 'reverse_charge',
        counterpartyLegacy: true,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 1000, settlement: true },
        { side: 'kredit', account: '6540', amount: 1000 },
        { side: 'kredit', account: '2645', amount: 250 },
        { side: 'debet', account: '2614', amount: 250 },
        { side: 'kredit', account: '4535', amount: 1000 },
        { side: 'debet', account: '4598', amount: 1000 },
      ])
      const engine = buildTransactionEntryLines(
        tx,
        buildMappingResultFromCounterpartyTemplate({ template, matchMethod: 'exact_alias', confidence: 0.8 }, tx, 'aktiebolag'),
      )
      const asSet = (rows: Array<[string, number, number]>) => rows.map((r) => r.join(':')).sort()
      expect(asSet(lines.map((l) => [l.account, l.side === 'debet' ? l.amount : 0, l.side === 'kredit' ? l.amount : 0])))
        .toEqual(asSet(engine.map((l) => [l.account_number, l.debit_amount, l.credit_amount])))
    })

    it('extracts input VAT from the treatment for a normal expense pair', () => {
      const lines = computeProposalLines({
        amount: -125,
        templateDebitAccount: '6212',
        templateCreditAccount: '1930',
        templateVatTreatment: 'standard_25',
        counterpartyLegacy: true,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6212', amount: 100 },
        { side: 'debet', account: '2641', amount: 25 },
        { side: 'kredit', account: '1930', amount: 125, settlement: true },
      ])
    })

    it('books income-learned pairs gross without VAT legs (engine gates VAT on expenses)', () => {
      const lines = computeProposalLines({
        amount: 1250,
        templateDebitAccount: '1930',
        templateCreditAccount: '3001',
        templateVatTreatment: 'standard_25',
        counterpartyLegacy: true,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 1250, settlement: true },
        { side: 'kredit', account: '3001', amount: 1250 },
      ])
    })

    it('mirrors a refund against an expense-learned pair incl. the VAT leg', () => {
      // Incoming refund (amount > 0) matching an expense-learned pair:
      // engine settles debit against the bank, credits the business account
      // net and mirrors the input VAT to a 2641 credit.
      const lines = computeProposalLines({
        amount: 125,
        templateDebitAccount: '6212',
        templateCreditAccount: '1930',
        templateVatTreatment: 'standard_25',
        counterpartyLegacy: true,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 125, settlement: true },
        { side: 'kredit', account: '6212', amount: 100 },
        { side: 'kredit', account: '2641', amount: 25 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('mirrors an outgoing repayment against an income-learned pair gross', () => {
      const lines = computeProposalLines({
        amount: -500,
        templateDebitAccount: '1930',
        templateCreditAccount: '3001',
        templateVatTreatment: 'standard_25',
        counterpartyLegacy: true,
      })
      expect(lines).toEqual([
        { side: 'debet', account: '3001', amount: 500 },
        { side: 'kredit', account: '1930', amount: 500, settlement: true },
      ])
    })
  })

  describe('resolveTemplateAccountsForEntity', () => {
    const template = {
      debit_account: '2013',
      credit_account: '1930',
      debit_account_ab: '2893',
    }

    it('keeps EF accounts for enskild firma', () => {
      expect(resolveTemplateAccountsForEntity(template, 'enskild_firma')).toEqual({
        debitAccount: '2013',
        creditAccount: '1930',
      })
    })

    it('translates the owner account to 2890 for an ideell förening', () => {
      expect(resolveTemplateAccountsForEntity(template, 'ideell_forening')).toEqual({
        debitAccount: '2890',
        creditAccount: '1930',
      })
    })

    it('substitutes AB accounts for aktiebolag, falling back per side', () => {
      expect(resolveTemplateAccountsForEntity(template, 'aktiebolag')).toEqual({
        debitAccount: '2893',
        creditAccount: '1930',
      })
    })
  })

  describe('line pattern branch (counterparty template)', () => {
    const pattern: LinePatternEntry[] = [
      { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
      { account: '6212', type: 'business', side: 'debit', ratio: 1 },
    ]

    it('builds settlement + VAT + business lines from the pattern', () => {
      const lines = computeProposalLines({ amount: -1000, linePattern: pattern })
      expect(lines).toEqual([
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
        { side: 'debet', account: '2641', amount: 200 },
        { side: 'debet', account: '6212', amount: 800 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('respects a custom settlement account', () => {
      const lines = computeProposalLines({ amount: -1000, linePattern: pattern, settlementAccount: '1932' })
      expect(lines[0]).toEqual({ side: 'kredit', account: '1932', amount: 1000, settlement: true })
    })

    it("books an expense settlement on the template's learned credit account (engine parity)", () => {
      // SIE-learned pattern settling on leverantorsskulder: the engine books
      // the money leg on tmpl.credit_account (buildTransactionEntryLines),
      // and applySettlementAccount never rewrites a non-cash leg. The prefill
      // must show 2440, not a default 1930.
      const lines = computeProposalLines({
        amount: -1250,
        linePattern: pattern,
        templateDebitAccount: '4010',
        templateCreditAccount: '2440',
      })
      expect(lines[0]).toEqual({ side: 'kredit', account: '2440', amount: 1250, settlement: true })
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it("books an income settlement on the template's learned debit account (engine parity)", () => {
      const incomePattern: LinePatternEntry[] = [
        { account: '2611', type: 'vat', side: 'credit', vat_rate: 0.25 },
        { account: '3001', type: 'business', side: 'credit', ratio: 1 },
      ]
      const lines = computeProposalLines({
        amount: 1250,
        linePattern: incomePattern,
        templateDebitAccount: '1510',
        templateCreditAccount: '3001',
      })
      expect(lines[0]).toEqual({ side: 'debet', account: '1510', amount: 1250, settlement: true })
    })

    it('mirror-swaps the learned pair for a refund settlement (engine parity)', () => {
      // Refund (amount > 0) of an expense-learned pattern: the engine's
      // mirror swaps the legacy pair, so result.debit_account is
      // tmpl.credit_account and the money leg lands there.
      const lines = computeProposalLines({
        amount: 1000,
        linePattern: pattern,
        templateDebitAccount: '4010',
        templateCreditAccount: '2440',
      })
      expect(lines[0]).toEqual({ side: 'debet', account: '2440', amount: 1000, settlement: true })
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('falls back to the swappable 1930 default when the learned pair is absent', () => {
      const lines = computeProposalLines({ amount: -1000, linePattern: pattern })
      expect(lines[0]).toEqual({ side: 'kredit', account: '1930', amount: 1000, settlement: true })
    })

    it('books the ore rounding difference on 3740', () => {
      const multi: LinePatternEntry[] = [
        { account: '6110', type: 'business', side: 'debit', ratio: 0.333 },
        { account: '6212', type: 'business', side: 'debit', ratio: 0.333 },
        { account: '6991', type: 'business', side: 'debit', ratio: 0.333 },
      ]
      const lines = computeProposalLines({ amount: -100, linePattern: multi })
      // 3 x 33.30 = 99.90, diff 0.10 lands on 3740 on the business side
      expect(lines).toContainEqual({ side: 'debet', account: '3740', amount: 0.1 })
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('books an over-allocating diff on 3740 opposite the business side (#1898)', () => {
      const over: LinePatternEntry[] = [
        { account: '6110', type: 'business', side: 'debit', ratio: 0.3334 },
        { account: '6212', type: 'business', side: 'debit', ratio: 0.3334 },
        { account: '6991', type: 'business', side: 'debit', ratio: 0.3334 },
      ]
      const lines = computeProposalLines({ amount: -100, linePattern: over })
      // 3 x 33.34 = 100.02 over-allocates by 0.02: 3740 offsets on the credit side
      expect(lines).toContainEqual({ side: 'kredit', account: '3740', amount: 0.02 })
      expect(sumSide(lines, 'debet')).toBe(100.02)
      expect(sumSide(lines, 'kredit')).toBe(100.02)
    })

    it('balances a normalized 50/50 pattern on an odd-ore amount (#1898)', () => {
      const half: LinePatternEntry[] = [
        { account: '6110', type: 'business', side: 'debit', ratio: 0.5 },
        { account: '6212', type: 'business', side: 'debit', ratio: 0.5 },
      ]
      const lines = computeProposalLines({ amount: -100.03, linePattern: half })
      // 50.015 rounds to 50.02 twice: ratios that sum to exactly 1 still over-allocate
      expect(lines).toContainEqual({ side: 'debet', account: '6110', amount: 50.02 })
      expect(lines).toContainEqual({ side: 'kredit', account: '3740', amount: 0.01 })
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('mirrors the over-allocation rounding leg on a refund (#1898)', () => {
      const over: LinePatternEntry[] = [
        { account: '6110', type: 'business', side: 'debit', ratio: 0.3334 },
        { account: '6212', type: 'business', side: 'debit', ratio: 0.3334 },
        { account: '6991', type: 'business', side: 'debit', ratio: 0.3334 },
      ]
      const lines = computeProposalLines({ amount: 100, linePattern: over })
      // Mirrored business side is kredit, so the over-allocation offset lands on debet
      expect(lines).toContainEqual({ side: 'kredit', account: '6110', amount: 33.34 })
      expect(lines).toContainEqual({ side: 'debet', account: '3740', amount: 0.02 })
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('keeps the 3740 leg in byte parity with the engine across 0.01..50.00 kr (#1898)', () => {
      const half: LinePatternEntry[] = [
        { account: '6110', type: 'business', side: 'debit', ratio: 0.5 },
        { account: '6212', type: 'business', side: 'debit', ratio: 0.5 },
      ]
      const template = makeCategorizationTemplate({
        debit_account: '6110',
        credit_account: '1930',
        line_pattern: half,
      })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      for (let ore = 1; ore <= 5000; ore++) {
        const amount = -(ore / 100)
        const tx = makeTransaction({ amount })
        const engine = buildMappingResultFromCounterpartyTemplate(match, tx, 'enskild_firma')
        const proposal = computeProposalLines({ amount, linePattern: half })
        const engineRounding = engine.vat_lines.find(l => l.account_number === '3740')
        const proposalRounding = proposal.find(l => l.account === '3740')
        if (engineRounding) {
          expect(proposalRounding, `amount ${amount}`).toEqual({
            side: engineRounding.debit_amount > 0 ? 'debet' : 'kredit',
            account: '3740',
            amount: engineRounding.debit_amount || engineRounding.credit_amount,
          })
        } else {
          expect(proposalRounding, `amount ${amount}`).toBeUndefined()
        }
        expect(sumSide(proposal, 'debet'), `amount ${amount}`).toBe(sumSide(proposal, 'kredit'))
      }
    })

    it('previews a learned reverse-charge basis pair line for line like the engine, balanced', () => {
      // The shape SIE learning stores for 5420 + 4531/4598 + fiktiv moms.
      const pattern: LinePatternEntry[] = [
        { account: '4531', type: 'business', side: 'debit', ratio: 0.3334 },
        { account: '4598', type: 'business', side: 'credit', ratio: 0.3333 },
        { account: '5420', type: 'business', side: 'debit', ratio: 0.3333 },
      ]
      const template = makeCategorizationTemplate({ debit_account: '5420', credit_account: '1930', line_pattern: pattern })
      const match = { template, matchMethod: 'exact_alias' as const, confidence: 0.9 }
      for (const amount of [-250, -0.01, -99.99, -1234.56, 250, 0.03]) {
        const engine = buildMappingResultFromCounterpartyTemplate(match, makeTransaction({ amount }), 'enskild_firma')
        const proposal = computeProposalLines({ amount, linePattern: pattern })
        expect(proposal.filter((l) => !l.settlement), `amount ${amount}`).toEqual(
          engine.vat_lines.map((l) => ({
            side: l.debit_amount > 0 ? 'debet' : 'kredit',
            account: l.account_number,
            amount: l.debit_amount || l.credit_amount,
          })),
        )
        expect(sumSide(proposal, 'debet'), `amount ${amount}`).toBe(sumSide(proposal, 'kredit'))
      }
      expect(computeProposalLines({ amount: -250, linePattern: pattern })).toEqual([
        { side: 'kredit', account: '1930', amount: 250, settlement: true },
        { side: 'debet', account: '5420', amount: 250 },
        { side: 'debet', account: '2645', amount: 62.5 },
        { side: 'kredit', account: '2614', amount: 62.5 },
        { side: 'debet', account: '4531', amount: 250 },
        { side: 'kredit', account: '4598', amount: 250 },
      ])
    })

    it('handles income patterns with the settlement on the debit side', () => {
      const incomePattern: LinePatternEntry[] = [
        { account: '2611', type: 'vat', side: 'credit', vat_rate: 0.25 },
        { account: '3001', type: 'business', side: 'credit', ratio: 1 },
      ]
      const lines = computeProposalLines({ amount: 1250, linePattern: incomePattern })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 1250, settlement: true },
        { side: 'kredit', account: '2611', amount: 250 },
        { side: 'kredit', account: '3001', amount: 1000 },
      ])
    })

    it('mirrors a sign-mismatched pattern like the engine (refund of an expense pattern)', () => {
      // Refund (amount > 0) hitting an expense-learned pattern: the engine
      // flips every learned side so the mirrored entry reduces what the
      // pattern built up, instead of debiting expense accounts for money in.
      const lines = computeProposalLines({ amount: 1000, linePattern: pattern })
      expect(lines).toEqual([
        { side: 'debet', account: '1930', amount: 1000, settlement: true },
        { side: 'kredit', account: '2641', amount: 200 },
        { side: 'kredit', account: '6212', amount: 800 },
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })

    it('ignores ratio on vat-type entries when allocating (engine filters by type)', () => {
      const mixed: LinePatternEntry[] = [
        { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25, ratio: 0.5 },
        { account: '6212', type: 'business', side: 'debit', ratio: 1 },
      ]
      const lines = computeProposalLines({ amount: -1000, linePattern: mixed })
      // The vat entry's stray ratio must not allocate a second business leg.
      expect(lines.map(l => l.account)).toEqual(['1930', '2641', '6212'])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    })
  })
})

// crm#1096: a cost account the company gave a reverse-charge momskod reports
// ruta 20-24 itself, at its momssats. The engine settles the reverse-charge
// set on the final account with the chart (reconcileRcBasisWithChart); the
// preview, and the lines "Ändra rader" hands to the manual form, must book
// exactly that.
describe('company momskoder: the preview books the set the engine settles (crm#1096)', () => {
  type Shape = Array<[string, 'debet' | 'kredit', number]>
  const previewShape = (lines: ProposalLine[]): Shape =>
    lines.map((l): [string, 'debet' | 'kredit', number] => [l.account, l.side, l.amount]).sort()
  const engineShape = (tx: Transaction, result: MappingResult, chart: ChartVatTreatments): Shape =>
    buildTransactionEntryLines(tx, reconcileRcBasisWithCostLines(result, chart))
      .map((l): [string, 'debet' | 'kredit', number] =>
        [l.account_number, l.debit_amount > 0 ? 'debet' : 'kredit', l.debit_amount || l.credit_amount])
      .sort()

  it('category with an account_override onto a configured account: no pair, as booked', () => {
    const chart = chartOf({ '6540': 'reverse_charge_eu_services' })
    const tx = makeTransaction({ amount: -1000, amount_sek: -1000, currency: 'SEK', exchange_rate: 1 })
    const preview = computeProposalLines({
      amount: -1000, category: 'expense_software', vatTreatment: 'reverse_charge',
      accountOverride: '6540', chartVatTreatments: chart,
    })
    expect(preview.map((l) => l.account)).not.toContain('4598')
    const engine = buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge')
    engine.debit_account = '6540'
    expect(previewShape(preview)).toEqual(engineShape(tx, engine, chart))
  })

  it('category with an account_override onto an account at 12 %: no pair, fiktiv moms at 12 %, as booked', () => {
    const chart = chartOf({ '4057': ['reverse_charge_eu_goods', 0.12] })
    const tx = makeTransaction({ amount: -1000, amount_sek: -1000, currency: 'SEK', exchange_rate: 1 })
    const preview = computeProposalLines({
      amount: -1000, category: 'expense_software', vatTreatment: 'reverse_charge',
      accountOverride: '4057', chartVatTreatments: chart,
    })
    expect(previewShape(preview)).toEqual([
      ['1930', 'kredit', 1000],
      ['2624', 'kredit', 120],
      ['2645', 'debet', 120],
      ['4057', 'debet', 1000],
    ])
    const engine = buildMappingResultFromCategory('expense_software', tx, true, 'enskild_firma', 'reverse_charge')
    engine.debit_account = '4057'
    expect(previewShape(preview)).toEqual(engineShape(tx, engine, chart))
  })

  it('a static reverse-charge template on a configured account: no pair, as booked; without the chart the pair stays', () => {
    const chart = chartOf({ '5420': 'reverse_charge_eu_services' })
    const template = getTemplateById('it_saas_eu')!
    const tx = makeTransaction({ amount: -1000, amount_sek: -1000, currency: 'SEK', exchange_rate: 1 })
    const input = {
      amount: -1000,
      templateDebitAccount: template.debit_account,
      templateCreditAccount: template.credit_account,
      templateVatRate: template.vat_rate,
      templateVatTreatment: template.vat_treatment,
      templateSupplierType: template.reverse_charge_supplier_type,
    }
    const preview = computeProposalLines({ ...input, chartVatTreatments: chart })
    expect(preview.map((l) => l.account)).toEqual(['5420', '1930', '2645', '2614'])
    expect(previewShape(preview)).toEqual(engineShape(tx, buildMappingResultFromTemplate(template, tx, 'enskild_firma'), chart))
    expect(computeProposalLines(input).map((l) => l.account)).toContain('4598')
  })

  it('a legacy counterparty pair on a configured account, purchase and refund: no pair, as booked', () => {
    const chart = chartOf({ '4056': 'reverse_charge_eu_goods' })
    const template = makeCategorizationTemplate({ debit_account: '4056', credit_account: '1930', vat_treatment: 'reverse_charge' })
    for (const amount of [-1000, 1000]) {
      const tx = makeTransaction({ amount, amount_sek: amount, currency: 'SEK', exchange_rate: 1 })
      const preview = computeProposalLines({
        amount, templateDebitAccount: '4056', templateCreditAccount: '1930',
        templateVatTreatment: 'reverse_charge', counterpartyLegacy: true, chartVatTreatments: chart,
      })
      expect(preview.map((l) => l.account)).not.toContain('4535')
      const engine = buildMappingResultFromCounterpartyTemplate({ template, matchMethod: 'exact_alias', confidence: 0.9 }, tx, 'aktiebolag')
      expect(previewShape(preview)).toEqual(engineShape(tx, engine, chart))
    }
  })

  it('a learned line pattern: the pair shrinks by the cost lines that report the basis themselves, as booked', () => {
    const chart = chartOf({ '6540': 'reverse_charge_non_eu_services' })
    const linePattern: LinePatternEntry[] = [
      { account: '4531', type: 'business', side: 'debit', ratio: 0.5 },
      { account: '4598', type: 'business', side: 'credit', ratio: 0.5 },
      { account: '5420', type: 'business', side: 'debit', ratio: 0.25 },
      { account: '6540', type: 'business', side: 'debit', ratio: 0.25 },
    ]
    const tx = makeTransaction({ amount: -1000, amount_sek: -1000, currency: 'SEK', exchange_rate: 1 })
    const preview = computeProposalLines({
      amount: -1000, linePattern, templateDebitAccount: '5420', templateCreditAccount: '1930', chartVatTreatments: chart,
    })
    expect(preview.find((l) => l.account === '4531')?.amount).toBe(500)
    const template = makeCategorizationTemplate({ debit_account: '5420', credit_account: '1930', vat_treatment: null, line_pattern: linePattern })
    const engine = buildMappingResultFromCounterpartyTemplate({ template, matchMethod: 'exact_alias', confidence: 0.9 }, tx, 'aktiebolag')
    expect(previewShape(preview)).toEqual(engineShape(tx, engine, chart))
  })

  it('a learned line pattern with a cost line at 6 %: that share re-rated, the rest keeps the pair, as booked', () => {
    const chart = chartOf({ '6540': ['reverse_charge_non_eu_services', 0.06] })
    const linePattern: LinePatternEntry[] = [
      { account: '4531', type: 'business', side: 'debit', ratio: 0.5 },
      { account: '4598', type: 'business', side: 'credit', ratio: 0.5 },
      { account: '5420', type: 'business', side: 'debit', ratio: 0.25 },
      { account: '6540', type: 'business', side: 'debit', ratio: 0.25 },
    ]
    const tx = makeTransaction({ amount: -1000, amount_sek: -1000, currency: 'SEK', exchange_rate: 1 })
    const preview = computeProposalLines({
      amount: -1000, linePattern, templateDebitAccount: '5420', templateCreditAccount: '1930', chartVatTreatments: chart,
    })
    expect(preview.find((l) => l.account === '4531')?.amount).toBe(500)
    expect(preview.find((l) => l.account === '2634')?.amount).toBe(30)
    const template = makeCategorizationTemplate({ debit_account: '5420', credit_account: '1930', vat_treatment: null, line_pattern: linePattern })
    const engine = buildMappingResultFromCounterpartyTemplate({ template, matchMethod: 'exact_alias', confidence: 0.9 }, tx, 'aktiebolag')
    expect(previewShape(preview)).toEqual(engineShape(tx, engine, chart))
  })

  it('staticTemplateToFormLines hands the manual form no pair on a configured account', () => {
    const lines = staticTemplateToFormLines(
      getTemplateById('it_services_foreign')!, 2000, 'aktiebolag', chartOf({ '6540': 'reverse_charge_non_eu_services' }),
    )
    expect(lines.map((l) => l.account_number)).toEqual(['6540', '1930', '2645', '2614'])
  })
})

describe('proposalLinesToFormLines', () => {
  const lines: ProposalLine[] = [
    { side: 'debet', account: '5420', amount: 98.76 },
    { side: 'debet', account: '2641', amount: 24.69 },
    { side: 'kredit', account: '1930', amount: 123.45, settlement: true },
  ]

  it('maps sides to debit/credit strings with two-decimal formatting', () => {
    const formLines = proposalLinesToFormLines(lines)
    expect(formLines).toEqual([
      { account_number: '5420', debit_amount: '98.76', credit_amount: '', line_description: '' },
      { account_number: '2641', debit_amount: '24.69', credit_amount: '', line_description: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '123.45', line_description: '' },
    ])
  })

  it('formats whole amounts with trailing zeros', () => {
    const formLines = proposalLinesToFormLines([{ side: 'debet', account: '6212', amount: 100 }])
    expect(formLines[0].debit_amount).toBe('100.00')
  })

  it('swaps a literal-1930 settlement leg to the resolved cash account', () => {
    const formLines = proposalLinesToFormLines(lines, { settlementAccount: '1932' })
    expect(formLines[2].account_number).toBe('1932')
    // Non-settlement legs are never swapped
    expect(formLines[0].account_number).toBe('5420')
  })

  it('swaps a learned 19xx settlement leg to the resolved cash account (applySettlementAccount parity, crm#1046)', () => {
    // A counterparty template learned on another of the company's cash
    // accounts: the engine books the bank leg on the transaction's own ledger.
    const learned: ProposalLine[] = [
      { side: 'debet', account: '6570', amount: 5.48 },
      { side: 'kredit', account: '1934', amount: 5.48, settlement: true },
    ]
    const formLines = proposalLinesToFormLines(learned, { settlementAccount: '1932' })
    expect(formLines[1].account_number).toBe('1932')
    expect(formLines[0].account_number).toBe('6570')
  })

  it('never rewrites a learned non-cash settlement leg (applySettlementAccount parity)', () => {
    // A legacy counterparty template can settle against 2440 (payables):
    // the engine's applySettlementAccount moves only a cash-ledger bank leg,
    // so the prefill must keep the learned account too.
    const learned: ProposalLine[] = [
      { side: 'debet', account: '6212', amount: 100 },
      { side: 'kredit', account: '2440', amount: 100, settlement: true },
    ]
    const formLines = proposalLinesToFormLines(learned, { settlementAccount: '1932' })
    expect(formLines[1].account_number).toBe('2440')
  })

  it('stamps currency metadata on the settlement leg only', () => {
    const formLines = proposalLinesToFormLines(lines, {
      settlementAccount: '1930',
      currency: 'EUR',
      foreignAmount: 10.5,
      exchangeRate: 11.7571,
    })
    expect(formLines[2]).toMatchObject({
      account_number: '1930',
      currency: 'EUR',
      amount_in_currency: 10.5,
      exchange_rate: 11.7571,
    })
    expect(formLines[0]).not.toHaveProperty('currency')
    expect(formLines[1]).not.toHaveProperty('currency')
  })

  it('adds no currency metadata for SEK transactions', () => {
    const formLines = proposalLinesToFormLines(lines, { settlementAccount: '1930', currency: 'SEK' })
    expect(formLines[2]).not.toHaveProperty('currency')
    expect(formLines[2]).not.toHaveProperty('amount_in_currency')
  })

  it('round-trips a computed proposal into balanced form lines', () => {
    const computed = computeProposalLines({
      amount: -123.45,
      category: 'expense_software',
      vatTreatment: 'standard_25',
    })
    const formLines = proposalLinesToFormLines(computed, { settlementAccount: '1932' })
    const debits = formLines.reduce((s, l) => s + (l.debit_amount ? Number(l.debit_amount) : 0), 0)
    const credits = formLines.reduce((s, l) => s + (l.credit_amount ? Number(l.credit_amount) : 0), 0)
    expect(roundOre(debits)).toBe(roundOre(credits))
  })
})

describe('vatAmountSek: the underlag\'s moms over the rate', () => {
  it('moves the difference between the VAT leg and the net leg, keeping the gross', () => {
    const base = computeProposalLines({ amount: -546, category: 'expense_representation', vatTreatment: 'reduced_12', entityType: 'aktiebolag' })
    const vatLeg = base.find((l) => l.side === 'debet' && l.account.startsWith('264'))
    expect(vatLeg?.amount).toBe(58.5)
    const lines = computeProposalLines({ amount: -546, category: 'expense_representation', vatTreatment: 'reduced_12', entityType: 'aktiebolag', vatAmountSek: 73.17 })
    expect(lines.find((l) => l.side === 'debet' && l.account.startsWith('264'))?.amount).toBe(73.17)
    expect(lines.find((l) => l.side === 'debet' && !l.account.startsWith('264'))?.amount).toBe(472.83)
    expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
    expect(sumSide(lines, 'kredit')).toBe(546)
  })

  it('leaves lines without a rate-based VAT leg alone', () => {
    const lines: ProposalLine[] = [
      { side: 'debet', account: '5420', amount: 100 },
      { side: 'kredit', account: '1930', amount: 100, settlement: true },
      { side: 'debet', account: '2645', amount: 25 },
      { side: 'kredit', account: '2614', amount: 25 },
    ]
    expect(applyVatAmountToLines(lines, 10, true)).toBe(lines)
    expect(applyVatAmountToLines(lines, 0, true)).toBe(lines)
  })

  it('refuses a moms that would eat the whole net', () => {
    const lines: ProposalLine[] = [
      { side: 'debet', account: '6071', amount: 487.5 },
      { side: 'debet', account: '2641', amount: 58.5 },
      { side: 'kredit', account: '1930', amount: 546, settlement: true },
    ]
    expect(applyVatAmountToLines(lines, 546, true)).toBe(lines)
  })
})

describe('staticTemplateToFormLines', () => {
  const sum = (lines: { debit_amount: string; credit_amount: string }[], side: 'debit_amount' | 'credit_amount') =>
    roundOre(lines.reduce((acc, l) => acc + (parseFloat(l[side]) || 0), 0))

  it('books an expense template with its VAT out of the total, balanced', () => {
    const lines = staticTemplateToFormLines(getTemplateById('travel_transport')!, 376, 'aktiebolag', chartOf())
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['5810', '354.72', ''],
      ['2641', '21.28', ''],
      ['1930', '', '376.00'],
    ])
    expect(sum(lines, 'debit_amount')).toBe(sum(lines, 'credit_amount'))
  })

  it('books an income template as money in', () => {
    const lines = staticTemplateToFormLines(getTemplateById('revenue_standard_25')!, 1250, 'aktiebolag', chartOf())
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe('1250.00')
    expect(lines.find((l) => l.account_number === '3001')?.credit_amount).toBe('1000.00')
    expect(lines.find((l) => l.account_number === '2611')?.credit_amount).toBe('250.00')
  })

  it('books a transfer template as its two legs, no VAT', () => {
    expect(staticTemplateToFormLines(getTemplateById('financial_tax_account')!, 5000, 'aktiebolag', chartOf())).toEqual([
      { account_number: '1630', debit_amount: '5000.00', credit_amount: '', line_description: '' },
      { account_number: '1930', debit_amount: '', credit_amount: '5000.00', line_description: '' },
    ])
  })

  it('returns nothing for a non-positive total', () => {
    expect(staticTemplateToFormLines(getTemplateById('travel_transport')!, 0, undefined, chartOf())).toEqual([])
  })
})
