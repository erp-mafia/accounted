/**
 * The corrections that stop an SIE import from being undone or replaced,
 * named for the reader (PH 223).
 *
 * request_sie_import_undo refuses while a verifikat of the import has a live
 * correction: a rättelse reached through correction_of_id (any depth) that is
 * a draft or posted and is not itself part of the import. Undoing the import
 * stornos the original and leaves the correction in the ledger; a
 * replacement (replace_sie_import_job undoes the previous import first) then
 * books the provider's version beside it, so the correction would count
 * twice. The guard is right, but it raised an English sentence that every
 * door answered as the generic CONFLICT, "En konflikt uppstod. Ladda om sidan
 * och försök igen.": a retry never helps, and nothing said which verifikat
 * were in the way.
 *
 * jobDatabaseError gives the refusal its own code, and nameLiveCorrections
 * (sie-jobs.ts) asks this module which verifikat collide (read only, the RPC
 * has already rolled back) and for the sentence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

/** One imported verifikat and the live correction that descends from it. */
export interface LiveCorrection {
  /** The imported verifikat, e.g. "D980"; null when it has no number. */
  original: string | null
  /** The live correction, e.g. "D1471"; null for a draft (no number yet). */
  correction: string | null
}

interface EntryRow {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  correction_of_id: string | null
  import_batch_id: string | null
}

// Prod (2026-10-27): corrections stack at most 3 deep below an imported
// verifikat. The bound only stops a cycle.
const MAX_DEPTH = 10
const ID_CHUNK = 100
const NAMED = 5

function label(row: EntryRow): string | null {
  return row.voucher_number ? formatVoucher(row) : null
}

/**
 * Every live correction that descends from a verifikat of `importId`, with
 * the imported verifikat it corrects. Read with the caller's client (RLS
 * scoped) and filtered by company. Corrections are few, so the read starts
 * from the company's live corrections and walks up correction_of_id, rather
 * than down from every verifikat of the import.
 */
export async function findLiveCorrections(
  supabase: SupabaseClient, companyId: string, importId: string,
): Promise<LiveCorrection[]> {
  const live = await fetchAllRows<EntryRow>(({ from, to }) => supabase.from('journal_entries')
    .select('id, voucher_series, voucher_number, correction_of_id, import_batch_id')
    .eq('company_id', companyId)
    .not('correction_of_id', 'is', null)
    .in('status', ['draft', 'posted'])
    .order('id')
    .range(from, to))
  const candidates = live.filter(row => row.import_batch_id !== importId)
  if (candidates.length === 0) return []

  const known = new Map<string, EntryRow>(live.map(row => [row.id, row]))
  let frontier = [...new Set(candidates.map(row => row.correction_of_id!))].filter(id => !known.has(id))
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const fetched: EntryRow[] = []
    for (let i = 0; i < frontier.length; i += ID_CHUNK) {
      const { data, error } = await supabase.from('journal_entries').select('id, voucher_series, voucher_number, correction_of_id, import_batch_id')
        .eq('company_id', companyId).in('id', frontier.slice(i, i + ID_CHUNK))
      if (error) throw error
      fetched.push(...(data ?? []) as EntryRow[])
    }
    for (const row of fetched) known.set(row.id, row)
    frontier = [...new Set(fetched
      .filter(row => row.import_batch_id !== importId && row.correction_of_id)
      .map(row => row.correction_of_id!))].filter(id => !known.has(id))
  }

  const found: Array<LiveCorrection & { order: number }> = []
  for (const correction of candidates) {
    let node = known.get(correction.correction_of_id!)
    for (let depth = 0; node && depth < MAX_DEPTH; depth++) {
      if (node.import_batch_id === importId) {
        found.push({ original: label(node), correction: label(correction), order: correction.voucher_number ?? Infinity })
        break
      }
      node = node.correction_of_id ? known.get(node.correction_of_id) : undefined
    }
  }
  return found.sort((a, b) => a.order - b.order).map(({ original, correction }) => ({ original, correction }))
}

/**
 * The Swedish refusal: which imported verifikat were corrected, by which
 * correction, why that stops the action, and what to do instead.
 */
export function liveCorrectionSentence(corrections: LiveCorrection[], action: 'undo' | 'replace'): string {
  const named = corrections.slice(0, NAMED).map(({ original, correction }) =>
    `${original ?? 'ett verifikat'} med ${correction ? `rättelse ${correction}` : 'en rättelse som är ett utkast'}`)
  const rest = corrections.length - named.length
  const list = named.join(', ') + (rest > 0 ? ` och ${rest} till` : '')
  const head = action === 'replace'
    ? 'Den tidigare importen av räkenskapsåret kan inte ersättas'
    : 'Importen kan inte ångras'
  const why = action === 'replace'
    ? 'Rättelserna skulle ligga kvar och räknas dubbelt bredvid den nya importen.'
    : 'Rättelserna skulle ligga kvar utan sina original.'
  const next = action === 'replace'
    ? 'och importera sedan året igen. Vill du behålla rättelserna, behåll den tidigare importen av året.'
    : 'och ångra sedan importen.'
  return `${head}: verifikat från importen har rättats efter importen (${list}). ${why} ` +
    `Återför rättelserna först (öppna verifikationen under Bokföring > Verifikationer och välj Återför (storno)), ${next}`
}
