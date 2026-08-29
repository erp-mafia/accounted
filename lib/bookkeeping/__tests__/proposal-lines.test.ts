import { describe, it, expect } from 'vitest'
import { computeProposalLines, proposalLinesToFormLines, resolveTemplateAccountsForEntity } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import { buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type { LinePatternEntry } from '@/types'

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

    it('returns no lines without a category', () => {
      expect(computeProposalLines({ amount: -100 })).toEqual([])
    })

    it('balances 12% amounts that break independently-rounded net+VAT (skeptic counterexample)', () => {
      // 102.06 at 12%: rounding net and VAT separately gives 91.13 + 10.94 =
      // 102.07 (off by 1 ore). The engine computes VAT once (roundOre) and
      // derives the net by subtraction: 10.93 + 91.13 = 102.06.
      const lines = computeProposalLines({
        amount: -102.06,
        category: 'expense_representation', // maps to reduced_12 by default
      })
      expect(lines).toEqual([
        { side: 'debet', account: '6071', amount: 91.13 },
        { side: 'debet', account: '2641', amount: 10.93 },
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
    it('emits the 2645/2614 fiktiv-moms pair (no basbelopp) for a reverse-charge pair', () => {
      // Engine books D 6540 / K 1930 / D 2645 / K 2614 for a learned RC
      // counterparty (legacy path); the prefill dropping the pair would book
      // an RC expense without fiktiv moms (ruta 30/48 understated).
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
      ])
      expect(sumSide(lines, 'debet')).toBe(sumSide(lines, 'kredit'))
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
      // and applySettlementAccount never rewrites a non-1930 leg. The prefill
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

  it('never rewrites a learned non-1930 settlement leg (applySettlementAccount parity)', () => {
    // A legacy counterparty template can settle against 2440 (payables):
    // the engine's applySettlementAccount substitutes only the literal 1930
    // default, so the prefill must keep the learned account too.
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
