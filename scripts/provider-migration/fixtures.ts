/** Synthetic upstream JSON, passed through the production provider mappers. */
export type LoadProvider = 'visma' | 'bokio'

export function invoiceFixture(provider: LoadProvider, index: number, lines = 3): Record<string, unknown> {
  const customer = `Synthetic customer ${index % 250}`
  const net = lines * 100
  const paid = index % 3 === 0
  const date = `${2024 + index % 3}-02-10`
  if (provider === 'visma') return {
    Id: `load-${index}`, InvoiceNumber: String(index + 1), InvoiceDate: date, DueDate: date,
    CustomerId: `customer-${index % 250}`, InvoiceCustomerName: customer, CurrencyCode: 'SEK',
    TotalAmount: net * 1.25, TotalVatAmount: net * 0.25, RemainingAmount: paid ? 0 : net * 1.25,
    IsSent: true, Rows: Array.from({ length: lines }, (_, i) => ({ LineNumber: i + 1,
      Text: `Synthetic row ${i + 1}`, Quantity: 1, UnitPrice: 100, AmountNoVat: 100, PercentVat: 25,
      AccountNumber: '3001' })),
  }
  return {
    id: `load-${index}`, invoiceNumber: String(index + 1), invoiceDate: date, dueDate: date,
    customerRef: { id: `customer-${index % 250}`, name: customer }, currency: 'SEK',
    totalAmount: net * 1.25, totalTax: net * 0.25, paidAmount: paid ? net * 1.25 : 0,
    status: paid ? 'paid' : 'published', lineItems: Array.from({ length: lines }, (_, i) => ({
      id: String(i + 1), description: `Synthetic row ${i + 1}`, quantity: 1, unitPrice: 100, taxRate: 25,
    })),
  }
}

export function providerPage(provider: LoadProvider, page: number, size: number, count: number, detailEvery = 0) {
  const items = Array.from({ length: Math.max(0, Math.min(size, count - (page - 1) * size)) }, (_, i) => {
    const index = (page - 1) * size + i
    const raw = invoiceFixture(provider, index)
    if (detailEvery > 0 && index % detailEvery === 0) delete raw[provider === 'visma' ? 'Rows' : 'lineItems']
    return raw
  })
  return provider === 'visma'
    ? { Data: items, Meta: { TotalNumberOfPages: Math.ceil(count / size), TotalNumberOfResults: count } }
    : { items, currentPage: page, totalPages: Math.ceil(count / size), totalItems: count }
}
