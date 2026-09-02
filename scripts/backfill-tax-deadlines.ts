#!/usr/bin/env npx tsx
/**
 * Backfill automatic tax deadlines for the installed base.
 *
 * Root cause (bug): tax deadlines only ever regenerated when a tax-relevant
 * settings field CHANGED value (app/api/settings/route.ts, gated on
 * the since-removed didTaxFieldsChange). Companies fill these fields once at onboarding, so a
 * later save changed nothing and generated nothing. The annual cron
 * (generateNewYearDeadlines) is the only unconditional trigger and runs Jan 2,
 * so the installed base sat empty. Result before this backfill: only ~5 of ~776
 * real companies had system-generated deadlines.
 *
 * This script runs the REAL generator (generateTaxDeadlinesForUser) so the
 * backfilled rows are byte-identical to what the app produces. It targets ONLY
 * non-sandbox companies that currently have ZERO source='system' deadlines, so
 * it can never reset is_completed/status on a company that already has progress.
 *
 * Known gap (intentionally NOT covered here): moms_period='yearly' has no
 * deadline config yet, so ~295 annual VAT filers will not get a momsdeklaration
 * deadline until moms_yearly ships. Every other applicable deadline is created.
 *
 * Usage:
 *   npx tsx scripts/backfill-tax-deadlines.ts --dry-run   # report only (default-safe)
 *   npx tsx scripts/backfill-tax-deadlines.ts --apply     # write to the database
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import {
  DEADLINE_SETTINGS_SELECT,
  generateTaxDeadlinesForUser,
  toDeadlineSettings,
} from '../lib/tax/deadline-generator'
import type { CompanySettingsForDeadlines } from '../lib/tax/deadline-config'

const APPLY = process.argv.includes('--apply')
const DRY_RUN = !APPLY

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

const PAGE = 1000

interface SettingsRow extends Partial<CompanySettingsForDeadlines> {
  company_id: string
  is_sandbox: boolean | null
}

async function fetchAllSettings(): Promise<SettingsRow[]> {
  const rows: SettingsRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('company_settings')
      .select(`${DEADLINE_SETTINGS_SELECT}, is_sandbox`)
      .order('company_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('Failed to fetch company_settings', error)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    rows.push(...(data as SettingsRow[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  return rows
}

async function fetchCompaniesWithSystemDeadlines(): Promise<Set<string>> {
  const ids = new Set<string>()
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('deadlines')
      .select('company_id')
      .eq('source', 'system')
      .order('company_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('Failed to fetch companies with system deadlines', error)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    for (const row of data as Array<{ company_id: string }>) ids.add(row.company_id)
    if (data.length < PAGE) break
    from += PAGE
  }
  return ids
}

async function main() {
  const all = await fetchAllSettings()
  const realCompanies = all.filter((s) => !s.is_sandbox)
  const withDeadlines = await fetchCompaniesWithSystemDeadlines()

  let scanned = 0
  let alreadyHad = 0
  let missingEntityType = 0
  let generatedCompanies = 0
  let generatedRows = 0
  const errors: Array<{ company_id: string; error: string }> = []

  for (const s of realCompanies) {
    scanned++

    if (!s.entity_type) {
      // Generator gates every config on entity_type; nothing to create.
      missingEntityType++
      continue
    }

    if (withDeadlines.has(s.company_id)) {
      alreadyHad++
      continue
    }

    const settings = toDeadlineSettings(s)

    if (DRY_RUN) {
      // In dry-run we cannot cheaply know the row count without inserting, so we
      // just report the company as a target.
      generatedCompanies++
      continue
    }

    try {
      const result = await generateTaxDeadlinesForUser(supabase, s.company_id, settings)
      if (result.created > 0) {
        generatedCompanies++
        generatedRows += result.created
      }
    } catch (err) {
      errors.push({ company_id: s.company_id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  console.log(JSON.stringify({
    mode: DRY_RUN ? 'dry-run' : 'apply',
    real_companies_scanned: scanned,
    already_had_system_deadlines: alreadyHad,
    skipped_missing_entity_type: missingEntityType,
    companies_generated: generatedCompanies,
    rows_generated: DRY_RUN ? null : generatedRows,
    errors,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
