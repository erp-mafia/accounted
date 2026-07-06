#!/usr/bin/env npx tsx
/**
 * One-off migration: re-home SIE archive files from {user_id}/ paths into
 * {company_id}/ paths so they match the new sie_files_* storage policies
 * (see supabase/migrations/20260416120000_sie_files_and_fiscal_period_sync.sql).
 *
 * Pre multi-tenant refactor (commit 1534979) SIE archives were uploaded to
 * {user_id}/{import_id}.se. After the refactor the upload path switched to
 * {company_id}/{import_id}.se, but the production storage policies weren't
 * updated: so every post-refactor archive silently failed RLS. The new
 * policies scope access by company; legacy files still live under user_id
 * prefixes and would become unreadable for anyone except the original
 * uploader. This script moves them to the canonical company_id prefix.
 *
 * Idempotent: skips rows whose file_storage_path already starts with the
 * company_id, and skips the copy step if the target object already exists.
 *
 * Usage:
 *   npx tsx scripts/migrate-sie-files-to-company-paths.ts --dry-run
 *   npx tsx scripts/migrate-sie-files-to-company-paths.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const dryRun = process.argv.includes('--dry-run')
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface ImportRow {
  id: string
  company_id: string
  file_storage_path: string
}

async function objectExists(path: string): Promise<boolean> {
  const { data } = await supabase.storage.from('sie-files').list(
    path.split('/').slice(0, -1).join('/'),
    { search: path.split('/').pop() }
  )
  return !!data && data.length > 0
}

async function main() {
  const { data: rows, error } = await supabase
    .from('sie_imports')
    .select('id, company_id, file_storage_path')
    .not('file_storage_path', 'is', null)

  if (error) {
    console.error('Failed to query sie_imports:', error.message)
    process.exit(1)
  }

  const candidates: ImportRow[] = (rows ?? []).filter(
    (r): r is ImportRow =>
      !!r.file_storage_path &&
      !r.file_storage_path.startsWith(`${r.company_id}/`)
  )

  console.log(`${rows?.length ?? 0} archived imports total; ${candidates.length} need migration.`)
  if (dryRun) console.log('(dry run: no changes will be made)')

  let migrated = 0
  let skipped = 0
  let failed = 0

  for (const row of candidates) {
    const oldPath = row.file_storage_path
    const newPath = `${row.company_id}/${row.id}.se`
    console.log(`\n${row.id}`)
    console.log(`  old: ${oldPath}`)
    console.log(`  new: ${newPath}`)

    if (dryRun) continue

    const { data: downloaded, error: dlError } = await supabase.storage
      .from('sie-files')
      .download(oldPath)

    if (dlError || !downloaded) {
      console.error(`  download failed: ${dlError?.message ?? 'no data'}`)
      failed++
      continue
    }

    if (await objectExists(newPath)) {
      console.log(`  target already exists: just updating DB row`)
    } else {
      const { error: upError } = await supabase.storage
        .from('sie-files')
        .upload(newPath, downloaded, {
          upsert: false,
          contentType: 'text/plain',
        })

      if (upError) {
        console.error(`  upload failed: ${upError.message}`)
        failed++
        continue
      }
    }

    const { error: updateError } = await supabase
      .from('sie_imports')
      .update({ file_storage_path: newPath })
      .eq('id', row.id)

    if (updateError) {
      console.error(`  DB update failed: ${updateError.message}`)
      failed++
      continue
    }

    const { error: rmError } = await supabase.storage
      .from('sie-files')
      .remove([oldPath])

    if (rmError) {
      console.warn(`  old file not removed (DB already points at new path): ${rmError.message}`)
      skipped++
    }

    migrated++
    console.log(`  migrated`)
  }

  console.log(`\nDone: ${migrated} migrated, ${skipped} partial, ${failed} failed.`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
