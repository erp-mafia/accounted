#!/usr/bin/env npx tsx
/**
 * Backfill SIE file archival for existing imports.
 *
 * Accepts a directory of SIE files, computes SHA-256 hashes, matches against
 * sie_imports.file_hash, uploads to Supabase Storage, and populates
 * file_storage_path.
 *
 * Usage: npx tsx scripts/backfill-sie-files.ts <directory-of-sie-files>
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function calculateFileHash(content: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(content)
  return hash.digest('hex')
}

async function main() {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: npx tsx scripts/backfill-sie-files.ts <directory-of-sie-files>')
    process.exit(1)
  }

  // 1. Read all SIE files from directory
  const files = await readdir(dir)
  const sieFiles = files.filter(f => f.toLowerCase().endsWith('.se') || f.toLowerCase().endsWith('.si'))

  if (sieFiles.length === 0) {
    console.error(`No .se/.si files found in ${dir}`)
    process.exit(1)
  }

  console.log(`Found ${sieFiles.length} SIE files in ${dir}`)

  // 2. Get all existing imports without file_storage_path
  const { data: imports, error: importError } = await supabase
    .from('sie_imports')
    .select('id, user_id, file_hash, filename, file_storage_path')
    .is('file_storage_path', null)

  if (importError) {
    console.error('Failed to fetch imports:', importError.message)
    process.exit(1)
  }

  if (!imports || imports.length === 0) {
    console.log('No imports need backfilling.')
    return
  }

  console.log(`Found ${imports.length} imports without archived files`)

  // Build hash→import mapping
  const hashToImport = new Map<string, typeof imports[number]>()
  for (const imp of imports) {
    if (imp.file_hash) {
      hashToImport.set(imp.file_hash, imp)
    }
  }

  // 3. Match files by hash and upload
  let matched = 0
  let uploaded = 0

  for (const filename of sieFiles) {
    const filePath = join(dir, filename)
    const content = await readFile(filePath, 'utf-8')
    const hash = await calculateFileHash(content)

    const imp = hashToImport.get(hash)
    if (!imp) {
      console.log(`  ${filename}: no matching import (hash: ${hash.substring(0, 12)}...)`)
      continue
    }

    matched++
    console.log(`  ${filename} → import ${imp.id} (${imp.filename})`)

    // Upload to storage
    const storagePath = `${imp.user_id}/${imp.id}.se`
    const fileBlob = new Blob([content], { type: 'text/plain; charset=cp437' })
    const { error: uploadError } = await supabase.storage
      .from('sie-files')
      .upload(storagePath, fileBlob, { upsert: false })

    if (uploadError) {
      console.error(`    Upload failed: ${uploadError.message}`)
      continue
    }

    // Update import record
    const { error: updateError } = await supabase
      .from('sie_imports')
      .update({ file_storage_path: storagePath })
      .eq('id', imp.id)

    if (updateError) {
      console.error(`    DB update failed: ${updateError.message}`)
      continue
    }

    uploaded++
    console.log(`    Archived to ${storagePath}`)
  }

  console.log(`\nDone: ${matched} matched, ${uploaded} uploaded, ${sieFiles.length - matched} unmatched`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
