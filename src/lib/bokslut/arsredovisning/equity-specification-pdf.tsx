import { Text, View, StyleSheet } from '@react-pdf/renderer'
import { formatPdfKronor } from './pdf-format'
import { equitySpecificationTable, type EquitySpecificationYear } from './equity-specification'

/**
 * The specification of changes in equity as a PDF table (ÅRL 6 kap. 2 §
 * andra stycket, K3 6.3): one column per equity post that holds anything and
 * a total, rows from the opening balance through each kind of movement to
 * the closing balance. One component for the K2 and the K3 template, so the
 * two cannot present the same figures differently.
 */
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: '#888',
    paddingBottom: 3,
    marginBottom: 3,
  },
  row: {
    flexDirection: 'row',
    fontSize: 8,
    paddingVertical: 2,
  },
  totalRow: {
    flexDirection: 'row',
    fontSize: 8,
    paddingVertical: 2,
    borderTopWidth: 0.5,
    borderTopColor: '#888',
    fontFamily: 'Helvetica-Bold',
  },
  label: {
    flex: 1,
    paddingRight: 4,
  },
  amount: {
    width: 64,
    textAlign: 'right',
  },
  caption: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginTop: 8,
    marginBottom: 4,
  },
})

export function EquitySpecificationTable({
  year,
  caption,
  framework = 'k3',
}: {
  year: EquitySpecificationYear
  /** Printed above the table (the year's name when both years are shown). */
  caption?: string
  /** The year's regelverk: a K2 årsredovisning prints the K2 taxonomy's row labels. */
  framework?: 'k2' | 'k3'
}) {
  const table = equitySpecificationTable(year, framework)
  return (
    <View wrap={false}>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      <View style={styles.header}>
        <Text style={styles.label}> </Text>
        {table.columns.map((column) => (
          <Text key={column.concept} style={styles.amount}>
            {column.label}
          </Text>
        ))}
        <Text style={styles.amount}>Totalt</Text>
      </View>
      {table.rows.map((row) => (
        <View key={row.key} style={row.is_total ? styles.totalRow : styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          {row.cells.map((cell, index) => (
            <Text key={table.columns[index].concept} style={styles.amount}>
              {formatPdfKronor(cell)}
            </Text>
          ))}
          <Text style={styles.amount}>{formatPdfKronor(row.total)}</Text>
        </View>
      ))}
    </View>
  )
}
