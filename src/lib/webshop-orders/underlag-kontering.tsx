import { Text, View } from '@react-pdf/renderer'
import { formatAmount, styles } from './order-underlag'

/**
 * The verifikat's kontering in a generated underlag (the day summary, the
 * payout specification): one row per line, debit and credit, and their sums.
 */
export function UnderlagKontering({
  lines,
  totalDebit,
  totalCredit,
}: {
  lines: ReadonlyArray<{ account: string; debit: number; credit: number }>
  totalDebit: number
  totalCredit: number
}) {
  return (
    <>
      <Text style={styles.sectionHeading}>Kontering (SEK)</Text>
      <View>
        <View style={styles.tableHeader}>
          <Text style={[styles.colName, styles.headerCell]}>Konto</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Debet</Text>
          <Text style={[styles.colAmount, styles.headerCell]}>Kredit</Text>
        </View>
        {lines.map((line, i) => (
          <View key={i} style={styles.row} wrap={false}>
            <Text style={styles.colName}>{line.account}</Text>
            <Text style={styles.colAmount}>{line.debit ? formatAmount(line.debit) : ''}</Text>
            <Text style={styles.colAmount}>{line.credit ? formatAmount(line.credit) : ''}</Text>
          </View>
        ))}
        <View style={styles.totalRow}>
          <Text style={[styles.colName, styles.bold]}>Summa</Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatAmount(totalDebit)}</Text>
          <Text style={[styles.colAmount, styles.bold]}>{formatAmount(totalCredit)}</Text>
        </View>
      </View>
    </>
  )
}

/** The footer of a generated underlag: where it came from, when, and the page. */
export function UnderlagFooter({ source, generatedAt }: { source: string; generatedAt: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerText}>{source}</Text>
      <Text
        style={styles.footerText}
        render={({ pageNumber, totalPages }) => `Genererad ${generatedAt} · Sida ${pageNumber} av ${totalPages}`}
      />
    </View>
  )
}
