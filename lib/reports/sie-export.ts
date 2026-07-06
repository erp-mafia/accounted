import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getBranding } from '@/lib/branding/service'
import { createLogger } from '@/lib/logger'
import { getOpeningBalances } from './opening-balances'
import type { SIEExportOptions, JournalEntry, JournalEntryLine, BASAccount } from '@/types'

const log = createLogger('reports:sie-export')

function sanitizeProgramName(str: string): string {
  return str.replace(/"/g, '').replace(/[\r\n]/g, ' ').substring(0, 60)
}

/**
 * Generate SIE4 export file
 *
 * SIE (Standard Import Export) is the Swedish standard format for
 * transferring accounting data between systems.
 *
 * Format: CP437 encoded text file (we'll use UTF-8 as modern systems accept it)
 * Line format: #TAG field1 field2 ...
 */
// Unicode codepoint → CP437 byte for characters used in Swedish accounting data.
// Covers all six Swedish vowel variants plus common Western European accented letters.
const CP437: Record<number, number> = {
  0x00C7: 0x80, 0x00FC: 0x81, 0x00E9: 0x82, 0x00E2: 0x83,
  0x00E4: 0x84, 0x00E0: 0x85, 0x00E5: 0x86, 0x00E7: 0x87,
  0x00EA: 0x88, 0x00EB: 0x89, 0x00E8: 0x8A, 0x00EF: 0x8B,
  0x00EE: 0x8C, 0x00EC: 0x8D, 0x00C4: 0x8E, 0x00C5: 0x8F,
  0x00C9: 0x90, 0x00E6: 0x91, 0x00C6: 0x92, 0x00F4: 0x93,
  0x00F6: 0x94, 0x00F2: 0x95, 0x00FB: 0x96, 0x00F9: 0x97,
  0x00FF: 0x98, 0x00D6: 0x99, 0x00DC: 0x9A, 0x00A2: 0x9B,
  0x00A3: 0x9C, 0x00A5: 0x9D, 0x00E1: 0xA0, 0x00ED: 0xA1,
  0x00F3: 0xA2, 0x00FA: 0xA3, 0x00F1: 0xA4, 0x00D1: 0xA5,
}

export function encodeSIEToCP437(text: string): Uint8Array {
  const bytes: number[] = []
  for (const char of text) {
    const cp = char.codePointAt(0)!
    bytes.push(cp < 0x80 ? cp : (CP437[cp] ?? 0x3F))
  }
  return new Uint8Array(bytes)
}

export async function generateSIEExport(
  supabase: SupabaseClient,
  companyId: string,
  options: SIEExportOptions
): Promise<string> {

  // Fetch fiscal period
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', options.fiscal_period_id)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  // Fetch previous fiscal year for #RAR -1 (per SIE spec, both years should be present)
  const { data: prevPeriod } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('company_id', companyId)
    .lt('period_end', period.period_start)
    .order('period_end', { ascending: false })
    .limit(1)
    .single()

  // Fetch all accounts
  const accounts = await fetchAllRows(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('account_number')
      .range(from, to)
  )

  // Fetch all posted journal entries: paginated to avoid truncation.
  // The previous nested `select('*, lines:journal_entry_lines(*)')` hit
  // PostgREST's response-row ceiling on the embedded resource and silently
  // truncated large periods (~30 vouchers). Fetch entries and lines as two
  // separate paginated queries and stitch them together in memory, mirroring
  // journal-register.ts.
  const entries = await fetchAllRows<JournalEntry>(({ from, to }) => {
    let q = supabase
      .from('journal_entries')
      .select('*')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', options.fiscal_period_id)
      .in('status', ['posted', 'reversed'])

    if (options.exclude_year_end_closing) {
      q = q.neq('source_type', 'year_end')
    }

    // Stable TOTAL order: voucher_series + voucher_number is unique per
    // company+period, so fetchAllRows paging can't duplicate or skip a voucher
    // across the 1000-row boundary on large years (voucher_number alone is not
    // unique across series). dedupeBy is defense-in-depth: see fetch-all.ts.
    return q
      .order('voucher_series', { ascending: true })
      .order('voucher_number', { ascending: true })
      .range(from, to)
  }, { dedupeBy: (r) => r.id })

  // Fetch all lines for those entries, filtered server-side via an inner join
  // so the same company/period/status (and year-end exclusion) constraints
  // apply, then group by journal_entry_id.
  const allLines = await fetchAllRows<JournalEntryLine & { journal_entry_id: string }>(({ from, to }) => {
    let q = supabase
      .from('journal_entry_lines')
      .select('*, journal_entries!inner(company_id, fiscal_period_id, status, source_type)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', options.fiscal_period_id)
      .in('journal_entries.status', ['posted', 'reversed'])

    if (options.exclude_year_end_closing) {
      q = q.neq('journal_entries.source_type', 'year_end')
    }

    // Stable total order on the line PK so paging can't duplicate/skip a line
    // across the 1000-row boundary; dedupeBy is the defense-in-depth net.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return q.order('id', { ascending: true }).range(from, to) as any
  }, { dedupeBy: (r) => r.id })

  const linesByEntryId = new Map<string, JournalEntryLine[]>()
  for (const line of allLines) {
    const list = linesByEntryId.get(line.journal_entry_id)
    if (list) {
      list.push(line)
    } else {
      linesByEntryId.set(line.journal_entry_id, [line])
    }
  }

  for (const entry of entries) {
    entry.lines = linesByEntryId.get(entry.id) || []
  }

  // Fetch the dimension registry (#DIM/#UNDERDIM + #OBJEKT source).
  // Deliberately NO is_active filter: lines referencing archived codes still
  // serialize into #TRANS object lists, and Visma rejects files whose #TRANS
  // references an undeclared #OBJEKT (plan §5 latent bug #2: the legacy
  // cost_centers/projects read filtered is_active=true and dropped them).
  const { data: registryDimensions } = await supabase
    .from('dimensions')
    .select('id, sie_dim_no, parent_sie_dim_no, name')
    .eq('company_id', companyId)
    .order('sie_dim_no')

  const { data: registryValues } = await supabase
    .from('dimension_values')
    .select('dimension_id, code, name')
    .eq('company_id', companyId)
    .order('code')

  const lines: string[] = []
  const now = new Date()

  // === Header ===
  lines.push('#FLAGGA 0')
  if (options.emit_format_pc8) lines.push('#FORMAT PC8')
  lines.push('#SIETYP 4')
  const programName = sanitizeProgramName(options.program_name || getBranding().appName)
  lines.push(`#PROGRAM "${programName}" "1.0"`)
  lines.push(`#GEN ${formatSIEDate(now)}`)

  if (options.org_number) {
    lines.push(`#ORGNR ${options.org_number}`)
  }

  lines.push(`#FNAMN "${escapeQuotes(options.company_name)}"`)

  // === Fiscal year ===
  // #RAR 0 = current year, #RAR -1 = previous year (both should be present per spec)
  // Use date strings directly to avoid timezone conversion issues
  lines.push(`#RAR 0 ${dateStringToSIE(period.period_start)} ${dateStringToSIE(period.period_end)}`)

  if (prevPeriod) {
    lines.push(`#RAR -1 ${dateStringToSIE(prevPeriod.period_start)} ${dateStringToSIE(prevPeriod.period_end)}`)
  }

  // === Dimension definitions (#DIM / #UNDERDIM) + objects (#OBJEKT) ===
  lines.push(
    ...buildDimensionSection(registryDimensions ?? [], registryValues ?? [], allLines)
  )

  // === Chart of accounts ===
  for (const account of (accounts as BASAccount[]) || []) {
    lines.push(`#KONTO ${account.account_number} "${escapeQuotes(account.account_name)}"`)

    // #SRU records from chart_of_accounts.sru_code
    if (account.sru_code) {
      lines.push(`#SRU ${account.account_number} ${account.sru_code}`)
    }
  }

  // === Opening balances (IB) ===
  // Routes through getOpeningBalances() so we get the same fallback as trial
  // balance / balance sheet: when opening_balance_entry_id is NULL: which is
  // expected after continuation SIE imports (sie-import.ts skips creating an
  // IB entry once prior posted activity exists), the compute_prior_opening_
  // balances RPC derives IB from earlier journal lines instead of silently
  // emitting zero #IB records and producing wrong #UB values.
  const openingBalancesByAccount = new Map<string, number>()
  const { balances: obBalances, obEntryId } = await getOpeningBalances(supabase, companyId, {
    period_start: period.period_start,
    opening_balance_entry_id: period.opening_balance_entry_id ?? null,
  })

  for (const [accountNumber, { debit, credit }] of obBalances) {
    const amount = Math.round(((Number(debit) || 0) - (Number(credit) || 0)) * 100) / 100
    if (amount === 0) continue
    lines.push(`#IB 0 ${accountNumber} ${formatAmount(amount)}`)
    openingBalancesByAccount.set(accountNumber, amount)
  }

  // Exclude the OB entry from VER/TRANS and from movement calculations to
  // prevent double-counting: it is already represented by the #IB records above.
  const periodEntries = (entries as JournalEntry[])?.filter(e => e.id !== obEntryId) ?? []

  // === Journal entries (VER + TRANS) ===
  for (const entry of periodEntries) {
    const entryLines = (entry.lines as JournalEntryLine[]) || []
    const entryDate = dateStringToSIE(entry.entry_date)
    const series = entry.voucher_series || 'A'
    const description = escapeQuotes(entry.description)

    lines.push(`#VER "${series}" ${entry.voucher_number} ${entryDate} "${description}"`)
    lines.push('{')

    for (const line of entryLines) {
      const amount =
        line.debit_amount > 0
          ? line.debit_amount
          : -line.credit_amount

      const lineDesc = line.line_description
        ? ` "${escapeQuotes(line.line_description)}"`
        : ''

      // Build dimension object list for #TRANS from the jsonb map: the
      // single source of truth. The legacy cost_center/project columns are
      // derived mirrors of keys '1'/'6' and are no longer read here.
      const dimParts = lineDimensionEntries(line.dimensions).map(
        ([dimNo, code]) => `${dimNo} "${escapeQuotes(code)}"`
      )
      const objList = dimParts.length > 0 ? `{${dimParts.join(' ')}}` : '{}'

      lines.push(`\t#TRANS ${line.account_number} ${objList} ${formatAmount(amount)} ${entryDate}${lineDesc}`)
    }

    lines.push('}')
  }

  // === Closing balances (UB for balance sheet, RES for income statement) ===
  // Movement balances from journal entries
  const movementBalances = calculateBalances(periodEntries)

  // Merge all accounts that have either IB or movements
  const allAccountNumbers = new Set([
    ...openingBalancesByAccount.keys(),
    ...movementBalances.keys(),
  ])

  for (const accountNumber of [...allAccountNumbers].sort()) {
    const accountClass = parseInt(accountNumber[0])
    const ib = openingBalancesByAccount.get(accountNumber) || 0
    const movement = movementBalances.get(accountNumber) || 0

    if (accountClass <= 2) {
      // Balance sheet: UB = IB + movements during period
      const ub = Math.round((ib + movement) * 100) / 100
      lines.push(`#UB 0 ${accountNumber} ${formatAmount(ub)}`)
    } else {
      // Income statement: RES = movements only (IB should be zero)
      lines.push(`#RES 0 ${accountNumber} ${formatAmount(movement)}`)
    }
  }

  return lines.join('\r\n') + '\r\n'
}

/**
 * Format a Date object for SIE: YYYYMMDD
 */
function formatSIEDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Convert a "YYYY-MM-DD" date string to SIE format "YYYYMMDD"
 * without going through Date object (avoids timezone issues)
 */
function dateStringToSIE(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

/**
 * Format amount for SIE (no thousands separator, . as decimal)
 */
function formatAmount(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  return rounded.toFixed(2)
}

/**
 * Escape double quotes in SIE strings
 */
function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"')
}

// ── Dimensions (#DIM / #UNDERDIM / #OBJEKT) ─────────────────────────────────

interface RegistryDimension {
  id: string
  sie_dim_no: number
  parent_sie_dim_no: number | null
  name: string
}

interface RegistryValue {
  dimension_id: string
  code: string
  name: string
}

/**
 * SIE reserved dimension numbers. Used to synthesize a #DIM declaration for
 * dimension numbers referenced by exported lines but absent from the registry:
 * free-text writers can still mint arbitrary numbers until the write-path
 * PR lands, and an undeclared dimension would make importers reject the file.
 * Dim 2 (kostnadsbärare) is a reserved sub-dimension of 1 → #UNDERDIM.
 */
export const SIE_RESERVED_DIMENSIONS: Record<number, { name: string; parent?: number }> = {
  1: { name: 'Kostnadsställe' },
  2: { name: 'Kostnadsbärare', parent: 1 },
  6: { name: 'Projekt' },
  7: { name: 'Anställd' },
  8: { name: 'Kund' },
  9: { name: 'Leverantör' },
  10: { name: 'Faktura' },
}

/**
 * Normalize a line's jsonb dimensions map ({"1":"KS01","6":"P001"}) into
 * [dimNo, code] entries sorted by numeric dimension number. Defensive on
 * shape: non-numeric keys and blank codes are skipped, and duplicate keys
 * ('01' vs '1') collapse onto the canonical number with last-write-wins:
 * mirroring normalizeLineDimensions in lib/bookkeeping/dimension-resolver.ts.
 */
function lineDimensionEntries(dimensions: unknown): Array<[number, string]> {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    return []
  }
  const byDimNo = new Map<number, string>()
  for (const [key, value] of Object.entries(dimensions as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue
    const dimNo = Number(key)
    if (dimNo < 1) continue
    const code = typeof value === 'string' ? value.trim() : ''
    if (!code) continue
    byDimNo.set(dimNo, code)
  }
  return [...byDimNo.entries()].sort((a, b) => a[0] - b[0])
}

/**
 * Build the #DIM/#UNDERDIM + #OBJEKT section from the dimension registry and
 * the exported journal lines.
 *
 * Completeness guarantee: every (dimNo, code) pair referenced by any exported
 * line gets an #OBJEKT record: registry rows contribute their name, orphan
 * codes (no registry row) synthesize name = code, and dimension numbers with
 * no registry row synthesize a #DIM from the SIE reserved-number seed. A file
 * whose #TRANS references an undeclared object is rejected by Visma et al.
 *
 * Silence guarantee: registry dimensions with no values and no line
 * references (e.g. lazily seeded system dims 1/6 that were never used) emit
 * nothing, so companies that never touch dimensions keep dimension-free files.
 */
function buildDimensionSection(
  registryDimensions: RegistryDimension[],
  registryValues: RegistryValue[],
  journalLines: JournalEntryLine[]
): string[] {
  // Defence in depth: a value row whose dimension_id doesn't resolve in
  // dimNoById is skipped by construction (the `continue` below). Both fetches
  // are scoped to the same company_id (query filter + RLS), so every
  // dimension_id in registryValues should resolve; a miss can only mean the
  // dimension row vanished mid-export: skipping just omits its #OBJEKT,
  // never leaks a foreign company's data into the file.
  const dimsByNo = new Map<number, RegistryDimension>()
  const dimNoById = new Map<string, number>()
  for (const dim of registryDimensions) {
    dimsByNo.set(dim.sie_dim_no, dim)
    dimNoById.set(dim.id, dim.sie_dim_no)
  }

  // Registry values grouped by dimension number: dimNo → (code → name)
  const valuesByDimNo = new Map<number, Map<string, string>>()
  for (const value of registryValues) {
    const dimNo = dimNoById.get(value.dimension_id)
    if (dimNo === undefined) continue
    let codeMap = valuesByDimNo.get(dimNo)
    if (!codeMap) {
      codeMap = new Map()
      valuesByDimNo.set(dimNo, codeMap)
    }
    if (!codeMap.has(value.code)) codeMap.set(value.code, value.name)
  }

  // (dimNo, code) pairs referenced by exported lines
  const referencedByDimNo = new Map<number, Set<string>>()
  for (const line of journalLines) {
    for (const [dimNo, code] of lineDimensionEntries(line.dimensions)) {
      let codes = referencedByDimNo.get(dimNo)
      if (!codes) {
        codes = new Set()
        referencedByDimNo.set(dimNo, codes)
      }
      codes.add(code)
    }
  }

  const emitDimNos = new Set<number>([
    ...valuesByDimNo.keys(),
    ...referencedByDimNo.keys(),
  ])

  const declarationFor = (dimNo: number): { name: string; parent: number | null } => {
    const dim = dimsByNo.get(dimNo)
    if (dim) return { name: dim.name, parent: dim.parent_sie_dim_no ?? null }
    const reserved = SIE_RESERVED_DIMENSIONS[dimNo]
    return { name: reserved?.name ?? `Dimension ${dimNo}`, parent: reserved?.parent ?? null }
  }

  // An #UNDERDIM must not reference an undeclared parent: pull parents into
  // the emit set transitively (the has-guard also breaks registry cycles).
  const pending = [...emitDimNos]
  while (pending.length > 0) {
    const { parent } = declarationFor(pending.pop()!)
    if (parent !== null && !emitDimNos.has(parent)) {
      emitDimNos.add(parent)
      pending.push(parent)
    }
  }

  const sortedDimNos = [...emitDimNos].sort((a, b) => a - b)
  const out: string[] = []

  // Synthesized placeholders collected for the operator warning below:
  // #DIM "Dimension n" fallbacks and #OBJEKT rows with name = code.
  const synthesizedDimNos: number[] = []
  const orphanObjects: Array<{ dimNo: number; code: string }> = []

  // Two passes: every root #DIM first (sorted by sie_dim_no), then every
  // #UNDERDIM (sorted by sie_dim_no). SIE4 requires a parent to be declared
  // before any #UNDERDIM referencing it, and a child may carry a LOWER
  // number than its parent, so a single numeric sort is not enough.
  for (const dimNo of sortedDimNos) {
    const { name, parent } = declarationFor(dimNo)
    if (parent !== null) continue
    if (!dimsByNo.has(dimNo) && !SIE_RESERVED_DIMENSIONS[dimNo]) {
      synthesizedDimNos.push(dimNo)
    }
    out.push(`#DIM ${dimNo} "${escapeQuotes(name)}"`)
  }

  // "Dimension n" fallbacks never carry a parent (declarationFor only
  // assigns parents from the registry or the reserved seed), so #UNDERDIM
  // lines are never synthesized placeholders.
  for (const dimNo of sortedDimNos) {
    const { name, parent } = declarationFor(dimNo)
    if (parent === null) continue
    out.push(`#UNDERDIM ${dimNo} "${escapeQuotes(name)}" ${parent}`)
  }

  for (const dimNo of sortedDimNos) {
    const registry = valuesByDimNo.get(dimNo) ?? new Map<string, string>()
    const codes = new Set<string>([
      ...registry.keys(),
      ...(referencedByDimNo.get(dimNo) ?? []),
    ])
    for (const code of [...codes].sort((a, b) => a.localeCompare(b, 'sv'))) {
      const registryName = registry.get(code)
      if (registryName === undefined) {
        orphanObjects.push({ dimNo, code })
      }
      out.push(
        `#OBJEKT ${dimNo} "${escapeQuotes(code)}" "${escapeQuotes(registryName ?? code)}"`
      )
    }
  }

  // Operators must know the file contains synthesized placeholder names
  // (BFNAR 2013:2 behandlingshistorik): one structured warning listing the
  // pairs; silent when the registry covered everything.
  if (orphanObjects.length > 0 || synthesizedDimNos.length > 0) {
    log.warn('SIE export synthesized placeholder dimension declarations', {
      orphanObjects,
      synthesizedDimNos,
    })
  }

  return out
}

/**
 * Calculate net balances per account from journal entries
 */
function calculateBalances(
  entries: JournalEntry[]
): Map<string, number> {
  const balances = new Map<string, number>()

  for (const entry of entries || []) {
    const lines = (entry.lines as JournalEntryLine[]) || []
    for (const line of lines) {
      const current = balances.get(line.account_number) || 0
      const netAmount = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
      balances.set(line.account_number, Math.round((current + netAmount) * 100) / 100)
    }
  }

  return balances
}
