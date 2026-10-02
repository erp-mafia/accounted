import { describe, it, expect } from 'vitest'
import type { Invoice, InvoiceItem } from '@/types'
import { makeInvoice } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { evaluateGronTeknikClaim } from '@/lib/invoices/gron-teknik-claim'

/**
 * evaluateGronTeknikClaim: what a grön teknik payout claim for one invoice
 * is, per Skatteverket's Begaran V1 schema and its example file
 * (gron_teknik_exempel.xml: Kostnad 50 000 SOLCELLER gives BegartBelopp 7 500
 * and BetaltBelopp 42 500; Kostnad 20 000 LADDPUNKT gives 10 000 and 10 000).
 */

// Synthetic test identity from Skatteverket's official example files.
const PNR = '199110306645'
const TODAY = '2026-09-30'

function line(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-labour',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Montage solceller',
    quantity: 1,
    unit: 'st',
    unit_price: 8000,
    line_total: 8000,
    vat_rate: 25,
    vat_amount: 2000,
    deduction_type: 'gron_teknik',
    deduction_amount: 1500,
    labor_hours: 20,
    work_type: 'INSTALLATION_SOLCELLER',
    housing_designation: 'Exempelby 1:1',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

/** Skatteverket's SOLCELLER ärende: labour + material = 50 000 incl. moms, 1 000 övrigt. */
function solarItems(): InvoiceItem[] {
  return [
    line(),
    line({
      id: 'item-material',
      sort_order: 1,
      description: 'Solpaneler och växelriktare',
      unit_price: 32000,
      line_total: 32000,
      vat_amount: 8000,
      deduction_amount: 6000,
      labor_hours: null,
    }),
    line({
      id: 'item-travel',
      sort_order: 2,
      description: 'Resa',
      unit_price: 800,
      line_total: 800,
      vat_amount: 200,
      deduction_type: null,
      deduction_amount: 0,
      labor_hours: null,
      work_type: null,
      housing_designation: null,
    }),
  ]
}

function gronInvoice(overrides: Partial<Invoice> = {}, items: InvoiceItem[] = solarItems()): Invoice {
  return makeInvoice({
    status: 'paid',
    paid_at: '2026-09-15T10:00:00Z',
    total: 51000,
    subtotal: 40800,
    vat_amount: 10200,
    deduction_total: 7500,
    paid_amount: 43500,
    deduction_personnummer_encrypted: encryptPersonnummer(PNR),
    deduction_personnummer_last4: PNR.slice(-4),
    items,
    ...overrides,
  })
}

describe('evaluateGronTeknikClaim', () => {
  it("matches Skatteverket's SOLCELLER example: kostnad 50 000, begärt 7 500, betalt 42 500", () => {
    const result = evaluateGronTeknikClaim(gronInvoice(), { today: TODAY })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      personnummer_last4: '6645',
      betalnings_datum: '2026-09-15',
      property: { fastighet: 'Exempelby 1:1' },
      ovrig_kostnad: 1000,
      begart_belopp: 7500,
      warnings: [],
    })
    expect(result.value.installations).toEqual([
      {
        work_type: 'INSTALLATION_SOLCELLER',
        label: 'Installation av solceller',
        antal_timmar: 20,
        kostnad: 50000,
        begart_belopp: 7500,
        betalt_belopp: 42500,
      },
    ])
  })

  it('gives one entry per installation type, in Skatteverket order (one ärende each)', () => {
    const items = [
      line({
        id: 'charger',
        work_type: 'INSTALLATION_LADDPUNKT',
        unit_price: 16000,
        line_total: 16000,
        vat_amount: 4000,
        deduction_amount: 10000,
        labor_hours: 20,
      }),
      ...solarItems(),
    ]
    const result = evaluateGronTeknikClaim(gronInvoice({ deduction_total: 17500 }, items), { today: TODAY })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.installations.map((i) => [i.work_type, i.kostnad, i.begart_belopp, i.betalt_belopp])).toEqual([
      ['INSTALLATION_SOLCELLER', 50000, 7500, 42500],
      ['INSTALLATION_LADDPUNKT', 20000, 10000, 10000],
    ])
    expect(result.value.begart_belopp).toBe(17500)
  })

  it('truncates begärt to whole kronor and rounds kostnad to the nearest krona', () => {
    const items = [line({ unit_price: 8003.33, line_total: 8003.33, vat_amount: 2000.83, deduction_amount: 1500.62 })]
    const result = evaluateGronTeknikClaim(gronInvoice({ deduction_total: 1500.62 }, items), { today: TODAY })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.installations[0]).toMatchObject({ kostnad: 10004, begart_belopp: 1500, betalt_belopp: 8504 })
  })

  it('never requests more than the rate of the whole-krona kostnad', () => {
    // 33 333.49 kr incl. moms at 15 % books 5 000.02 on 1513, but the ärende
    // states kostnad 33 333, and 15 % of that is 4 999.95.
    const items = [line({ unit_price: 26666.79, line_total: 26666.79, vat_amount: 6666.7, deduction_amount: 5000.02 })]
    const result = evaluateGronTeknikClaim(gronInvoice({ deduction_total: 5000.02 }, items), { today: TODAY })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.installations[0]).toMatchObject({ kostnad: 33333, begart_belopp: 4999, betalt_belopp: 28334 })
    expect(result.value.begart_belopp).toBe(4999)
  })

  it('says the e-tjänst refuses a request above the ceiling, not that Skatteverket grants less', () => {
    const over = evaluateGronTeknikClaim(
      gronInvoice({ deduction_total: 60000 }, [
        line({ work_type: 'INSTALLATION_LAGRING', unit_price: 96000, line_total: 96000, vat_amount: 24000, deduction_amount: 60000 }),
      ]),
      { today: TODAY },
    )
    expect(over.ok).toBe(true)
    if (!over.ok) return
    expect(over.value.warnings[0]).toContain('e-tjänsten tar inte emot')
    expect(over.value.warnings[0]).not.toContain('beviljar')
  })

  it('reads a bostadsrätt as lägenhetsnummer plus the förening orgnr', () => {
    const items = solarItems().map((i) =>
      i.deduction_type ? { ...i, housing_designation: null, apartment_number: '1201', brf_org_number: '799900-0040' } : i,
    )
    const result = evaluateGronTeknikClaim(gronInvoice({}, items), { today: TODAY })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.property).toEqual({ lagenhetsNr: '1201', brfOrgNr: '167999000040' })
  })

  it('warns above the 50 000 kr ceiling and after the 31 January deadline', () => {
    const items = [line({ work_type: 'INSTALLATION_LAGRING', unit_price: 80000, line_total: 80000, vat_amount: 20000, deduction_amount: 50000.5 })]
    const result = evaluateGronTeknikClaim(
      gronInvoice({ deduction_total: 50000.5, paid_at: '2025-06-01T10:00:00Z' }, items),
      { today: TODAY },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.begart_belopp).toBe(50000)
    expect(result.value.warnings).toHaveLength(1)
    expect(result.value.warnings[0]).toContain('passerat sista dag')

    const over = evaluateGronTeknikClaim(
      gronInvoice({ deduction_total: 60000 }, [
        line({ work_type: 'INSTALLATION_LAGRING', unit_price: 96000, line_total: 96000, vat_amount: 24000, deduction_amount: 60000 }),
      ]),
      { today: TODAY },
    )
    expect(over.ok).toBe(true)
    if (!over.ok) return
    expect(over.value.warnings[0]).toContain('överstiger årsmaximum 50')
  })

  describe('blockers', () => {
    const blockerOf = (invoice: Invoice) => {
      const result = evaluateGronTeknikClaim(invoice, { today: TODAY })
      return result.ok ? null : result.blocker
    }

    it('points a ROT invoice at the ROT/RUT file instead of claiming it', () => {
      const rot = [line({ deduction_type: 'rot', work_type: 'BYGG' })]
      expect(blockerOf(gronInvoice({}, rot))).toMatchObject({ code: 'NO_DEDUCTION_OF_TYPE' })
      expect(blockerOf(gronInvoice({}, rot))?.message).toContain('ROT- eller RUT-fil')
    })

    it('refuses an invoice mixing grön teknik with ROT or RUT', () => {
      const items = [...solarItems(), line({ id: 'rut', deduction_type: 'rut', work_type: 'STAD' })]
      expect(blockerOf(gronInvoice({}, items))).toMatchObject({ code: 'MIXED_DEDUCTION_TYPES' })
    })

    it('waits for the customer share to be paid', () => {
      expect(blockerOf(gronInvoice({ status: 'sent', paid_at: null, paid_amount: 0 }))).toMatchObject({ code: 'NOT_PAID' })
    })

    it('needs the personnummer', () => {
      expect(blockerOf(gronInvoice({ deduction_personnummer_encrypted: null }))).toMatchObject({ code: 'MISSING_PERSONNUMMER' })
    })

    it('needs the property', () => {
      const items = solarItems().map((i) => ({ ...i, housing_designation: null }))
      expect(blockerOf(gronInvoice({}, items))).toMatchObject({ code: 'MISSING_PROPERTY' })
      expect(blockerOf(gronInvoice({}, items))?.message).toContain('Grön teknik kräver fastighetsbeteckning')
    })

    it('needs hours on at least one row of each installation type', () => {
      const items = solarItems().map((i) => ({ ...i, labor_hours: null }))
      expect(blockerOf(gronInvoice({}, items))).toMatchObject({ code: 'MISSING_HOURS' })
    })

    it('needs a valid installation type', () => {
      expect(blockerOf(gronInvoice({}, [line({ work_type: null })]))).toMatchObject({ code: 'MISSING_WORK_TYPE' })
      expect(blockerOf(gronInvoice({}, [line({ work_type: 'EL' })]))).toMatchObject({ code: 'INVALID_WORK_TYPE' })
    })

    it('refuses a refused share already booked back on the customer', () => {
      expect(blockerOf(gronInvoice({ deduction_reclaimed_total: 7500 }))).toMatchObject({ code: 'DEDUCTION_RECLAIMED' })
    })

    it('needs a booking rate on a foreign invoice', () => {
      expect(blockerOf(gronInvoice({ currency: 'EUR', exchange_rate: null }))).toMatchObject({ code: 'MISSING_EXCHANGE_RATE' })
    })

    it('has nothing to request when the deduction rounds to 0 kr', () => {
      const items = [line({ unit_price: 1, line_total: 1, vat_amount: 0.25, deduction_amount: 0.19 })]
      expect(blockerOf(gronInvoice({ deduction_total: 0.19 }, items))).toMatchObject({ code: 'ZERO_DEDUCTION' })
    })
  })
})
