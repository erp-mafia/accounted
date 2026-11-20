import { describe, expect, it } from 'vitest'
import type { CollectionsSettlement } from '@accounted/connect-contract'
import { roundOre, sumOre } from '@/lib/money'
import { planSettlementVoucher, type SettlementPlan, type SettlementPlanInput } from '../settlement-posting'
import { SAMPLE_MULTI_CLAIM_SETTLEMENT, SAMPLE_SETTLEMENTS } from './settlement-samples'

/**
 * The collections provider's test payouts of 2026-10-14 (settlement-samples.ts),
 * as Connect answers them, through the payout planner. The company is
 * VAT-registered on faktureringsmetoden, or not VAT-registered; the
 * settlement is not accepted as a VAT invoice (SETTLEMENT_VAT_INVOICE_ACCEPTED
 * is false, settlements.test.ts holds it there). Each case's capital was
 * booked as a collected payment (step C) before the payout.
 */

const COMPANIES = [
  { name: 'VAT-registered, faktureringsmetoden', vatRegistered: true, vatAccount: '2641' },
  { name: 'not VAT-registered', vatRegistered: false, vatAccount: '6062' },
] as const

type Choice = Record<number, string>

function caseId(caseRef: string): string {
  return `case-${caseRef}`
}

function planInput(settlement: CollectionsSettlement, vatRegistered: boolean, choices: Choice = {}): SettlementPlanInput {
  const principal = new Map<string, number>()
  for (const line of settlement.lines) {
    if (line.kind !== 'principal' || !line.caseRef) continue
    principal.set(line.caseRef, roundOre((principal.get(line.caseRef) ?? 0) + line.amount))
  }
  return {
    settlementId: `stl-${settlement.settlementRef}`,
    amount: settlement.amount,
    currency: settlement.currency,
    paymentDate: settlement.paymentDate,
    providerStatusOk: settlement.statusOk,
    lines: settlement.lines.map((line, position) => ({
      position,
      kind: line.kind,
      inPayout: line.inPayout,
      recipient: line.recipient,
      amount: line.amount,
      taxAmount: line.taxAmount,
      caseIds: line.caseRef ? [caseId(line.caseRef)] : [],
      chosen: choices[position] ? { account: choices[position], vatAccount: null } : null,
    })),
    collected: [...principal].map(([caseRef, capitalPaid]) => ({
      id: `collected-${caseRef}`,
      caseId: caseId(caseRef),
      status: 'booked' as const,
      capitalPaid,
      paidAt: '2026-10-08',
      settlementId: null,
    })),
    clearingAccount: '1689',
    payoutAccount: '1930',
    vatRegistered,
    vatInvoiceAccepted: false,
  }
}

function rows(plan: SettlementPlan): Array<[string, number, number]> {
  if (!plan.ok) throw new Error(`expected a voucher, got ${plan.reason}`)
  return plan.lines.map((line) => [line.account_number, line.debit_amount, line.credit_amount])
}

function balances(plan: SettlementPlan): boolean {
  if (!plan.ok) return false
  const debit = sumOre(plan.lines.map((line) => line.debit_amount))
  const credit = sumOre(plan.lines.map((line) => line.credit_amount))
  return debit === credit && debit > 0
}

function sumOf(settlement: CollectionsSettlement, kind: string): number {
  return sumOre(settlement.lines.filter((line) => line.kind === kind).map((line) => line.amount))
}

const positionsOf = (settlement: CollectionsSettlement, kind: string) =>
  settlement.lines.flatMap((line, position) => (line.kind === kind ? [position] : []))

const plain = SAMPLE_SETTLEMENTS.filter((settlement) => settlement.lines.every((line) => line.kind === 'principal' || line.kind === 'informational'))
const withVat = SAMPLE_SETTLEMENTS.filter((settlement) => settlement.lines.some((line) => line.kind === 'agency_fee_vat'))

describe('the provider test payouts of 2026-10-14 through the planner', () => {
  it('are nine: five of principal and payout only, four with the VAT pair (one also with a fee refund)', () => {
    expect(SAMPLE_SETTLEMENTS).toHaveLength(9)
    expect(plain.map((s) => s.settlementRef)).toEqual(['1000000216', '1000000217', '1000000218', '1000000219', '1000000224'])
    expect(withVat.map((s) => s.settlementRef)).toEqual(['1000000220', '1000000221', '1000000222', '1000000223'])
    for (const settlement of withVat) expect(settlement.lines.filter((l) => l.kind === 'agency_fee_vat').map((l) => l.amount)).toEqual([50, -40])
  })

  describe.each(COMPANIES)('$name', ({ vatRegistered, vatAccount }) => {
    it.each(plain.map((s) => [s.settlementRef, s] as const))('%s books on its own: Dr payout account = payout, Cr clearing = principal', (_ref, settlement) => {
      const plan = planSettlementVoucher(planInput(settlement, vatRegistered))
      expect(rows(plan)).toEqual([
        ['1930', settlement.amount, 0],
        ['1689', 0, sumOf(settlement, 'principal')],
      ])
      expect(balances(plan)).toBe(true)
      expect(plan.ok && plan.settles).toEqual([`collected-${settlement.lines[0]!.caseRef}`])
      // The payout line is shown, never booked.
      expect(plan.lineAccounts.map((l) => l.booked)).toEqual(settlement.lines.map((l) => l.kind !== 'informational'))
    })

    it.each(withVat.map((s) => [s.settlementRef, s] as const))('%s waits for a person to place the VAT pair, then books it as chosen', (_ref, settlement) => {
      const vatPositions = positionsOf(settlement, 'agency_fee_vat')
      const waiting = planSettlementVoucher(planInput(settlement, vatRegistered))
      expect(waiting.ok).toBe(false)
      if (waiting.ok) return
      // Nothing but the person's VAT choice holds it: the VAT lines are never booked on their own.
      expect(waiting.reason).toBe('vat_unconfirmed')
      expect(waiting.issues).toEqual(vatPositions.map((position) => ({ reason: 'vat_unconfirmed', position })))
      for (const position of vatPositions) {
        expect(waiting.lineAccounts[position]).toMatchObject({ account: null, suggestedAccount: vatAccount, booked: true })
      }
      expect(waiting.details).toMatchObject({ amount: settlement.amount, difference: 0 })

      // The voucher it will book, the VAT rows waiting: +50 a debit, -40 a credit.
      const refund = sumOf(settlement, 'cost_refund_to_creditor')
      expect(waiting.draft).toEqual([
        { account: '1930', waitsFor: null, debit: settlement.amount, credit: 0 },
        { account: '1689', waitsFor: null, debit: 0, credit: sumOf(settlement, 'principal') },
        ...(refund > 0 ? [{ account: '6062', waitsFor: null, debit: 0, credit: refund }] : []),
        { account: null, waitsFor: { position: vatPositions[0], field: 'account' }, debit: 50, credit: 0 },
        { account: null, waitsFor: { position: vatPositions[1], field: 'account' }, debit: 0, credit: 40 },
      ])

      const chosen = planSettlementVoucher(planInput(settlement, vatRegistered, Object.fromEntries(vatPositions.map((p) => [p, vatAccount]))))
      expect(rows(chosen)).toEqual([
        ['1930', settlement.amount, 0],
        ['1689', 0, sumOf(settlement, 'principal')],
        ...(refund > 0 ? [['6062', 0, refund] as [string, number, number]] : []),
        [vatAccount, 50, 0],
        [vatAccount, 0, 40],
      ])
      expect(balances(chosen)).toBe(true)
      expect(chosen.ok && chosen.settles).toEqual([`collected-${settlement.lines[0]!.caseRef}`])
    })
  })

  it('1000000222: the fees paid in advance come back as a credit to 6062', () => {
    const settlement = SAMPLE_SETTLEMENTS.find((s) => s.settlementRef === '1000000222')!
    const plan = planSettlementVoucher(planInput(settlement, true, { 3: '2641', 4: '2641' }))
    expect(rows(plan)).toEqual([
      ['1930', 7790, 0],
      ['1689', 0, 7500],
      ['6062', 0, 300],
      ['2641', 50, 0],
      ['2641', 0, 40],
    ])
  })
})

/**
 * 1000000225 (settlement-samples.ts): one payout over a merged case of three
 * of the company's invoices and two claims that are not the company's. The
 * company has a case per invoice it handed over (the claim id is the case's
 * provider reference) and booked the capital the provider collected on the
 * children as collected payments (step C). Each line's cases are found as
 * the import finds them (settlements.ts, settlementLineRows and
 * lineCaseIds): by the claim, else by the company's own invoice, else by
 * the original invoices, every one of which must be the company's.
 */
describe('the provider test payout over several claims (1000000225) through the planner', () => {
  const sample = SAMPLE_MULTI_CLAIM_SETTLEMENT
  const INVOICES = ['qa-settle-inv-20261014-11', 'qa-settle-inv-20261014-12', 'qa-settle-inv-20261014-13']
  /** The company's cases: provider reference (the claim) to case, and the invoice each is on. */
  const CASES = new Map([
    ['205627', { id: 'case-11', invoice: INVOICES[0]! }],
    ['205628', { id: 'case-12', invoice: INVOICES[1]! }],
    ['205629', { id: 'case-13', invoice: INVOICES[2]! }],
  ])
  const caseOfInvoice = (invoice: string) => [...CASES.values()].find((c) => c.invoice === invoice)?.id ?? null

  function caseIdsOf(line: CollectionsSettlement['lines'][number]): string[] {
    const own = line.invoiceRef && INVOICES.includes(line.invoiceRef) ? line.invoiceRef : null
    const byCase = (line.caseRef ? CASES.get(line.caseRef)?.id : null) ?? (own ? caseOfInvoice(own) : null)
    if (byCase) return [byCase]
    const cases = line.originalInvoiceRefs.filter((ref) => INVOICES.includes(ref)).map(caseOfInvoice)
    return cases.length > 0 && cases.every((c): c is string => c !== null) ? cases : []
  }

  function input(vatRegistered: boolean, choices: Choice = {}, extraCases: Record<string, number> = {}): SettlementPlanInput {
    return {
      ...planInput(sample, vatRegistered, choices),
      lines: sample.lines.map((line, position) => ({
        position,
        kind: line.kind,
        inPayout: line.inPayout,
        recipient: line.recipient,
        amount: line.amount,
        taxAmount: line.taxAmount,
        caseIds: line.caseRef && extraCases[line.caseRef] !== undefined ? [caseId(line.caseRef)] : caseIdsOf(line),
        chosen: choices[position] ? { account: choices[position], vatAccount: null } : null,
      })),
      collected: [
        { id: 'collected-13', caseId: 'case-13', status: 'booked' as const, capitalPaid: 2500, paidAt: '2026-10-08', settlementId: null },
        { id: 'collected-12', caseId: 'case-12', status: 'booked' as const, capitalPaid: 1500, paidAt: '2026-10-08', settlementId: null },
        ...Object.entries(extraCases).map(([caseRef, capitalPaid]) => ({
          id: `collected-${caseRef}`,
          caseId: caseId(caseRef),
          status: 'booked' as const,
          capitalPaid,
          paidAt: '2026-10-08',
          settlementId: null,
        })),
      ],
    }
  }

  it('is ten lines: capital on two of the merged invoices and on two claims that are not the company\'s, a refund, three payout lines, the VAT pair', () => {
    expect(sample.lines.map((l) => [l.kind, l.amount, l.inPayout])).toEqual([
      ['principal', 2500, true],
      ['principal', 1500, true],
      ['principal', 10000, true],
      ['principal', 1000, true],
      ['cost_refund_to_creditor', 300, true],
      ['informational', 3990, false],
      ['informational', 9990, false],
      ['informational', 1290, false],
      ['agency_fee_vat', 150, true],
      ['agency_fee_vat', -120, true],
    ])
    // The payout lines are the payout; the VAT pair is three times the one-invoice pair.
    expect(sumOf(sample, 'informational')).toBe(sample.amount)
    expect(sample.lines.map(caseIdsOf)).toEqual([
      ['case-13'],
      ['case-12'],
      [],
      [],
      [],
      ['case-11', 'case-12', 'case-13'],
      [],
      [],
      ['case-11', 'case-12', 'case-13'],
      ['case-11', 'case-12', 'case-13'],
    ])
  })

  describe.each(COMPANIES)('$name', ({ vatRegistered, vatAccount }) => {
    it('waits for a person: the capital of the two claims that are not the company\'s is never placed, and the VAT pair waits', () => {
      const plan = planSettlementVoucher(input(vatRegistered))
      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.reason).toBe('unknown_case')
      expect(plan.issues).toEqual([
        { reason: 'vat_unconfirmed', position: 8 },
        { reason: 'vat_unconfirmed', position: 9 },
        { reason: 'unknown_case', position: 2 },
        { reason: 'unknown_case', position: 3 },
      ])
      // The merged case's capital matches its booked collected payments; nothing else is held.
      expect(plan.details).toEqual({ linesTotal: 15270, amount: 15270, difference: 0 })
      // Not only a person's account choice holds it: no draft to fill in.
      expect(plan.draft).toBeNull()
      expect(plan.lineAccounts.map((l) => [l.position, l.account, l.suggestedAccount, l.booked])).toEqual([
        [0, '1689', null, true],
        [1, '1689', null, true],
        [2, '1689', null, true],
        [3, '1689', null, true],
        [4, '6062', null, true],
        [5, null, null, false],
        [6, null, null, false],
        [7, null, null, false],
        [8, null, vatAccount, true],
        [9, null, vatAccount, true],
      ])

      // A person's VAT choice does not place capital the company has no case for.
      const chosen = planSettlementVoucher(input(vatRegistered, { 8: vatAccount, 9: vatAccount }))
      expect(chosen.ok).toBe(false)
      if (chosen.ok) return
      expect(chosen.issues).toEqual([
        { reason: 'unknown_case', position: 2 },
        { reason: 'unknown_case', position: 3 },
      ])
    })

    it('were the two claims the company\'s own cases: one debit of the whole payout, the capital per case, the refund, the VAT pair as chosen', () => {
      const plan = planSettlementVoucher(input(vatRegistered, { 8: vatAccount, 9: vatAccount }, { '203834': 10000, '203835': 1000 }))
      // Three payout lines, one debit to the payout account for the whole payout.
      expect(rows(plan)).toEqual([
        ['1930', 15270, 0],
        ['1689', 0, 2500],
        ['1689', 0, 1500],
        ['1689', 0, 10000],
        ['1689', 0, 1000],
        ['6062', 0, 300],
        [vatAccount, 150, 0],
        [vatAccount, 0, 120],
      ])
      expect(balances(plan)).toBe(true)
      // Each invoice's capital clears its own collected payment.
      expect(plan.ok && plan.settles).toEqual(['collected-13', 'collected-12', 'collected-203834', 'collected-203835'])
    })
  })
})
