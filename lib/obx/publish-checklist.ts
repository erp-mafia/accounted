/**
 * Pre-publish checklist before hybrid OBX year-seal upload to hosted SoR (ADR 013).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyArchiveChain } from '@/lib/import/obx-module-import'
import {
  evaluateBflTiming,
  inferCashKind,
  type BflTimingIssue,
} from '@/lib/bookkeeping/bfl-timing'
import { canPublishToHosted, getLedgerMode } from '@/lib/obx/ledger-mode'

export type PublishChecklistItem = {
  id: string
  ok: boolean
  severity: 'block' | 'warn' | 'info'
  message: string
}

export type PublishChecklistResult = {
  ok: boolean
  can_publish: boolean
  ledger_mode: string
  fiscal_year: number
  items: PublishChecklistItem[]
  timing_issues: BflTimingIssue[]
  open_draft_count: number
}

export async function runPublishChecklist(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYear: number,
  opts: { today?: string } = {},
): Promise<PublishChecklistResult> {
  const today = (opts.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
  const yearStart = `${fiscalYear}-01-01`
  const yearEnd = `${fiscalYear}-12-31`
  const items: PublishChecklistItem[] = []
  const timing_issues: BflTimingIssue[] = []

  const mode = getLedgerMode()
  items.push({
    id: 'ledger_mode',
    ok: mode === 'hybrid',
    severity: mode === 'hybrid' ? 'info' : 'block',
    message:
      mode === 'hybrid'
        ? 'OMBRA_LEDGER_MODE=hybrid'
        : `Ledger-läge är "${mode}" — publicering kräver hybrid`,
  })

  const publishReady = canPublishToHosted()
  items.push({
    id: 'hosted_config',
    ok: publishReady,
    severity: publishReady ? 'info' : 'block',
    message: publishReady
      ? 'OMBRA_HOSTED_BOOKS_URL och OMBRA_HOSTED_API_KEY är satta'
      : 'Saknar OMBRA_HOSTED_BOOKS_URL eller OMBRA_HOSTED_API_KEY',
  })

  const chain = await verifyArchiveChain(supabase, companyId)
  items.push({
    id: 'archive_chain',
    ok: chain.ok,
    severity: chain.ok ? 'info' : 'warn',
    message: chain.ok
      ? 'Lokal OBX-kedja OK'
      : `OBX-kedja: ${chain.issues.map((i) => i.message).join('; ') || 'problem'}`,
  })

  const { count: draftCount, error: draftErr } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .gte('entry_date', yearStart)
    .lte('entry_date', yearEnd)

  if (draftErr) throw new Error(draftErr.message)
  const open_draft_count = draftCount ?? 0
  items.push({
    id: 'no_open_drafts',
    ok: open_draft_count === 0,
    severity: open_draft_count === 0 ? 'info' : 'block',
    message:
      open_draft_count === 0
        ? 'Inga öppna utkast i året'
        : `${open_draft_count} utkast måste Fastställas eller tas bort innan publicering`,
  })

  const { data: posted, error: postedErr } = await supabase
    .from('journal_entries')
    .select('id, entry_date, description, status, posted_at, created_at')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .gte('entry_date', yearStart)
    .lte('entry_date', yearEnd)
    .limit(5000)

  if (postedErr) throw new Error(postedErr.message)

  let blockTiming = 0
  let warnTiming = 0
  for (const row of posted ?? []) {
    const entryDate = String(row.entry_date).slice(0, 10)
    const bookedOn = String(row.posted_at ?? row.created_at ?? today).slice(0, 10)
    const kind = inferCashKind({ description: row.description })
    const issue = evaluateBflTiming({ entryDate, bookedOn, kind })
    if (!issue) continue
    timing_issues.push(issue)
    if (issue.severity === 'block') blockTiming += 1
    else warnTiming += 1
  }

  items.push({
    id: 'bfl_timing',
    ok: blockTiming === 0,
    severity: blockTiming > 0 ? 'block' : warnTiming > 0 ? 'warn' : 'info',
    message:
      blockTiming > 0
        ? `${blockTiming} poster bryter BFL-timing (blockerar publicering)`
        : warnTiming > 0
          ? `${warnTiming} poster har timing-varning (månaden efter)`
          : 'Inga BFL-timingproblem i lagret',
  })

  const hasBlock = items.some((i) => !i.ok && i.severity === 'block')
  return {
    ok: !hasBlock,
    can_publish: !hasBlock && mode === 'hybrid' && publishReady,
    ledger_mode: mode,
    fiscal_year: fiscalYear,
    items,
    timing_issues: timing_issues.slice(0, 50),
    open_draft_count,
  }
}
