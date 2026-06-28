import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getBranding } from '@/lib/branding/service'
import { getOpeningBalances } from './opening-balances'
import type { SIEExportOptions, JournalEntry, JournalEntryLine, BASAccount } from '@/types'

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

  // Fetch all posted journal entries — paginated to avoid truncation.
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
    // unique across series). dedupeBy is defense-in-depth — see fetch-all.ts.
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

  // Fetch cost centers and projects for dimension records
  const { data: costCenters } = await supabase
    .from('cost_centers')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('code')

  const { data: projects } = await supabase
    .from('projects')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
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

  // === Dimension definitions ===
  // SIE standard: dimension 1 = kostnadsställe, dimension 6 = projekt
  const hasCostCenters = costCenters && costCenters.length > 0
  const hasProjects = projects && projects.length > 0

  if (hasCostCenters) {
    lines.push('#DIM 1 "Kostnadsställe"')
  }
  if (hasProjects) {
    lines.push('#DIM 6 "Projekt"')
  }

  // === Dimension objects (#OBJEKT) ===
  for (const cc of costCenters || []) {
    lines.push(`#OBJEKT 1 "${escapeQuotes(cc.code)}" "${escapeQuotes(cc.name)}"`)
  }
  for (const proj of projects || []) {
    lines.push(`#OBJEKT 6 "${escapeQuotes(proj.code)}" "${escapeQuotes(proj.name)}"`)
  }

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
  // balance / balance sheet: when opening_balance_entry_id is NULL — which is
  // expected after continuation SIE imports (sie-import.ts skips creating an
  // IB entry once prior posted activity exists) — the compute_prior_opening_
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

      // Build dimension object list for #TRANS line
      const dimParts: string[] = []
      if (line.cost_center) {
        dimParts.push(`1 "${escapeQuotes(line.cost_center)}"`)
      }
      if (line.project) {
        dimParts.push(`6 "${escapeQuotes(line.project)}"`)
      }
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
