import { describe, it, expect } from 'vitest'
import { mapVismaToSalesInvoice } from '../mapper'

/**
 * Visma eAccounting invoices with a RUT, ROT or grön teknik deduction were
 * imported without it. The fixtures follow CustomerInvoiceApi and
 * CustomerInvoiceRowApi in Visma's published OpenAPI: no live payload with a
 * deduction has been seen.
 */

function salesRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 's1',
    InvoiceNumber: '10060',
    InvoiceDate: '2026-07-24',
    DueDate: '2026-08-10',
    CurrencyCode: 'SEK',
    TotalAmount: 2500,
    TotalVatAmount: 500,
    InvoiceCustomerName: 'Anna Andersson',
    Rows: [],
    ...over,
  }
}

const rutRows = [
  {
    LineNumber: 1,
    Text: 'Hemstädning',
    Quantity: 4,
    UnitPrice: 400,
    AmountNoVat: 1600,
    PercentVat: 0.25,
    IsWorkCost: true,
    WorkCostType: 9,
    WorkHours: 4,
    IsTextRow: false,
  },
  {
    LineNumber: 2,
    Text: 'Städmaterial',
    Quantity: 1,
    UnitPrice: 400,
    AmountNoVat: 400,
    PercentVat: 0.25,
    IsWorkCost: false,
    WorkCostType: 0,
    MaterialCosts: 400,
    IsTextRow: false,
  },
  { LineNumber: 3, Text: 'Utfört 2026-07-20', IsTextRow: true, IsWorkCost: true, WorkCostType: 9 },
]

function rutInvoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return salesRaw({
    RotReducedInvoicingType: 2,
    RotReducedInvoicingAmount: 1000,
    Persons: [{ Id: 'p1', Ssn: '197001011234', Amount: 1000 }],
    TaxDeductionStatus: 1,
    Rows: rutRows,
    ...over,
  })
}

describe('mapVismaToSalesInvoice: RUT invoice', () => {
  it('carries the deduction, the buyer and the provider state', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice())
    expect(dto.householdDeduction).toEqual({
      kind: 'rut',
      amount: 1000,
      buyers: [{ personnummer: '197001011234', amount: 1000 }],
      providerState: 'open',
    })
  })

  it('marks the work row with STAD and its hours', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice())
    expect(dto.lines[0].householdWork).toEqual({ workType: 'STAD', providerWorkType: '9', hours: 4 })
  })

  it('leaves the material row and the text row without householdWork', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice())
    expect(dto.lines[1].householdWork).toBeUndefined()
    expect(dto.lines[2].householdWork).toBeUndefined()
  })

  it('leaves the rest of the mapping as it was', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice())
    expect(dto.lines[0].lineExtensionAmount.value).toBe(1600)
    expect(dto.legalMonetaryTotal.payableAmount.value).toBe(2500)
    expect(dto.lines).toHaveLength(3)
  })

  it('reads hours and material on a work row when both are stated', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      Rows: [{ LineNumber: 1, AmountNoVat: 1600, IsWorkCost: true, WorkCostType: 13, WorkHours: 3.5, MaterialCosts: 120 }],
    }))
    expect(dto.lines[0].householdWork).toEqual({
      workType: 'TRADGARD',
      providerWorkType: '13',
      hours: 3.5,
      materialCost: 120,
    })
  })

  it('keeps a work row whose type has no Skatteverket element, with a null workType', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      RotReducedInvoicingType: 1,
      Rows: [{ LineNumber: 1, AmountNoVat: 8000, IsWorkCost: true, WorkCostType: 20, WorkHours: 6 }],
    }))
    expect(dto.lines[0].householdWork).toEqual({ workType: null, providerWorkType: '20', hours: 6 })
  })

  it('gives no householdWork to an IsWorkCost row with WorkCostType None', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      Rows: [{ LineNumber: 1, AmountNoVat: 1600, IsWorkCost: true, WorkCostType: 0 }],
    }))
    expect(dto.lines[0].householdWork).toBeUndefined()
  })
})

describe('mapVismaToSalesInvoice: ROT apartment invoice', () => {
  it('carries the lägenhet, the förening orgnr and the property type', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({
      TotalAmount: 50000,
      RotReducedInvoicingType: 1,
      RotReducedInvoicingAmount: 9000,
      RotReducedInvoicingPropertyName: '1102',
      RotReducedInvoicingOrgNumber: '769600-1234',
      RotPropertyType: 1,
      Persons: [
        { Id: 'p1', Ssn: '197001011234', Amount: 4500 },
        { Id: 'p2', Ssn: '197202022345', Amount: 4500 },
      ],
      TaxDeductionStatus: 2,
      Rows: [{ LineNumber: 1, AmountNoVat: 30000, IsWorkCost: true, WorkCostType: 6, WorkHours: 50 }],
    }))
    expect(dto.householdDeduction).toEqual({
      kind: 'rot',
      amount: 9000,
      buyers: [
        { personnummer: '197001011234', amount: 4500 },
        { personnummer: '197202022345', amount: 4500 },
      ],
      property: { designation: '1102', brfOrgNumber: '769600-1234', type: 'apartment' },
      providerState: 'requested',
    })
    expect(dto.lines[0].householdWork).toEqual({ workType: 'MALNING', providerWorkType: '6', hours: 50 })
  })

  it('reads RotPropertyType 2 as a property with its fastighetsbeteckning', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({
      RotReducedInvoicingType: 1,
      RotReducedInvoicingAmount: 600,
      RotReducedInvoicingPropertyName: 'Uppsala Kåbo 1:23',
      RotPropertyType: 2,
      Persons: [{ Id: 'p1', Ssn: '197001011234', Amount: 600 }],
    }))
    expect(dto.householdDeduction?.property).toEqual({ designation: 'Uppsala Kåbo 1:23', type: 'property' })
  })
})

describe('mapVismaToSalesInvoice: grön teknik invoice', () => {
  const green = salesRaw({
    TotalAmount: 100000,
    RotReducedInvoicingType: 0,
    UsesGreenTechnology: true,
    RotReducedInvoicingAmount: 15000,
    RotReducedInvoicingPropertyName: 'Uppsala Kåbo 1:23',
    RotPropertyType: 2,
    Persons: [{ Id: 'p1', Ssn: '197001011234', Amount: 15000 }],
    Rows: [
      { LineNumber: 1, Text: 'Solceller, installation', AmountNoVat: 80000, GreenTechnologyType: 1, WorkHours: 24, MaterialCosts: 50000 },
      { LineNumber: 2, Text: 'Frakt', AmountNoVat: 2000, GreenTechnologyType: 0 },
      { LineNumber: 3, Text: 'Anläggning 12 kW', IsTextRow: true, GreenTechnologyType: 1 },
    ],
  })

  it('reads the deduction as grön teknik', () => {
    const dto = mapVismaToSalesInvoice(green)
    expect(dto.householdDeduction).toEqual({
      kind: 'gron_teknik',
      amount: 15000,
      buyers: [{ personnummer: '197001011234', amount: 15000 }],
      property: { designation: 'Uppsala Kåbo 1:23', type: 'property' },
    })
  })

  it('marks the installation row with its installation type, not the freight row or the text row', () => {
    const dto = mapVismaToSalesInvoice(green)
    expect(dto.lines[0].householdWork).toEqual({
      workType: 'INSTALLATION_SOLCELLER',
      providerWorkType: '1',
      hours: 24,
      materialCost: 50000,
    })
    expect(dto.lines[1].householdWork).toBeUndefined()
    expect(dto.lines[2].householdWork).toBeUndefined()
  })

  it('ignores GreenTechnologyType on an invoice that does not use green technology', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({
      Rows: [{ LineNumber: 1, AmountNoVat: 2000, GreenTechnologyType: 1 }],
    }))
    expect(dto.lines[0].householdWork).toBeUndefined()
  })
})

describe('mapVismaToSalesInvoice: invoices without a deduction', () => {
  it('a normal invoice has no householdDeduction and no householdWork', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({
      RotReducedInvoicingType: 0,
      UsesGreenTechnology: false,
      Rows: [{ LineNumber: 1, AmountNoVat: 2000, IsWorkCost: false, WorkCostType: 0, GreenTechnologyType: 0 }],
    }))
    expect(dto.householdDeduction).toBeUndefined()
    expect(dto.lines[0].householdWork).toBeUndefined()
  })

  it('a payload without any deduction field has none either', () => {
    const dto = mapVismaToSalesInvoice(salesRaw())
    expect(dto.householdDeduction).toBeUndefined()
  })

  it('a deduction that resolves to 0 is no deduction', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({ RotReducedInvoicingAmount: 0 }))
    expect(dto.householdDeduction).toBeUndefined()
  })

  it('a credit invoice carries no deduction and no work rows', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      IsCreditInvoice: true,
      TotalAmount: -2500,
      RotReducedInvoicingAmount: -1000,
    }))
    expect(dto.invoiceTypeCode).toBe('381')
    expect(dto.householdDeduction).toBeUndefined()
    expect(dto.lines.every((line) => line.householdWork === undefined)).toBe(true)
  })
})

describe('mapVismaToSalesInvoice: deduction amount', () => {
  it('falls back to the sum of the buyers shares when RotReducedInvoicingAmount is absent', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      RotReducedInvoicingAmount: undefined,
      Persons: [
        { Id: 'p1', Ssn: '197001011234', Amount: 600.1 },
        { Id: 'p2', Ssn: '197202022345', Amount: 400.2 },
      ],
    }))
    expect(dto.householdDeduction?.amount).toBe(1000.3)
  })

  it('takes RotReducedInvoicingAmount over the buyers shares when both are stated', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      RotReducedInvoicingAmount: 1000,
      Persons: [{ Id: 'p1', Ssn: '197001011234', Amount: 999 }],
    }))
    expect(dto.householdDeduction?.amount).toBe(1000)
  })

  it('has no deduction when neither the amount nor any share is stated', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({
      RotReducedInvoicingAmount: undefined,
      Persons: [{ Id: 'p1', Ssn: '197001011234' }],
    }))
    expect(dto.householdDeduction).toBeUndefined()
  })

  it('keeps a buyer without a personnummer as the share alone', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({ Persons: [{ Id: 'p1', Ssn: '', Amount: 1000 }] }))
    expect(dto.householdDeduction?.buyers).toEqual([{ amount: 1000 }])
  })
})

describe('mapVismaToSalesInvoice: TaxDeductionStatus', () => {
  it.each([
    [0, 'open'],
    [1, 'open'],
    [2, 'requested'],
    [3, 'rejected'],
  ] as const)('TaxDeductionStatus %i reads as %s', (status, state) => {
    const dto = mapVismaToSalesInvoice(rutInvoice({ TaxDeductionStatus: status }))
    expect(dto.householdDeduction?.providerState).toBe(state)
  })

  it('leaves providerState absent when the field is absent', () => {
    const dto = mapVismaToSalesInvoice(rutInvoice({ TaxDeductionStatus: undefined }))
    expect(dto.householdDeduction).toBeDefined()
    expect(dto.householdDeduction).not.toHaveProperty('providerState')
  })
})
