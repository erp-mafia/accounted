/**
 * The aktiebok as CSV: semicolon-separated with a BOM, so Excel in a Swedish
 * locale opens it in columns with å, ä and ö intact. Three views of the same
 * printout data (pdf-data.ts): every share range in numerical order, the
 * holders with capital and votes, and the dated history. Pure.
 */
import type { AktiebokPdfData } from './pdf-data'

export type AktiebokCsvView = 'shares' | 'holders' | 'history'

function field(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'boolean' ? (value ? 'Ja' : 'Nej') : String(value)
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function decimal(n: number): string {
  return String(n).replace('.', ',')
}

function lines(rows: Array<Array<string | number | boolean | null | undefined>>): string {
  return '﻿' + rows.map((r) => r.map(field).join(';')).join('\r\n') + '\r\n'
}

export function aktiebokCsv(data: AktiebokPdfData, view: AktiebokCsvView): string {
  if (view === 'holders') {
    return lines([
      ['Ägare', 'Person-/orgnr', 'Aktier', 'Röster', 'Kapital %', 'Röster %', 'Styrelse/VD'],
      ...data.holders.map((h) => [h.name, h.identity, h.shares, decimal(h.votes), decimal(h.capital_pct), decimal(h.votes_pct), h.board_flag]),
    ])
  }
  if (view === 'history') {
    return lines([
      ['Nr', 'Datum', 'Införd', 'Typ', 'Anteckning', 'Rättad'],
      ...data.history.map((h) => [h.event_number, h.event_date, h.entered_on, h.kind_label, h.text, h.voided]),
    ])
  }
  return lines([
    ['Aktienummer från', 'Aktienummer till', 'Antal', 'Serie', 'Ägare', 'Person-/orgnr', 'Postadress', 'Aktiebrev', 'Anteckningar', 'Styrelse/VD'],
    ...data.rows.map((r) => [r.range_start, r.range_end, r.count, r.class_code, r.holder_name, r.identity, r.address, r.aktiebrev ?? 'Nej', r.notes.join('; '), r.board_flag]),
  ])
}
