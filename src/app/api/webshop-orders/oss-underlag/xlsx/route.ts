import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { OssUnderlagQuerySchema } from '@/lib/api/schemas'
import { fileResponse } from '@/lib/api/file-response'
import { sessionFailureResponse } from '@/lib/operations/session'
import {
  dateColumn,
  decimalColumn,
  integerColumn,
  parseCellDate,
  reportToWorkbook,
  textColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getOssUnderlag } from '@/lib/webshop-orders/oss-underlag'

/**
 * GET /api/webshop-orders/oss-underlag/xlsx?year=2026&quarter=3
 *
 * The OSS underlag as a workbook: the declaration's figures per country and
 * rate, the corrections, the OSS verifikat it does not cover, the refunds it
 * took off the quarter, and the ECB rates used. Headers are Swedish, as
 * Skatteverket's form is.
 */
export const GET = withRouteContext('webshop_orders.oss_underlag.xlsx', async (request, { supabase, companyId, user, log, requestId }) => {
  const query = validateQuery(request, OssUnderlagQuerySchema)
  if (!query.success) return query.response

  const outcome = await getOssUnderlag({ supabase, companyId, userId: user.id, log }, query.data)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  const underlag = outcome.data

  const { data: company } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  const buffer = await reportToWorkbook([
    {
      name: `OSS ${underlag.period.label}`,
      columns: [
        textColumn('Land'),
        decimalColumn('Momssats (%)'),
        decimalColumn('Försäljning exkl. moms (EUR)'),
        decimalColumn('Moms (EUR)'),
        decimalColumn('Försäljning exkl. moms (SEK)'),
        decimalColumn('Moms (SEK)'),
        integerColumn('Ordrar'),
        integerColumn('Verifikat'),
        textColumn('Kontroll'),
      ],
      rows: underlag.rows,
      mapRow: (row) => [
        row.country,
        row.vat_rate,
        row.net_eur,
        row.vat_eur,
        row.net_sek,
        row.vat_sek,
        row.order_count,
        row.voucher_count,
        row.rate_mismatch ? 'Momsen stämmer inte med momssatsen' : null,
      ],
    },
    {
      name: 'Rättelser',
      columns: [
        textColumn('Land'),
        textColumn('Kvartal som rättas'),
        decimalColumn('Moms (EUR)'),
        decimalColumn('Moms (SEK)'),
        integerColumn('Återbetalningar'),
        integerColumn('Verifikat'),
      ],
      rows: underlag.corrections,
      mapRow: (row) => [row.country, row.period.label, row.vat_eur, row.vat_sek, row.refund_count, row.voucher_count],
    },
    {
      name: 'Ej i underlaget',
      columns: [
        textColumn('Verifikat'),
        dateColumn('Datum'),
        textColumn('Beskrivning'),
        decimalColumn('Försäljning (SEK)'),
        decimalColumn('Moms (SEK)'),
      ],
      rows: underlag.unaccounted,
      mapRow: (row) => [
        formatVoucher(row),
        parseCellDate(row.entry_date),
        row.description,
        row.net_sek,
        row.vat_sek,
      ],
    },
    {
      name: 'Avräknade återbetalningar',
      columns: [
        textColumn('Verifikat'),
        dateColumn('Datum'),
        textColumn('Beskrivning'),
        decimalColumn('Försäljning (SEK)'),
        decimalColumn('Moms (SEK)'),
      ],
      rows: underlag.refund_vouchers,
      mapRow: (row) => [
        formatVoucher(row),
        parseCellDate(row.entry_date),
        row.description,
        row.net_sek,
        row.vat_sek,
      ],
    },
    {
      name: 'ECB-kurser',
      // The rate as text: ECB quotes four decimals, a money column shows two.
      columns: [textColumn('Valuta'), dateColumn('Kurs för'), textColumn('Enheter per euro'), dateColumn('Publicerad')],
      rows: underlag.rates,
      mapRow: (rate) => [
        rate.currency,
        parseCellDate(rate.for_date),
        rate.rate === null ? null : String(rate.rate),
        rate.rate_date ? parseCellDate(rate.rate_date) : null,
      ],
    },
  ])

  const filename = xlsxFilename('oss-underlag', company?.company_name ?? '', underlag.period.end)
  return fileResponse(new Uint8Array(buffer), {
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
})
