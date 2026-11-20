import { describe, expect, it } from 'vitest'
import {
  planSettlementVoucher,
  type CollectedCapitalInput,
  type SettlementLineInput,
  type SettlementPlanInput,
} from '../settlement-posting'

const CASE_A = 'case-a'
const CASE_B1 = 'case-b1'
const CASE_B2 = 'case-b2'

function line(overrides: Partial<SettlementLineInput> & Pick<SettlementLineInput, 'kind' | 'amount'>): SettlementLineInput {
  return {
    position: 0,
    inPayout: overrides.kind !== 'informational',
    recipient: 'creditor',
    taxAmount: 0,
    caseIds: [],
    chosen: null,
    ...overrides,
  }
}

function collected(overrides: Partial<CollectedCapitalInput> & Pick<CollectedCapitalInput, 'id' | 'caseId' | 'capitalPaid'>): CollectedCapitalInput {
  return { status: 'booked', paidAt: '2026-09-27', settlementId: null, ...overrides }
}

function input(overrides: Partial<SettlementPlanInput> = {}): SettlementPlanInput {
  return {
    settlementId: 'stl-1',
    amount: 843.75,
    currency: 'SEK',
    paymentDate: '2026-10-01',
    providerStatusOk: true,
    lines: [
      line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
      line({ position: 1, kind: 'agency_commission', amount: 125, taxAmount: 31.25, recipient: 'agency' }),
      line({ position: 2, kind: 'agency_fee_vat', amount: 31.25, recipient: 'agency' }),
    ],
    collected: [collected({ id: 'c1', caseId: CASE_A, capitalPaid: 1000 })],
    clearingAccount: '1689',
    payoutAccount: '1930',
    vatRegistered: true,
    vatInvoiceAccepted: true,
    ...overrides,
  }
}

function lineSummary(plan: ReturnType<typeof planSettlementVoucher>) {
  if (!plan.ok) throw new Error(`expected a plan, got ${plan.reason}`)
  return plan.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
}

function balanced(plan: ReturnType<typeof planSettlementVoucher>): boolean {
  if (!plan.ok) return false
  const debit = plan.lines.reduce((s, l) => s + Math.round(l.debit_amount * 100), 0)
  const credit = plan.lines.reduce((s, l) => s + Math.round(l.credit_amount * 100), 0)
  return debit === credit && debit > 0
}

describe('planSettlementVoucher', () => {
  it('books the payout against the clearing account, the commission and the VAT line once', () => {
    const plan = planSettlementVoucher(input())
    expect(lineSummary(plan)).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['2641', 31.25, 0],
    ])
    expect(balanced(plan)).toBe(true)
    expect(plan.ok && plan.settles).toEqual(['c1'])
  })

  it('books the VAT on the fee line itself when the settlement has no VAT line', () => {
    const plan = planSettlementVoucher(
      input({
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'agency_commission', amount: 125, taxAmount: 31.25, recipient: 'agency' }),
        ],
      }),
    )
    expect(lineSummary(plan)).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['2641', 31.25, 0],
    ])
    expect(balanced(plan)).toBe(true)
  })

  it('leaves the VAT to a person while the settlement is not accepted as a VAT invoice, and books the choice', () => {
    const blocked = planSettlementVoucher(input({ vatInvoiceAccepted: false }))
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.reason).toBe('vat_unconfirmed')
    expect(blocked.issues).toEqual([{ reason: 'vat_unconfirmed', position: 2 }])
    expect(blocked.lineAccounts.find((l) => l.position === 2)).toMatchObject({ account: null, suggestedAccount: '2641' })

    const lines = input().lines.map((l) => (l.position === 2 ? { ...l, chosen: { account: '6062', vatAccount: null } } : l))
    const chosen = planSettlementVoucher(input({ vatInvoiceAccepted: false, lines }))
    expect(lineSummary(chosen)).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['6062', 31.25, 0],
    ])
  })

  it('asks for the VAT account of a fee line with VAT on it, and books the choice next to the fee', () => {
    const lines = [
      line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
      line({ position: 1, kind: 'fee_charged_to_creditor', amount: 125, taxAmount: 31.25, recipient: 'agency' }),
    ]
    const blocked = planSettlementVoucher(input({ vatInvoiceAccepted: false, lines }))
    expect(!blocked.ok && blocked.issues).toEqual([{ reason: 'vat_unconfirmed', position: 1 }])
    const chosen = planSettlementVoucher(
      input({ vatInvoiceAccepted: false, lines: lines.map((l) => (l.position === 1 ? { ...l, chosen: { account: null, vatAccount: '2641' } } : l)) }),
    )
    expect(lineSummary(chosen)).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['2641', 31.25, 0],
    ])
  })

  it('drafts the voucher a payout held only by the VAT choice will book, and the choice completes it', () => {
    const blocked = planSettlementVoucher(input({ vatInvoiceAccepted: false }))
    if (blocked.ok) throw new Error('expected the VAT to wait for a person')
    expect(blocked.draft).toEqual([
      { account: '1930', waitsFor: null, debit: 843.75, credit: 0 },
      { account: '1689', waitsFor: null, debit: 0, credit: 1000 },
      { account: '6062', waitsFor: null, debit: 125, credit: 0 },
      { account: null, waitsFor: { position: 2, field: 'account' }, debit: 31.25, credit: 0 },
    ])
    // Filling the waiting row with the choice gives the voucher the planner books for that choice.
    const lines = input().lines.map((l) => (l.position === 2 ? { ...l, chosen: { account: '6062', vatAccount: null } } : l))
    const chosen = planSettlementVoucher(input({ vatInvoiceAccepted: false, lines }))
    expect(blocked.draft!.map((row) => [row.account ?? '6062', row.debit, row.credit])).toEqual(lineSummary(chosen))
  })

  it('drafts the VAT row of a fee line as waiting for its own VAT account', () => {
    const lines = [
      line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
      line({ position: 1, kind: 'fee_charged_to_creditor', amount: 125, taxAmount: 31.25, recipient: 'agency' }),
    ]
    const blocked = planSettlementVoucher(input({ vatInvoiceAccepted: false, lines }))
    expect(!blocked.ok && blocked.draft?.[3]).toEqual({ account: null, waitsFor: { position: 1, field: 'vatAccount' }, debit: 31.25, credit: 0 })
  })

  it('drafts nothing while anything but a person\'s account choice holds the payout', () => {
    const plan = planSettlementVoucher(input({ vatInvoiceAccepted: false, amount: 900 }))
    expect(!plan.ok && plan.reason).toBe('vat_unconfirmed')
    expect(!plan.ok && plan.draft).toBeNull()
    const negative = planSettlementVoucher(
      input({ lines: [...input().lines, line({ position: 3, kind: 'unknown', amount: -5, recipient: 'agency' })] }),
    )
    expect(!negative.ok && negative.draft).toBeNull()
  })

  it('books the VAT as cost for a company that is not VAT-registered', () => {
    const plan = planSettlementVoucher(input({ vatRegistered: false, vatInvoiceAccepted: false }))
    expect(lineSummary(plan)).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['6062', 31.25, 0],
    ])
  })

  // Build spec 4.3, one row per kind: the line posts to its account on its side.
  it.each([
    ['interest_to_creditor', '8313', 'credit'],
    ['fee_to_creditor', '3990', 'credit'],
    ['cost_refund_to_creditor', '6062', 'credit'],
    ['agency_commission', '6062', 'debit'],
    ['fee_charged_to_creditor', '6062', 'debit'],
    ['court_fee', '6062', 'debit'],
    ['supplier_invoice_setoff', '2440', 'debit'],
    ['excess_direct_payment', '2890', 'debit'],
  ] as const)('%s posts to %s as a %s', (kind, account, side) => {
    const amount = side === 'credit' ? 1050 : 950
    const plan = planSettlementVoucher(
      input({
        amount,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind, amount: 50, recipient: side === 'credit' ? 'creditor' : 'agency' }),
        ],
      }),
    )
    expect(lineSummary(plan)).toEqual([
      ['1930', amount, 0],
      ['1689', 0, 1000],
      [account, side === 'debit' ? 50 : 0, side === 'credit' ? 50 : 0],
    ])
    expect(balanced(plan)).toBe(true)
  })

  it('never books informational lines or lines outside the payout', () => {
    const plan = planSettlementVoucher(
      input({
        amount: 1000,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'informational', amount: 42.17, recipient: 'agency' }),
          line({ position: 2, kind: 'fee_to_creditor', amount: 60, inPayout: false }),
        ],
      }),
    )
    expect(lineSummary(plan)).toEqual([
      ['1930', 1000, 0],
      ['1689', 0, 1000],
    ])
    expect(plan.lineAccounts.map((l) => l.booked)).toEqual([true, false, false])
  })

  it('needs a person for an unknown line; a chosen account books on the side of its recipient', () => {
    const lines = [
      line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
      line({ position: 1, kind: 'unknown', amount: 10, recipient: 'tax_authority' }),
    ]
    const blocked = planSettlementVoucher(input({ amount: 990, lines }))
    expect(!blocked.ok && blocked.reason).toBe('unknown_line')
    const chosen = planSettlementVoucher(
      input({ amount: 990, lines: lines.map((l) => (l.position === 1 ? { ...l, chosen: { account: '6990', vatAccount: null } } : l)) }),
    )
    expect(lineSummary(chosen)).toEqual([
      ['1930', 990, 0],
      ['1689', 0, 1000],
      ['6990', 10, 0],
    ])
  })

  it('refuses a VAT amount on a kind that carries no VAT', () => {
    const plan = planSettlementVoucher(
      input({
        amount: 700,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'court_fee', amount: 300, taxAmount: 75, recipient: 'enforcement_authority' }),
        ],
      }),
    )
    expect(!plan.ok && plan.issues).toEqual([{ reason: 'vat_on_line_without_vat', position: 1 }])
  })

  it('refuses a payout that differs from its lines by one öre', () => {
    const plan = planSettlementVoucher(input({ amount: 843.76 }))
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('unbalanced')
    expect(plan.details).toMatchObject({ linesTotal: 843.75, amount: 843.76, difference: 0.01 })
  })

  it('refuses a settlement the provider marks as not valid, in another currency, or paying out nothing', () => {
    expect(planSettlementVoucher(input({ providerStatusOk: false }))).toMatchObject({ ok: false, reason: 'provider_status' })
    expect(planSettlementVoucher(input({ currency: 'EUR' }))).toMatchObject({ ok: false, reason: 'currency' })
    expect(planSettlementVoucher(input({ amount: 0 }))).toMatchObject({ ok: false, reason: 'non_positive_payout' })
  })

  it('books a deducted kind the provider credits back (a negative amount) on the credit side', () => {
    const plan = planSettlementVoucher(
      input({
        amount: 1125,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'agency_commission', amount: -125, recipient: 'agency' }),
        ],
      }),
    )
    expect(lineSummary(plan)).toEqual([
      ['1930', 1125, 0],
      ['1689', 0, 1000],
      ['6062', 0, 125],
    ])
    expect(balanced(plan)).toBe(true)
  })

  it('books two lines of one kind each on its own side: a VAT debit and a VAT credit', () => {
    const plan = planSettlementVoucher(
      input({
        amount: 865,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'agency_commission', amount: 100, recipient: 'agency' }),
          line({ position: 2, kind: 'agency_fee_vat', amount: 50, recipient: 'agency' }),
          line({ position: 3, kind: 'agency_fee_vat', amount: -15, recipient: 'agency' }),
          line({ position: 4, kind: 'informational', amount: 865 }),
        ],
      }),
    )
    expect(lineSummary(plan)).toEqual([
      ['1930', 865, 0],
      ['1689', 0, 1000],
      ['6062', 100, 0],
      ['2641', 50, 0],
      ['2641', 0, 15],
    ])
    expect(balanced(plan)).toBe(true)
  })

  it('refuses a negative amount on a kind paid to the company, and negative VAT (no confirmed meaning)', () => {
    const negativeRefund = planSettlementVoucher(
      input({
        amount: 950,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'cost_refund_to_creditor', amount: -50 }),
        ],
      }),
    )
    expect(!negativeRefund.ok && negativeRefund.issues).toContainEqual({ reason: 'unknown_line', position: 1 })
    expect(!negativeRefund.ok && negativeRefund.draft).toBeNull()
    const negativeVat = planSettlementVoucher(
      input({
        amount: 1156.25,
        lines: [
          line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
          line({ position: 1, kind: 'agency_commission', amount: -125, taxAmount: -31.25, recipient: 'agency' }),
        ],
      }),
    )
    expect(!negativeVat.ok && negativeVat.issues).toContainEqual({ reason: 'unknown_line', position: 1 })
  })

  it('leaves a VAT line the payout carries no fee for to a person, for every company and even when the VAT invoice is accepted', () => {
    const lines = [
      line({ position: 0, kind: 'principal', amount: 1900, caseIds: [CASE_A] }),
      line({ position: 1, kind: 'informational', amount: 1890 }),
      line({ position: 2, kind: 'agency_fee_vat', amount: 50, recipient: 'agency' }),
      line({ position: 3, kind: 'agency_fee_vat', amount: -40, recipient: 'agency' }),
    ]
    const collectedA = [collected({ id: 'c1', caseId: CASE_A, capitalPaid: 1900 })]
    for (const [vatRegistered, suggested] of [
      [true, '2641'],
      [false, '6062'],
    ] as const) {
      for (const vatInvoiceAccepted of [true, false]) {
        const plan = planSettlementVoucher(input({ amount: 1890, lines, collected: collectedA, vatRegistered, vatInvoiceAccepted }))
        expect(plan.ok).toBe(false)
        if (plan.ok) continue
        expect(plan.issues).toEqual([
          { reason: 'vat_unconfirmed', position: 2 },
          { reason: 'vat_unconfirmed', position: 3 },
        ])
        expect(plan.lineAccounts[2]).toMatchObject({ account: null, suggestedAccount: suggested })
      }
    }
    const chosen = planSettlementVoucher(
      input({
        amount: 1890,
        collected: collectedA,
        vatRegistered: false,
        lines: lines.map((l) => (l.kind === 'agency_fee_vat' ? { ...l, chosen: { account: '6062', vatAccount: null } } : l)),
      }),
    )
    expect(lineSummary(chosen)).toEqual([
      ['1930', 1890, 0],
      ['1689', 0, 1900],
      ['6062', 50, 0],
      ['6062', 0, 40],
    ])
  })

  describe('per case', () => {
    it('needs the case of every principal line', () => {
      const plan = planSettlementVoucher(
        input({ lines: [line({ position: 0, kind: 'principal', amount: 1000, caseIds: [] })], amount: 1000 }),
      )
      expect(plan).toMatchObject({ ok: false, reason: 'unknown_case' })
    })

    it('waits for a collected payment that is not booked yet', () => {
      const plan = planSettlementVoucher(input({ collected: [collected({ id: 'c1', caseId: CASE_A, capitalPaid: 1000, status: 'pending' })] }))
      expect(plan).toMatchObject({ ok: false, reason: 'collected_payment_unbooked' })
    })

    it('refuses a principal the booked collected payments do not add up to', () => {
      const plan = planSettlementVoucher(input({ collected: [collected({ id: 'c1', caseId: CASE_A, capitalPaid: 900 })] }))
      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.reason).toBe('case_mismatch')
      expect(plan.details.caseMismatch).toEqual([{ caseIds: [CASE_A], principal: 1000, available: 900 }])
    })

    it('settles the first payments in payment order, leaving a later one for the next payout', () => {
      const plan = planSettlementVoucher(
        input({
          collected: [
            collected({ id: 'c3', caseId: CASE_A, capitalPaid: 200, paidAt: '2026-09-29' }),
            collected({ id: 'c1', caseId: CASE_A, capitalPaid: 400, paidAt: '2026-09-20' }),
            collected({ id: 'c2', caseId: CASE_A, capitalPaid: 600, paidAt: '2026-09-25' }),
          ],
        }),
      )
      expect(plan.ok && plan.settles).toEqual(['c1', 'c2'])
    })

    it('leaves out payments another payout already settled and payments made after the payout', () => {
      const plan = planSettlementVoucher(
        input({
          collected: [
            collected({ id: 'old', caseId: CASE_A, capitalPaid: 1000, settlementId: 'stl-0' }),
            collected({ id: 'late', caseId: CASE_A, capitalPaid: 1000, paidAt: '2026-10-02' }),
          ],
        }),
      )
      expect(plan).toMatchObject({ ok: false, reason: 'case_mismatch' })
      // A payment this payout already claimed stays claimable (re-planning is idempotent).
      const again = planSettlementVoucher(input({ collected: [collected({ id: 'c1', caseId: CASE_A, capitalPaid: 1000, settlementId: 'stl-1' })] }))
      expect(again.ok && again.settles).toEqual(['c1'])
    })

    it('matches a line on merged cases against the payments of all of them', () => {
      const plan = planSettlementVoucher(
        input({
          amount: 800,
          lines: [line({ position: 0, kind: 'principal', amount: 800, caseIds: [CASE_B2, CASE_B1] })],
          collected: [
            collected({ id: 'b1', caseId: CASE_B1, capitalPaid: 300 }),
            collected({ id: 'b2', caseId: CASE_B2, capitalPaid: 500 }),
            collected({ id: 'a', caseId: CASE_A, capitalPaid: 800 }),
          ],
        }),
      )
      expect(plan.ok && [...plan.settles].sort()).toEqual(['b1', 'b2'])
    })

    it('never counts one collected payment for two lines (a case on its own line and inside a merged line)', () => {
      const plan = planSettlementVoucher(
        input({
          amount: 2000,
          lines: [
            line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
            line({ position: 1, kind: 'principal', amount: 1000, caseIds: [CASE_A, CASE_B1] }),
          ],
          // Only 1000 was collected in all: the clearing account must not be credited 2000.
          collected: [collected({ id: 'a', caseId: CASE_A, capitalPaid: 1000 }), collected({ id: 'b', caseId: CASE_B1, capitalPaid: 0.01, status: 'pending' })],
        }),
      )
      expect(plan).toMatchObject({ ok: false })
      expect(!plan.ok && plan.issues.map((i) => i.position)).toEqual([1])

      const enough = planSettlementVoucher(
        input({
          amount: 2000,
          lines: [
            line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
            line({ position: 1, kind: 'principal', amount: 1000, caseIds: [CASE_A, CASE_B1] }),
          ],
          collected: [
            collected({ id: 'a1', caseId: CASE_A, capitalPaid: 1000, paidAt: '2026-09-20' }),
            collected({ id: 'a2', caseId: CASE_A, capitalPaid: 400, paidAt: '2026-09-21' }),
            collected({ id: 'b', caseId: CASE_B1, capitalPaid: 600, paidAt: '2026-09-22' }),
          ],
        }),
      )
      expect(enough.ok && [...enough.settles].sort()).toEqual(['a1', 'a2', 'b'])
    })

    it('reconciles each case on its own', () => {
      const plan = planSettlementVoucher(
        input({
          amount: 1500,
          lines: [
            line({ position: 0, kind: 'principal', amount: 1000, caseIds: [CASE_A] }),
            line({ position: 1, kind: 'principal', amount: 500, caseIds: [CASE_B1] }),
          ],
          // The sums agree in total but not per case.
          collected: [collected({ id: 'a', caseId: CASE_A, capitalPaid: 1100 }), collected({ id: 'b', caseId: CASE_B1, capitalPaid: 400 })],
        }),
      )
      expect(plan).toMatchObject({ ok: false, reason: 'case_mismatch' })
      expect(!plan.ok && plan.issues.map((i) => i.position)).toEqual([0, 1])
    })
  })
})
