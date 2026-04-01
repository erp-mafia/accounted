import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
} from '@react-pdf/renderer'
import type { Invoice, InvoiceItem, Customer, CompanySettings, InvoiceDocumentType } from '@/types'
import { generateOcrReference } from '@/lib/bankgiro/luhn'

// Create styles
const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 30,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1a1a1a',
  },
  companyInfo: {
    textAlign: 'right',
  },
  companyName: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 8,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: {
    color: '#666',
  },
  value: {
    fontWeight: 'bold',
  },
  customerBox: {
    backgroundColor: '#f5f5f5',
    padding: 15,
    borderRadius: 4,
    marginBottom: 20,
  },
  customerName: {
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  table: {
    marginTop: 10,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    paddingBottom: 8,
    marginBottom: 8,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  colDescription: {
    flex: 3.5,
  },
  colQty: {
    flex: 1,
    textAlign: 'right',
  },
  colUnit: {
    flex: 1,
    textAlign: 'center',
  },
  colPrice: {
    flex: 1.5,
    textAlign: 'right',
  },
  colVat: {
    flex: 1,
    textAlign: 'right',
  },
  colTotal: {
    flex: 1.5,
    textAlign: 'right',
  },
  tableHeaderText: {
    fontWeight: 'bold',
    color: '#666',
    fontSize: 9,
    textTransform: 'uppercase',
  },
  totalsSection: {
    marginTop: 20,
    paddingTop: 15,
    borderTopWidth: 2,
    borderTopColor: '#ddd',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 4,
  },
  totalLabel: {
    width: 120,
    textAlign: 'right',
    paddingRight: 15,
    color: '#666',
  },
  totalValue: {
    width: 100,
    textAlign: 'right',
  },
  grandTotal: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  grandTotalLabel: {
    width: 120,
    textAlign: 'right',
    paddingRight: 15,
    fontSize: 14,
    fontWeight: 'bold',
  },
  grandTotalValue: {
    width: 100,
    textAlign: 'right',
    fontSize: 14,
    fontWeight: 'bold',
  },
  paymentSection: {
    marginTop: 30,
    padding: 15,
    backgroundColor: '#f8f9fa',
    borderRadius: 4,
  },
  paymentTitle: {
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  paymentRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  paymentLabel: {
    width: 100,
    color: '#666',
  },
  paymentValue: {
    flex: 1,
  },
  reverseChargeBox: {
    marginTop: 20,
    padding: 12,
    backgroundColor: '#fff3cd',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#ffc107',
  },
  reverseChargeText: {
    fontSize: 9,
    color: '#856404',
  },
  notesBox: {
    marginTop: 20,
    padding: 12,
    backgroundColor: '#e8f4fd',
    borderRadius: 4,
  },
  notesText: {
    fontSize: 9,
    color: '#0c5460',
  },
  creditNoteBox: {
    marginBottom: 20,
    padding: 12,
    backgroundColor: '#f8d7da',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#f5c6cb',
  },
  creditNoteText: {
    fontSize: 10,
    color: '#721c24',
  },
  creditNoteTitle: {
    color: '#721c24',
  },
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#ddd',
    paddingTop: 10,
  },
  footerText: {
    fontSize: 8,
    color: '#999',
    textAlign: 'center',
  },
  twoColumn: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  column: {
    width: '48%',
  },
})

// Format currency
function formatCurrency(amount: number, currency: string = 'SEK'): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

// Format date
function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('sv-SE')
}

// Format org number
function formatOrgNumber(orgNumber: string): string {
  const cleaned = orgNumber.replace(/\D/g, '')
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 6)}-${cleaned.slice(6)}`
  }
  return orgNumber
}

function getDocumentTitle(invoice: Invoice): string {
  if (invoice.credited_invoice_id) return 'KREDITFAKTURA'
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  if (docType === 'proforma') return 'PROFORMAFAKTURA'
  if (docType === 'delivery_note') return 'FÖLJESEDEL'
  return 'FAKTURA'
}

interface InvoicePDFProps {
  invoice: Invoice
  customer: Customer
  items: InvoiceItem[]
  company: CompanySettings
  originalInvoiceNumber?: string
}

export function InvoicePDF({ invoice, customer, items, company, originalInvoiceNumber }: InvoicePDFProps) {
  const isCreditNote = !!invoice.credited_invoice_id

  // Check if items have mixed VAT rates
  const hasPerLineVat = items.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)
  const uniqueRates = hasPerLineVat
    ? new Set(items.map((item) => item.vat_rate))
    : new Set<number>()
  const showVatColumn = hasPerLineVat && uniqueRates.size > 1

  // Calculate per-rate VAT breakdown for totals
  const vatByRate = new Map<number, { base: number; vat: number }>()
  if (hasPerLineVat) {
    for (const item of items) {
      const rate = item.vat_rate ?? 0
      const group = vatByRate.get(rate) || { base: 0, vat: 0 }
      group.base += Math.abs(item.line_total)
      group.vat += Math.abs(item.vat_amount || 0)
      vatByRate.set(rate, group)
    }
  }
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, isCreditNote ? styles.creditNoteTitle : {}]}>
              {getDocumentTitle(invoice)}
            </Text>
            <Text style={{ marginTop: 5, color: '#666' }}>{invoice.invoice_number}</Text>
          </View>
          <View style={styles.companyInfo}>
            {company.logo_url && (
              <Image src={company.logo_url} style={{ maxHeight: 40, maxWidth: 150, marginBottom: 6, alignSelf: 'flex-end' }} />
            )}
            <Text style={styles.companyName}>{company.company_name}</Text>
            {company.address_line1 && <Text>{company.address_line1}</Text>}
            {(company.postal_code || company.city) && (
              <Text>{company.postal_code} {company.city}</Text>
            )}
            {company.org_number && (
              <Text style={{ marginTop: 4 }}>Org.nr: {formatOrgNumber(company.org_number)}</Text>
            )}
            {company.vat_number && <Text>VAT: {company.vat_number}</Text>}
          </View>
        </View>

        {/* Credit note reference */}
        {isCreditNote && originalInvoiceNumber && (
          <View style={styles.creditNoteBox}>
            <Text style={styles.creditNoteText}>
              Denna kreditfaktura avser och krediterar faktura nr {originalInvoiceNumber}
            </Text>
          </View>
        )}

        {/* Invoice details and Customer - two columns */}
        <View style={styles.twoColumn}>
          {/* Invoice details */}
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>Fakturainformation</Text>
            <View style={styles.row}>
              <Text style={styles.label}>Fakturadatum:</Text>
              <Text style={styles.value}>{formatDate(invoice.invoice_date)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.label}>Förfallodatum:</Text>
              <Text style={styles.value}>{formatDate(invoice.due_date)}</Text>
            </View>
            {invoice.your_reference && (
              <View style={{ marginBottom: 4 }}>
                <Text style={styles.label}>Er referens:</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                  {invoice.your_reference.split(',').map((ref, i) => (
                    <Text key={i} style={{ backgroundColor: '#f0f0f0', borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9, fontWeight: 'bold' }}>
                      {ref.trim()}
                    </Text>
                  ))}
                </View>
              </View>
            )}
            {invoice.our_reference && (
              <View style={{ marginBottom: 4 }}>
                <Text style={styles.label}>Vår referens:</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                  {invoice.our_reference.split(',').map((ref, i) => (
                    <Text key={i} style={{ backgroundColor: '#f0f0f0', borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9, fontWeight: 'bold' }}>
                      {ref.trim()}
                    </Text>
                  ))}
                </View>
              </View>
            )}
          </View>

          {/* Customer */}
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>Faktureras till</Text>
            <View style={styles.customerBox}>
              <Text style={styles.customerName}>{customer.name}</Text>
              {customer.address_line1 && <Text>{customer.address_line1}</Text>}
              {customer.address_line2 && <Text>{customer.address_line2}</Text>}
              {(customer.postal_code || customer.city) && (
                <Text>{customer.postal_code} {customer.city}</Text>
              )}
              {customer.country && customer.country !== 'SE' && (
                <Text>{customer.country}</Text>
              )}
              {customer.org_number && (
                <Text style={{ marginTop: 6 }}>Org.nr: {customer.org_number}</Text>
              )}
              {customer.vat_number && <Text>VAT: {customer.vat_number}</Text>}
            </View>
          </View>
        </View>

        {/* Items table */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Specifikation</Text>
          <View style={styles.table}>
            {/* Table header */}
            <View style={styles.tableHeader}>
              <Text style={[styles.colDescription, styles.tableHeaderText]}>Beskrivning</Text>
              <Text style={[styles.colQty, styles.tableHeaderText]}>Antal</Text>
              <Text style={[styles.colUnit, styles.tableHeaderText]}>Enhet</Text>
              {!isDeliveryNote && (
                <Text style={[styles.colPrice, styles.tableHeaderText]}>à-pris</Text>
              )}
              {!isDeliveryNote && showVatColumn && (
                <Text style={[styles.colVat, styles.tableHeaderText]}>Moms</Text>
              )}
              {!isDeliveryNote && (
                <Text style={[styles.colTotal, styles.tableHeaderText]}>Summa</Text>
              )}
            </View>

            {/* Table rows */}
            {items.map((item, index) => (
              <View key={index} style={styles.tableRow}>
                <Text style={styles.colDescription}>{item.description}</Text>
                <Text style={styles.colQty}>{item.quantity}</Text>
                <Text style={styles.colUnit}>{item.unit}</Text>
                {!isDeliveryNote && (
                  <Text style={styles.colPrice}>{formatCurrency(item.unit_price, invoice.currency)}</Text>
                )}
                {!isDeliveryNote && showVatColumn && (
                  <Text style={styles.colVat}>{item.vat_rate ?? 0}%</Text>
                )}
                {!isDeliveryNote && (
                  <Text style={styles.colTotal}>{formatCurrency(item.line_total, invoice.currency)}</Text>
                )}
              </View>
            ))}
          </View>
        </View>

        {/* Totals - hidden for delivery notes */}
        {!isDeliveryNote && (
          <View style={styles.totalsSection}>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Delsumma:</Text>
              <Text style={styles.totalValue}>{formatCurrency(invoice.subtotal, invoice.currency)}</Text>
            </View>
            {vatByRate.size > 1 ? (
              Array.from(vatByRate.entries())
                .filter(([, group]) => group.vat > 0)
                .sort(([a], [b]) => b - a)
                .map(([rate, group]) => (
                  <View key={rate} style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Moms {rate}%:</Text>
                    <Text style={styles.totalValue}>{formatCurrency(group.vat, invoice.currency)}</Text>
                  </View>
                ))
            ) : (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Moms ({invoice.vat_rate ?? (vatByRate.size === 1 ? vatByRate.keys().next().value : 0)}%):</Text>
                <Text style={styles.totalValue}>{formatCurrency(invoice.vat_amount, invoice.currency)}</Text>
              </View>
            )}
            <View style={styles.grandTotal}>
              <Text style={styles.grandTotalLabel}>{isCreditNote ? 'Att kreditera:' : 'Att betala:'}</Text>
              <Text style={styles.grandTotalValue}>{formatCurrency(
                (company.ore_rounding ?? true) && invoice.currency === 'SEK'
                  ? Math.round(invoice.total)
                  : invoice.total,
                invoice.currency
              )}</Text>
            </View>
            {(company.ore_rounding ?? true) && invoice.currency === 'SEK' && Math.round(invoice.total) !== invoice.total && (
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { fontSize: 8 }]}>Öresavrundning:</Text>
                <Text style={[styles.totalValue, { fontSize: 8 }]}>{formatCurrency(Math.round(invoice.total) - invoice.total, 'SEK')}</Text>
              </View>
            )}
            {invoice.currency !== 'SEK' && invoice.total_sek && (
              <View style={[styles.totalRow, { marginTop: 8 }]}>
                <Text style={[styles.totalLabel, { fontSize: 9 }]}>I SEK (kurs {invoice.exchange_rate}):</Text>
                <Text style={[styles.totalValue, { fontSize: 9 }]}>{formatCurrency(invoice.total_sek, 'SEK')}</Text>
              </View>
            )}
          </View>
        )}

        {/* Proforma notice */}
        {isProforma && (
          <View style={[styles.reverseChargeBox, { backgroundColor: '#e8f4fd', borderColor: '#90cdf4' }]}>
            <Text style={[styles.reverseChargeText, { color: '#2b6cb0' }]}>
              Detta är en proformafaktura och utgör ingen betalningsanmodan.
            </Text>
          </View>
        )}

        {/* Payment information - not shown for credit notes, proformas, or delivery notes */}
        {!isCreditNote && !isProforma && !isDeliveryNote && (
          <View style={styles.paymentSection}>
            <Text style={styles.paymentTitle}>Betalningsinformation</Text>
            {company.bank_name && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Bank:</Text>
                <Text style={styles.paymentValue}>{company.bank_name}</Text>
              </View>
            )}
            {(company.clearing_number || company.account_number) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Kontonummer:</Text>
                <Text style={styles.paymentValue}>
                  {company.clearing_number}-{company.account_number}
                </Text>
              </View>
            )}
            {company.bankgiro && (company.invoice_show_bankgiro ?? true) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Bankgiro:</Text>
                <Text style={styles.paymentValue}>{company.bankgiro}</Text>
              </View>
            )}
            {company.plusgiro && (company.invoice_show_plusgiro ?? true) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Plusgiro:</Text>
                <Text style={styles.paymentValue}>{company.plusgiro}</Text>
              </View>
            )}
            {company.iban && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>IBAN:</Text>
                <Text style={styles.paymentValue}>{company.iban}</Text>
              </View>
            )}
            {company.bic && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>BIC/SWIFT:</Text>
                <Text style={styles.paymentValue}>{company.bic}</Text>
              </View>
            )}
            <View style={[styles.paymentRow, { marginTop: 8 }]}>
              <Text style={styles.paymentLabel}>Förfallodatum:</Text>
              <Text style={[styles.paymentValue, { fontWeight: 'bold' }]}>{formatDate(invoice.due_date)}</Text>
            </View>
            {(company.invoice_show_ocr ?? true) && (
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>OCR/Referens:</Text>
                <Text style={[styles.paymentValue, { fontWeight: 'bold' }]}>{generateOcrReference(invoice.invoice_number)}</Text>
              </View>
            )}
          </View>
        )}

        {/* Reverse charge notice */}
        {invoice.reverse_charge_text && (
          <View style={styles.reverseChargeBox}>
            <Text style={styles.reverseChargeText}>{invoice.reverse_charge_text}</Text>
          </View>
        )}

        {/* Notes */}
        {invoice.notes && (
          <View style={styles.notesBox}>
            <Text style={styles.notesText}>{invoice.notes}</Text>
          </View>
        )}

        {/* Late fee & credit terms */}
        {(company.invoice_late_fee_text || company.invoice_credit_terms_text) && (
          <View style={{ marginTop: 10, marginBottom: 10 }}>
            {company.invoice_late_fee_text && (
              <Text style={{ fontSize: 8, color: '#666', marginBottom: 2 }}>{company.invoice_late_fee_text}</Text>
            )}
            {company.invoice_credit_terms_text && (
              <Text style={{ fontSize: 8, color: '#666' }}>{company.invoice_credit_terms_text}</Text>
            )}
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            {company.company_name}
            {company.org_number ? ` | Org.nr: ${formatOrgNumber(company.org_number)}` : ''}
            {company.f_skatt ? ' | Godkänd för F-skatt' : ''}
            {company.vat_number ? ` | Momsreg.nr: ${company.vat_number}` : ''}
          </Text>
        </View>
      </Page>
    </Document>
  )
}
