import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { mappingsToMap } from './account-mapper'
import { importVouchers } from './sie-import'
import { chunkSIEEntries, hashSIEPayload, type SIEJob, type SIEPreparedEntry } from './sie-job-contract'
import { getEffectiveOpeningBalances, parseSIEFile } from './sie-parser'
import { readSIEJobSource } from './sie-jobs'
import type { AccountMapping, ParsedSIEFile } from './types'

export interface SIEResyncReview {
  sourceId: string
  kind: 'changed' | 'removed' | 'ambiguous' | 'unidentified' | 'invalid' | 'opening_balance' | 'metadata_unverified' | 'closing_balance'
  entryId?: string | null
}
export interface SIEResyncSummary {
  added: number
  unchanged: number
  reviewCount: number
  reviews: SIEResyncReview[]
  metadataChanged: boolean
}
export interface SIEResyncPlan extends SIEResyncSummary {
  periodId: string
  newOrdinals: number[]
}
const PREVIEW_ID = '00000000-0000-4000-8000-000000000001'
const voucherHash = (value: unknown) => hashSIEPayload(JSON.parse(JSON.stringify(value)))
const reference = (series: string | null, number: number | null) => JSON.stringify([series, number])
const metadataHash = (parsed: ParsedSIEFile, currentAccountNames: ReadonlySet<string>) => hashSIEPayload({
  // An account is company-wide, while these archives belong to individual
  // years. A later import may already have applied the incoming name.
  accounts: parsed.accounts.map(account => currentAccountNames.has(account.number)
    ? {...account,name:''} : account).sort((a, b) => a.number.localeCompare(b.number)),
  dimensions: parsed.dimensions, values: parsed.dimensionValues,
  opening: getEffectiveOpeningBalances(parsed).balances,
  objects: parsed.objectOpeningBalances ?? [],
  closing: parsed.closingBalances, results: parsed.resultBalances, objectClosing: parsed.objectClosingBalances ?? [],
})

/** Read-only comparison. No account, journal, import or document is created. */
export async function planSIEResync(supabase: SupabaseClient, companyId: string, userId: string,
  parsed: ParsedSIEFile, mappings: AccountMapping[], voucherSeries = 'B',
): Promise<SIEResyncPlan | null> {
  const { data: periods, error: periodError } = await supabase.from('fiscal_periods').select('id')
    .eq('company_id', companyId).eq('period_start', parsed.stats.fiscalYearStart!).eq('period_end', parsed.stats.fiscalYearEnd!).limit(2)
  if (periodError) throw new Error(periodError.message)
  if (!periods?.length) return null
  if (periods.length !== 1) throw new Error('SIE fiscal period is ambiguous')
  const periodId = periods[0].id as string
  const existing = await fetchAllRows<{ id: string; source_voucher_series: string | null; source_voucher_number: number | null }>(
    ({ from, to }) => supabase.from('journal_entries').select('id,source_voucher_series,source_voucher_number')
      .eq('company_id', companyId).eq('fiscal_period_id', periodId).eq('source_type', 'import').eq('status', 'posted')
      .is('reversed_by_id', null).order('id').range(from, to))
  const { data: baseline, error: baselineError } = await supabase.from('sie_imports').select('*')
    .eq('company_id', companyId).eq('fiscal_period_id', periodId).eq('status', 'completed')
    .neq('manifest->input->options->>onExistingPeriod', 'incremental').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (baselineError) throw new Error(baselineError.message)
  // An existing empty period is still a first import.
  if (!baseline && !existing.length) return null
  const accounts = await fetchAllRows<{ id: string; account_number: string; account_name: string }>(({ from, to }) => supabase.from('chart_of_accounts')
    .select('id,account_number,account_name').eq('company_id', companyId).order('account_number').range(from, to))
  const accountMap = mappingsToMap(mappings)
  const chartNames = new Map(accounts.map(row => [row.account_number,row.account_name]))
  const currentAccountNames = new Set(parsed.accounts.filter(account =>
    accountMap.get(account.number) === account.number && chartNames.get(account.number) === account.name,
  ).map(account => account.number))
  const prepared = await importVouchers(supabase, companyId, userId, periodId, parsed, accountMap, voucherSeries,
    PREVIEW_ID, { only: true, startOrdinal: 0, hasCurrentYearIb: getEffectiveOpeningBalances(parsed).balances.length > 0,
      accountIds: new Map(accounts.map(row => [row.account_number, row.id])) })
  const entries = prepared.preparedEntries ?? []
  const inputReferences = new Set(parsed.vouchers.filter(v => v.series && !v.numberOmitted).map(v => reference(v.series, v.number)))
  const claims = new Map<string, number>()
  for (const entry of entries) {
    const key = reference(entry.sourceSeries, entry.sourceNumber)
    claims.set(key, (claims.get(key) ?? 0) + 1)
  }
  const reviews: SIEResyncReview[] = prepared.skippedDetails.map(row => ({ sourceId: row.voucherId, kind: 'invalid' }))
  const newOrdinals: number[] = []
  let unchanged = 0
  for (const batch of chunkSIEEntries(entries)) {
    const { data, error } = await supabase.rpc('classify_sie_resync_entries', { p_company_id: companyId, p_period_id: periodId, p_entries: batch })
    if (error) throw new Error(error.message)
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error('SIE comparison is incomplete')
    for (let i = 0; i < batch.length; i++) {
      const entry: SIEPreparedEntry = batch[i]
      const row = data.find(result => result.source_ordinal === entry.sourceOrdinal)
      if (!row) throw new Error('SIE comparison result missing')
      const duplicate = (claims.get(reference(entry.sourceSeries, entry.sourceNumber)) ?? 0) > 1
      if (duplicate) reviews.push({ sourceId: entry.sourceId, kind: 'ambiguous', entryId: row.entry_id })
      else if (row.outcome === 'unchanged') unchanged++
      else if (row.outcome === 'new' && entry.sourceType !== 'opening_balance') newOrdinals.push(entry.sourceOrdinal)
      else reviews.push({ sourceId: entry.sourceId, kind: row.outcome === 'new' ? 'opening_balance' : row.outcome, entryId: row.entry_id })
    }
  }
  for (const entry of existing) if (entry.source_voucher_series && entry.source_voucher_number !== null
    && !inputReferences.has(reference(entry.source_voucher_series, entry.source_voucher_number))) {
    reviews.push({ sourceId: `${entry.source_voucher_series}${entry.source_voucher_number}`, kind: 'removed', entryId: entry.id })
  }
  let metadataChanged = false
  if (baseline?.file_storage_path && baseline.job_state) {
    const original = parseSIEFile(await readSIEJobSource(supabase, baseline as SIEJob))
    const {data:latest,error:latestError} = await supabase.from('sie_imports').select('*')
      .eq('company_id',companyId).eq('fiscal_period_id',periodId).eq('status','completed')
      .order('created_at',{ascending:false}).limit(1).maybeSingle()
    if (latestError) throw new Error(latestError.message)
    const oldReferences = new Set(original.vouchers.filter(v=>v.series && !v.numberOmitted).map(v=>reference(v.series,v.number)))
    for (let i=newOrdinals.length-1;i>=0;i--) {
      const entry=entries.find(value=>value.sourceOrdinal===newOrdinals[i])!
      if (oldReferences.has(reference(entry.sourceSeries,entry.sourceNumber))) {
        newOrdinals.splice(i,1)
        reviews.push({sourceId:entry.sourceId,kind:'changed'})
      }
    }
    if (prepared.skippedDetails.length && Array.isArray(baseline.manifest?.input?.mappings)) {
      const oldPrepared=await importVouchers(supabase,companyId,userId,periodId,original,
        mappingsToMap(baseline.manifest.input.mappings),baseline.manifest.input.options.voucherSeries ?? 'B',PREVIEW_ID,
        {only:true,startOrdinal:0,hasCurrentYearIb:getEffectiveOpeningBalances(original).balances.length>0,
          accountIds:new Map(accounts.map(row=>[row.account_number,row.id]))})
      for (const skipped of prepared.skippedDetails) {
        const sameSkip=oldPrepared.skippedDetails.some(old=>old.voucherId===skipped.voucherId && old.reason===skipped.reason)
        const current=parsed.vouchers.filter(v=>`${v.series}${v.number}`===skipped.voucherId && !v.numberOmitted)
        const old=original.vouchers.filter(v=>`${v.series}${v.number}`===skipped.voucherId && !v.numberOmitted)
        if (sameSkip && current.length===1 && old.length===1 && voucherHash(current[0])===voucherHash(old[0])) {
          const index=reviews.findIndex(review=>review.sourceId===skipped.voucherId && review.kind==='invalid')
          if(index>=0){reviews.splice(index,1);unchanged++}
        }
      }
    }
    const lastSource = latest?.id && latest.id!==baseline.id ? parseSIEFile(await readSIEJobSource(supabase,latest as SIEJob)) : original
    metadataChanged = metadataHash(lastSource,currentAccountNames) !== metadataHash(parsed,currentAccountNames)
    const priorClosingReview = (latest?.job_result?.resync?.reviews as SIEResyncReview[] | undefined)?.some(review => review.kind==='closing_balance')
    if ((hashSIEPayload(lastSource.closingBalances) !== hashSIEPayload(parsed.closingBalances) || priorClosingReview) && newOrdinals.length === 0 && reviews.length === 0) {
      reviews.push({sourceId:'UB',kind:'closing_balance'})
    }
    if (hashSIEPayload(getEffectiveOpeningBalances(original).balances) !== hashSIEPayload(getEffectiveOpeningBalances(parsed).balances)
      || hashSIEPayload(original.objectOpeningBalances ?? []) !== hashSIEPayload(parsed.objectOpeningBalances ?? [])) {
      reviews.push({ sourceId: 'IB', kind: 'opening_balance' })
    }
  } else {
    for(const ordinal of newOrdinals) reviews.push({sourceId:entries.find(entry=>entry.sourceOrdinal===ordinal)!.sourceId,kind:'metadata_unverified'})
    newOrdinals.length=0
    reviews.push({ sourceId: 'IB', kind: 'metadata_unverified' })
  }
  return { periodId, added: newOrdinals.length, unchanged, reviewCount: reviews.length,
    reviews: reviews.slice(0, 200), metadataChanged, newOrdinals }
}
