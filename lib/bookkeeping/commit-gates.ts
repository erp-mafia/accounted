/**
 * Pre-commit compliance gates for Fastställ (ADR 013).
 * Runs in API layer — does not modify the bookkeeping engine.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  evaluateBflTiming,
  inferCashKind,
  type BflTimingIssue,
} from '@/lib/bookkeeping/bfl-timing'
import { getLedgerMode, type OmbraLedgerMode } from '@/lib/obx/ledger-mode'

export type CommitGateResult = {
  ok: boolean
  issues: BflTimingIssue[]
  blocked: BflTimingIssue[]
  warnings: BflTimingIssue[]
}

export async function evaluateCommitGates(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
  opts: { today?: string; ledgerMode?: OmbraLedgerMode } = {},
): Promise<CommitGateResult> {
  const mode = opts.ledgerMode ?? getLedgerMode()
  const today = (opts.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10)

  const { data: entry, error } = await supabase
    .from('journal_entries')
    .select('id, entry_date, description, status, company_id')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  if (!entry) {
    return { ok: false, issues: [], blocked: [], warnings: [] }
  }

  const { data: lines } = await supabase
    .from('journal_lines')
    .select('account_number')
    .eq('journal_entry_id', entryId)

  const accountNumbers = (lines ?? []).map((l) => String(l.account_number))
  const kind = inferCashKind({
    description: entry.description,
    accountNumbers,
  })

  const issue = evaluateBflTiming({
    entryDate: String(entry.entry_date).slice(0, 10),
    bookedOn: today,
    kind,
  })

  const issues = issue ? [issue] : []
  const blocked: BflTimingIssue[] = []
  const warnings: BflTimingIssue[] = []

  for (const i of issues) {
    if (i.severity === 'warn') {
      warnings.push(i)
      continue
    }
    // Cash late always blocks. 50-day block only on hosted SoR.
    if (i.code === 'CASH_LATE') {
      blocked.push(i)
    } else if (i.code === 'OTHER_OVER_50_DAYS' && mode === 'hosted') {
      blocked.push(i)
    } else {
      warnings.push({ ...i, severity: 'warn' })
    }
  }

  return {
    ok: blocked.length === 0,
    issues,
    blocked,
    warnings,
  }
}
