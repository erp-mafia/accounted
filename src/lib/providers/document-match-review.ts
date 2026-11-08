import { candidatesForRef, periodIdForDate, type DatedSourceVoucherRef, type FiscalPeriodRow, type VoucherIndex, type VoucherRow } from '@/lib/documents/voucher-ref-resolver'

export const DOCUMENT_MATCH_REASONS = ['missing_reference', 'missing_period', 'missing_voucher', 'other_period', 'ambiguous', 'date_mismatch'] as const
export type DocumentMatchReason = typeof DOCUMENT_MATCH_REASONS[number]
export interface UnmatchedProviderDocument {
  uploadId: string
  fileName: string | null
  voucher: string | null
  date: string | null
  dateTo: string | null
  reason: DocumentMatchReason
  candidateCount: number
  candidates: {id: string; label: string; date: string; reversed: boolean}[]
}
export interface ProviderDocumentMatchReview {
  provider: string
  total: number
  filteredTotal: number
  offset: number
  limit: number
  reasonCounts: Partial<Record<DocumentMatchReason, number>>
  items: UnmatchedProviderDocument[]
}

/** Explain a refusal from the existing resolver; never choose or change a target. */
export function explainUnmatchedDocument(index: VoucherIndex, periods: FiscalPeriodRow[],
  ref: DatedSourceVoucherRef | null, dateDisagrees = false,
): {reason: DocumentMatchReason; candidates: VoucherRow[]} {
  if (!ref) return {reason:'missing_reference',candidates:[]}
  const all = candidatesForRef(index, ref)
  const periodId = periodIdForDate(periods, ref.date)
  const withinPeriod = ref.dateTo
    ? all.filter(row => ref.date <= row.entry_date && row.entry_date <= ref.dateTo!)
    : all.filter(row => row.fiscal_period_id === periodId)
  if (dateDisagrees) return {reason:'date_mismatch',candidates:withinPeriod}
  if ((!ref.dateTo && !periodId) || (ref.dateTo && !periods.some(period=>period.period_start<=ref.dateTo! && period.period_end>=ref.date))) return {reason:'missing_period',candidates:all}
  if (withinPeriod.length > 1) return {reason:'ambiguous',candidates:withinPeriod}
  if (!withinPeriod.length && all.length) return {reason:'other_period',candidates:all}
  return {reason:'missing_voucher',candidates:[]}
}

/** Stable, chronological paging over the complete diagnostic set, not a sample. */
export function pageUnmatchedDocuments(provider:string, rows:UnmatchedProviderDocument[],
  {offset,limit,query=''}:{offset:number;limit:number;query?:string},
):ProviderDocumentMatchReview {
  const reasonCounts:ProviderDocumentMatchReview['reasonCounts']={}
  for(const row of rows) reasonCounts[row.reason]=(reasonCounts[row.reason]??0)+1
  const needle=query.trim().toLocaleLowerCase('sv-SE')
  const filtered=rows.filter(row=>!needle || [row.fileName,row.voucher,row.date,row.uploadId]
    .some(value=>value?.toLocaleLowerCase('sv-SE').includes(needle)))
    .sort((a,b)=>(a.date??'9999').localeCompare(b.date??'9999') || (a.voucher??'').localeCompare(b.voucher??'','sv-SE',{numeric:true}) || a.uploadId.localeCompare(b.uploadId))
  return {provider,total:rows.length,filteredTotal:filtered.length,offset,limit,reasonCounts,items:filtered.slice(offset,offset+limit)}
}
