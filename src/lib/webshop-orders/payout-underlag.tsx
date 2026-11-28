import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { roundOre } from '@/lib/money'
import type { WebshopPayout, WebshopPayoutLineKind } from '@/types'
import { formatAmount, styles, type OrderUnderlagCompany } from './order-underlag'
import { UnderlagFooter, UnderlagKontering } from './underlag-kontering'
import { payoutProviderLabel, type PayoutVoucherLine } from './payouts'

/**
 * Utbetalningsspecifikation: the underlag of a payout's verifikat (the bank
 * net, the provider's fees, the clearing account gross), filed on the
 * verifikat when its bank row is booked (payout-proposals.ts). It restates
 * the provider's own payout figures (Kustom's settlement report, Shopify
 * Payments' payout) so the verifikat can be traced to the payout without
 * opening the provider's portal.
 *
 * Swedish-only on purpose: underlag is räkenskapsinformation, like the
 * orderunderlag (order-underlag.tsx).
 */

const KIND_LABELS: Record<WebshopPayoutLineKind, string> = {
  sale: 'Försäljning',
  return: 'Returer',
  reversal: 'Återförda köp',
  fee: 'Avgifter',
  fee_vat: 'Moms på avgifter',
  holdback: 'Innehållet',
  release: 'Frigjort',
  adjustment: 'Justeringar',
}

const KIND_ORDER: readonly WebshopPayoutLineKind[] = ['sale', 'return', 'reversal', 'fee', 'fee_vat', 'holdback', 'release', 'adjustment']

export interface PayoutUnderlagModel {
  providerLabel: string
  storeScope: string
  reference: string | null
  payoutDate: string
  parts: Array<{ label: string; amount: number }>
  net: number
  lines: Array<{ account: string; debit: number; credit: number }>
  totalDebit: number
  totalCredit: number
}

/** Build the render model. Pure; every sum through roundOre. */
export function buildPayoutUnderlagModel(args: {
  payout: Pick<WebshopPayout, 'platform' | 'store_scope' | 'reference' | 'payout_date' | 'amount' | 'lines'>
  /** The verifikat's lines, the bank leg included. */
  lines: ReadonlyArray<Pick<PayoutVoucherLine, 'account_number' | 'debit_amount' | 'credit_amount'>>
}): PayoutUnderlagModel {
  const parts = KIND_ORDER.flatMap((kind) => {
    const amount = roundOre(args.payout.lines.filter((l) => l.kind === kind).reduce((sum, l) => roundOre(sum + l.amount), 0))
    return amount === 0 ? [] : [{ label: KIND_LABELS[kind], amount }]
  })
  let totalDebit = 0
  let totalCredit = 0
  const lines = args.lines.map((line) => {
    totalDebit = roundOre(totalDebit + (line.debit_amount || 0))
    totalCredit = roundOre(totalCredit + (line.credit_amount || 0))
    return { account: line.account_number, debit: line.debit_amount || 0, credit: line.credit_amount || 0 }
  })
  return {
    providerLabel: payoutProviderLabel(args.payout.platform),
    storeScope: args.payout.store_scope,
    reference: args.payout.reference,
    payoutDate: args.payout.payout_date,
    parts,
    net: roundOre(args.payout.amount),
    lines,
    totalDebit,
    totalCredit,
  }
}

export function payoutUnderlagFilename(model: Pick<PayoutUnderlagModel, 'providerLabel' | 'payoutDate'>): string {
  return `Utbetalning_${model.providerLabel.replace(/\s+/g, '')}_${model.payoutDate}.pdf`
}

export function WebshopPayoutUnderlagPDF({
  model,
  company,
  generatedAt,
}: {
  model: PayoutUnderlagModel
  company: OrderUnderlagCompany
  generatedAt: string
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header} fixed>
          <View>
            <Text style={styles.title}>Utbetalningsspecifikation</Text>
            <Text style={styles.subtitle}>
              {model.providerLabel} · {model.payoutDate}
            </Text>
            <Text style={styles.meta}>
              {model.reference ? `Referens ${model.reference} · ` : ''}
              {model.storeScope}
            </Text>
          </View>
          <View style={styles.companyInfo}>
            {company.company_name ? <Text style={styles.companyName}>{company.company_name}</Text> : null}
            {company.org_number ? <Text style={styles.meta}>Org.nr: {company.org_number}</Text> : null}
          </View>
        </View>

        <Text style={styles.sectionHeading}>Utbetalningen</Text>
        <View>
          {model.parts.map((part, i) => (
            <View key={i} style={styles.row} wrap={false}>
              <Text style={styles.colName}>{part.label}</Text>
              <Text style={styles.colAmount}>{formatAmount(part.amount)}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={[styles.colName, styles.bold]}>Utbetalt till banken</Text>
            <Text style={[styles.colAmount, styles.bold]}>{formatAmount(model.net)}</Text>
          </View>
        </View>

        <UnderlagKontering lines={model.lines} totalDebit={model.totalDebit} totalCredit={model.totalCredit} />

        <UnderlagFooter source="Underlag genererat ur betalförmedlarens utbetalning vid bokföring" generatedAt={generatedAt} />
      </Page>
    </Document>
  )
}

export async function renderWebshopPayoutUnderlagPdf(args: {
  model: PayoutUnderlagModel
  company: OrderUnderlagCompany
  generatedAt: string
}): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string }> {
  const buffer = await renderToBuffer(WebshopPayoutUnderlagPDF(args))
  return { bytes: new Uint8Array(buffer), filename: payoutUnderlagFilename(args.model) }
}
