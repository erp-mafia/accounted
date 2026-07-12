import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import { getBranding } from '@/lib/branding/service'

/**
 * Pay slip PDF template (Lönespecifikation).
 *
 * Legally required per BFL as räkenskapsinformation/underlag.
 * Subject to 7-year retention per BFL 7 kap.
 *
 * Contents:
 * - Company + employee identification
 * - Line items (salary, absence, benefits, deductions)
 * - Gross → Tax → Net summary with tax table reference
 * - Employer cost breakdown (avgifter, vacation accrual): transparency feature
 * - YTD totals (cumulative year-to-date)
 * - Calculation breakdown (optional detail showing every formula step)
 */

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    padding: 40,
    color: '#1a1a1a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  title: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: '#666',
  },
  companyName: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
  },
  companyInfo: {
    fontSize: 8,
    color: '#666',
    marginTop: 2,
  },
  section: {
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 3,
  },
  rowAlt: {
    flexDirection: 'row',
    paddingVertical: 3,
    backgroundColor: '#f8f8f8',
  },
  headerRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
    marginBottom: 2,
  },
  colDesc: { flex: 3.5 },
  colQty: { flex: 1, textAlign: 'right' as const },
  colRate: { flex: 1.5, textAlign: 'right' as const },
  colAmount: { flex: 1.5, textAlign: 'right' as const },
  headerText: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: '#666',
    textTransform: 'uppercase' as const,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  summaryLabel: {
    fontSize: 9,
    color: '#444',
  },
  summaryValue: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right' as const,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 2,
    borderTopColor: '#1a1a1a',
    marginTop: 4,
  },
  totalLabel: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
  },
  totalValue: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right' as const,
  },
  infoGrid: {
    flexDirection: 'row',
    gap: 20,
    marginBottom: 14,
  },
  infoColumn: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 7,
    color: '#999',
    textTransform: 'uppercase' as const,
    marginBottom: 1,
  },
  infoValue: {
    fontSize: 9,
    marginBottom: 6,
  },
  breakdownSection: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 3,
  },
  breakdownTitle: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 1.5,
  },
  breakdownLabel: {
    fontSize: 7.5,
    color: '#555',
    flex: 3,
  },
  breakdownFormula: {
    fontSize: 7,
    color: '#888',
    flex: 3,
    fontFamily: 'Courier',
  },
  breakdownValue: {
    fontSize: 7.5,
    textAlign: 'right' as const,
    flex: 1.5,
  },
  footer: {
    position: 'absolute' as const,
    bottom: 30,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    paddingTop: 6,
    fontSize: 7,
    color: '#999',
    textAlign: 'center' as const,
  },
  ytdSection: {
    marginTop: 10,
  },
  ytdRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  ytdLabel: {
    fontSize: 8,
    color: '#666',
  },
  ytdValue: {
    fontSize: 8,
    color: '#666',
    textAlign: 'right' as const,
  },
})

export interface PayslipData {
  // Company
  companyName: string
  companyOrgNumber: string
  companyAddress?: string

  // Employee
  employeeName: string
  personnummerMasked: string // YYYYMMDD-XXXX
  employmentType: string

  // Period
  periodYear: number
  periodMonth: number
  paymentDate: string

  // Line items
  lineItems: PayslipLineItem[]

  // Summary
  grossSalary: number
  taxWithheld: number
  netSalary: number
  taxReference: string // e.g. "Tabell 33, kolumn 1"

  // Employer cost (transparency feature)
  avgifterRate: number
  avgifterAmount: number
  vacationAccrual: number
  vacationAccrualAvgifter: number
  totalEmployerCost: number

  // YTD
  ytdGross: number
  ytdTax: number
  ytdNet: number

  // Bank
  bankAccount?: string // masked

  // Calculation breakdown (optional)
  breakdownSteps?: { label: string; formula: string; output: number }[]
}

export interface PayslipLineItem {
  description: string
  quantity?: number
  unitPrice?: number
  amount: number
}

function fmt(amount: number): string {
  return new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
}

const MONTH_NAMES = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

export function PayslipPDF({ data }: { data: PayslipData }) {
  const periodLabel = `${MONTH_NAMES[data.periodMonth - 1]} ${data.periodYear}`

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Lönespecifikation</Text>
            <Text style={styles.subtitle}>{periodLabel}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' as const }}>
            <Text style={styles.companyName}>{data.companyName}</Text>
            <Text style={styles.companyInfo}>Org.nr {data.companyOrgNumber}</Text>
            {data.companyAddress && <Text style={styles.companyInfo}>{data.companyAddress}</Text>}
          </View>
        </View>

        {/* Employee + Period info */}
        <View style={styles.infoGrid}>
          <View style={styles.infoColumn}>
            <Text style={styles.infoLabel}>Anställd</Text>
            <Text style={styles.infoValue}>{data.employeeName}</Text>
            <Text style={styles.infoLabel}>Personnummer</Text>
            <Text style={styles.infoValue}>{data.personnummerMasked}</Text>
          </View>
          <View style={styles.infoColumn}>
            <Text style={styles.infoLabel}>Period</Text>
            <Text style={styles.infoValue}>{periodLabel}</Text>
            <Text style={styles.infoLabel}>Utbetalningsdag</Text>
            <Text style={styles.infoValue}>{data.paymentDate}</Text>
          </View>
          <View style={styles.infoColumn}>
            <Text style={styles.infoLabel}>Skattetabell</Text>
            <Text style={styles.infoValue}>{data.taxReference}</Text>
            {data.bankAccount && (
              <>
                <Text style={styles.infoLabel}>Bankkonto</Text>
                <Text style={styles.infoValue}>{data.bankAccount}</Text>
              </>
            )}
          </View>
        </View>

        {/* Line items table */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lönespecifikation</Text>
          <View style={styles.headerRow}>
            <Text style={[styles.headerText, styles.colDesc]}>Beskrivning</Text>
            <Text style={[styles.headerText, styles.colQty]}>Antal</Text>
            <Text style={[styles.headerText, styles.colRate]}>á-pris</Text>
            <Text style={[styles.headerText, styles.colAmount]}>Belopp</Text>
          </View>
          {data.lineItems.map((item, i) => (
            <View key={i} style={i % 2 === 1 ? styles.rowAlt : styles.row}>
              <Text style={styles.colDesc}>{item.description}</Text>
              <Text style={styles.colQty}>{item.quantity != null ? item.quantity : ''}</Text>
              <Text style={styles.colRate}>{item.unitPrice != null ? fmt(item.unitPrice) : ''}</Text>
              <Text style={styles.colAmount}>{fmt(item.amount)}</Text>
            </View>
          ))}
        </View>

        {/* Summary: Gross → Tax → Net */}
        <View style={styles.section}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Bruttolön</Text>
            <Text style={styles.summaryValue}>{fmt(data.grossSalary)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Preliminär skatt ({data.taxReference})</Text>
            <Text style={styles.summaryValue}>−{fmt(data.taxWithheld)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Nettolön (utbetalas)</Text>
            <Text style={styles.totalValue}>{fmt(data.netSalary)}</Text>
          </View>
        </View>

        {/* Employer cost (transparency feature: our differentiator) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Arbetsgivarkostnad</Text>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Arbetsgivaravgifter ({(data.avgifterRate * 100).toFixed(2)}%)</Text>
            <Text style={styles.summaryValue}>{fmt(data.avgifterAmount)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Semesteravsättning</Text>
            <Text style={styles.summaryValue}>{fmt(data.vacationAccrual)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Sociala avgifter på semester</Text>
            <Text style={styles.summaryValue}>{fmt(data.vacationAccrualAvgifter)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total arbetsgivarkostnad</Text>
            <Text style={styles.totalValue}>{fmt(data.totalEmployerCost)}</Text>
          </View>
        </View>

        {/* YTD */}
        <View style={styles.ytdSection}>
          <Text style={[styles.sectionTitle, { fontSize: 9 }]}>Ackumulerat {data.periodYear}</Text>
          <View style={styles.ytdRow}>
            <Text style={styles.ytdLabel}>Brutto</Text>
            <Text style={styles.ytdValue}>{fmt(data.ytdGross)}</Text>
          </View>
          <View style={styles.ytdRow}>
            <Text style={styles.ytdLabel}>Skatt</Text>
            <Text style={styles.ytdValue}>{fmt(data.ytdTax)}</Text>
          </View>
          <View style={styles.ytdRow}>
            <Text style={styles.ytdLabel}>Netto</Text>
            <Text style={styles.ytdValue}>{fmt(data.ytdNet)}</Text>
          </View>
        </View>

        {/* Calculation breakdown (optional detail page) */}
        {data.breakdownSteps && data.breakdownSteps.length > 0 && (
          <View style={styles.breakdownSection}>
            <Text style={styles.breakdownTitle}>Beräkningsunderlag</Text>
            {data.breakdownSteps.map((step, i) => (
              <View key={i} style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>{step.label}</Text>
                <Text style={styles.breakdownFormula}>{step.formula}</Text>
                <Text style={styles.breakdownValue}>{fmt(step.output)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Footer */}
        <Text style={styles.footer}>
          {data.companyName} · Org.nr {data.companyOrgNumber} · Lönespecifikation {periodLabel} · Genererad av {getBranding().appName.toLowerCase()}
        </Text>
      </Page>
    </Document>
  )
}
