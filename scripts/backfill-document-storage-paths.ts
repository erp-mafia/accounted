#!/usr/bin/env npx tsx
/**
 * ============================================================================
 * !! DESTRUCTIVE. READ THIS BEFORE YOU RUN ANYTHING. !!
 * ============================================================================
 *
 * This script MOVES räkenskapsinformation. The objects it touches are kvitton,
 * leverantorsfakturor and kontoutdrag held under the Bokforingslagen 7 kap 2 §
 * SEVEN-YEAR RETENTION requirement. Losing one is a legal incident, not a bug.
 *
 *   * ALWAYS run against STAGING first and confirm the counts there.
 *   * NEVER point this at .env.local. That file targets the REAL customer
 *     database. Pass --env <file> explicitly and read the banner it prints.
 *   * The default mode is --dry-run. Moving data requires the explicit
 *     --apply flag. Removing the source copies requires --apply AND
 *     --delete-source, which should be a SEPARATE run, days after --apply,
 *     once the app has been observed serving the new keys.
 *
 * ============================================================================
 * WHAT IT DOES (Phase B of the 3-phase rollout)
 * ============================================================================
 *
 * Phase A (migration 20260726092000_documents_bucket_company_scope.sql) added
 * company-scoped storage policies for the key layout
 *
 *     documents/{companyId}/{userId}/{timestamp}_{filename}
 *
 * and switched lib/core/documents/document-service.ts to write that layout.
 * Legacy objects still sit at
 *
 *     documents/{userId}/{timestamp}_{filename}
 *
 * where the RLS policy can only scope on auth.uid(), so a removed company
 * member keeps read access to everything they ever uploaded.
 *
 * This script re-homes those legacy objects. Rows are grouped by storage key
 * first: document_attachments.storage_path has NO unique constraint, so
 * several rows can point at one object, and the object may only be released
 * once every one of those rows has been repointed. Per source key, in order:
 *
 *   1. resolve the owning company_id(s) from document_attachments
 *   2. skip rows whose storage_path is already company-scoped (idempotent /
 *      resumable)
 *   3. COPY the object to the company-scoped key(s) (never move, never
 *      rename; one copy per owning company)
 *   4. VERIFY each new key is readable and byte-identical (SHA-256 compared
 *      against document_attachments.sha256_hash when present, otherwise
 *      against the source bytes)
 *   5. only then UPDATE storage_path for EVERY row on that key, checking the
 *      row count of each UPDATE: a row deleted between fetch and migrate
 *      must not count as migrated, or the fresh scoped copy would resurrect
 *      an erased document (a copy no row ended up pointing at is rolled
 *      back; the source is never touched by that rollback)
 *   6. only with --delete-source, and only after 3-5 succeeded for ALL rows
 *      on the key AND the live table confirms zero rows still reference it,
 *      remove the legacy object
 *
 * A --delete-source run additionally SWEEPS rows that an earlier --apply run
 * already repointed: their legacy key is derived from the scoped one (the
 * forward mapping is a pure prefix insertion, so the inverse is exact), the
 * scoped copy is re-verified (readable + hash), the live table is checked
 * for remaining references, and only then is the leftover legacy object
 * removed. Without this sweep the documented two-step workflow (--apply
 * first, --delete-source days later) would be a no-op: after --apply no row
 * carries a legacy pointer any more, yet every legacy object still sits in
 * storage, readable by its uploader (including ex-members: the exact hole
 * Phase A exists to close).
 *
 * The source is NEVER deleted before the new key has been confirmed readable
 * and every referencing row repointed. A failure at any step logs the
 * document id and the script continues to the next object; it never aborts
 * the run on a single bad document.
 *
 * ============================================================================
 * PHASE C GATE
 * ============================================================================
 *
 * The final summary prints two counters:
 *
 *   legacy_prefix_remaining  rows still pointing at a legacy key
 *   legacy_objects_remaining legacy objects still present in storage for
 *                            rows that are already company-scoped (found by
 *                            the storage-level sweep, which runs read-only
 *                            in every mode)
 *
 * Phase C (the migration that drops `documents_select_own` /
 * `documents_insert_own`) may only be applied when a --dry-run of this
 * script reports BOTH counters at 0. Dropping those policies earlier makes
 * every un-migrated document unreadable to everyone except the service role,
 * and leftover legacy objects would stay uploader-readable forever.
 *
 * ============================================================================
 * USAGE
 * ============================================================================
 *
 *   # 1. Inspect. Changes nothing. This is the default.
 *   npx tsx scripts/backfill-document-storage-paths.ts --env .env.staging.local
 *
 *   # 2. Copy + verify + repoint. Leaves the legacy objects in place.
 *   npx tsx scripts/backfill-document-storage-paths.ts --env .env.staging.local --apply
 *
 *   # 3. Days later, after the app has been observed serving new keys:
 *   #    migrates any stragglers, then sweeps the already-migrated rows and
 *   #    removes their verified leftover legacy objects.
 *   npx tsx scripts/backfill-document-storage-paths.ts --env .env.staging.local --apply --delete-source
 *
 * Flags:
 *   --env <file>       dotenv file to load. REQUIRED. No default: an implicit
 *                      .env.local would point at production.
 *   --apply            actually copy/verify/repoint. Without it: dry run.
 *   --delete-source    additionally remove legacy objects whose every row has
 *                      a verified company-scoped copy. Requires --apply.
 *   --company <uuid>   restrict the run to one company. Use this for the first
 *                      production batch.
 *   --limit <n>        process at most n documents this run (resumable: run
 *                      again to continue). A shared-key group is never split,
 *                      so the last group may overshoot the limit. Also caps
 *                      how many leftover legacy objects a --delete-source
 *                      sweep removes.
 *   --yes              skip the interactive confirmation prompt.
 */

import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'documents'
const PATH_ROOT = 'documents'
const PAGE_SIZE = 500

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return undefined
  const value = process.argv[idx + 1]
  if (!value || value.startsWith('--')) {
    console.error(`--${name} requires a value`)
    process.exit(1)
  }
  return value
}

const envFile = flagValue('env')
const apply = process.argv.includes('--apply')
const deleteSource = process.argv.includes('--delete-source')
const skipPrompt = process.argv.includes('--yes')
const onlyCompany = flagValue('company')
const limitRaw = flagValue('limit')
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY

if (!envFile) {
  console.error(
    'Refusing to run without an explicit --env <file>. An implicit .env.local ' +
      'points at the PRODUCTION database. Example: --env .env.staging.local',
  )
  process.exit(1)
}

// Refuse .env.local no matter how the path is spelled ('./.env.local', an
// absolute path, backslashes on Windows): normalize before comparing. An
// exact string compare here was trivially bypassed by './.env.local'. The
// check runs BEFORE config() so the production env file is never even read.
if (basename(resolve(envFile)).toLowerCase() === '.env.local') {
  console.error(
    'REFUSING: .env.local points at the production database. If you really ' +
      'intend to run against production, copy the credentials into an ' +
      'explicitly named file (e.g. .env.production.backfill) so the intent ' +
      'is recorded in the command line.',
  )
  process.exit(1)
}

if (deleteSource && !apply) {
  console.error('--delete-source requires --apply.')
  process.exit(1)
}

if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
  console.error('--limit must be a positive integer.')
  process.exit(1)
}

config({ path: envFile })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocumentRow {
  id: string
  company_id: string | null
  storage_path: string | null
  file_name: string | null
  mime_type: string | null
  sha256_hash: string | null
}

interface Failure {
  documentId: string
  storagePath: string | null
  step: string
  reason: string
}

/** All rows (possibly from several companies) that share one legacy key. */
interface PathGroup {
  sourcePath: string
  rows: DocumentRow[]
}

// ---------------------------------------------------------------------------
// Path helpers.
//
// Deliberately duplicated from lib/core/documents/document-service.ts instead
// of imported: this script runs standalone under tsx and must not drag the
// service module's Next.js/event-bus imports into a plain node process. Keep
// the two in sync if the layout ever changes again.
// ---------------------------------------------------------------------------

function isCompanyScoped(storagePath: string, companyId: string): boolean {
  return storagePath.startsWith(`${PATH_ROOT}/${companyId}/`)
}

function isLegacyDocumentPath(storagePath: string): boolean {
  return storagePath.startsWith(`${PATH_ROOT}/`)
}

function companyScopedPath(storagePath: string, companyId: string): string | null {
  if (isCompanyScoped(storagePath, companyId)) return null
  if (!isLegacyDocumentPath(storagePath)) return null
  return `${PATH_ROOT}/${companyId}/${storagePath.slice(`${PATH_ROOT}/`.length)}`
}

/**
 * Inverse of companyScopedPath: derive the legacy key a company-scoped key
 * was (or would have been) migrated from. The forward mapping is a pure
 * prefix insertion, so the inverse is exact. Returns null when the key is
 * not company-scoped for the given company.
 */
function legacyPathFor(storagePath: string, companyId: string): string | null {
  const prefix = `${PATH_ROOT}/${companyId}/`
  if (!storagePath.startsWith(prefix)) return null
  return `${PATH_ROOT}/${storagePath.slice(prefix.length)}`
}

function sha256Hex(buffer: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(buffer)).digest('hex')
}

// ---------------------------------------------------------------------------
// Safety banner + confirmation
// ---------------------------------------------------------------------------

function projectRef(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0] ?? url
  } catch {
    return url
  }
}

async function confirmOrExit(): Promise<void> {
  const ref = projectRef(supabaseUrl!)

  console.log('')
  console.log('='.repeat(78))
  console.log('  documents bucket backfill: legacy uploader-scoped keys -> company-scoped')
  console.log('='.repeat(78))
  console.log(`  env file        : ${envFile}`)
  console.log(`  supabase project: ${ref}`)
  console.log(`  mode            : ${apply ? 'APPLY (writes data)' : 'DRY RUN (no changes)'}`)
  console.log(`  delete source   : ${deleteSource ? 'YES (legacy objects removed)' : 'no'}`)
  console.log(`  company filter  : ${onlyCompany ?? '(all companies)'}`)
  console.log(`  limit           : ${Number.isFinite(limit) ? limit : '(none)'}`)
  console.log('='.repeat(78))
  console.log('')

  if (!apply || skipPrompt) return

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(
    `Type the project ref (${ref}) to proceed, anything else to abort: `,
  )
  rl.close()
  if (answer.trim() !== ref) {
    console.error('Aborted.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Page through document_attachments. PostgREST caps a single response at
 * 1000 rows, so never rely on an unbounded select here.
 */
async function fetchAllDocuments(supabase: SupabaseClient): Promise<DocumentRow[]> {
  const rows: DocumentRow[] = []
  let from = 0

  for (;;) {
    let query = supabase
      .from('document_attachments')
      .select('id, company_id, storage_path, file_name, mime_type, sha256_hash')
      .not('storage_path', 'is', null)
      // created_at alone is not unique: without the id tiebreaker, rows
      // sharing a timestamp can be skipped or duplicated across .range()
      // pages, and a skipped row silently stays on the legacy key.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (onlyCompany) query = query.eq('company_id', onlyCompany)

    const { data, error } = await query
    if (error) throw new Error(`Failed to page document_attachments: ${error.message}`)
    if (!data || data.length === 0) break

    rows.push(...(data as DocumentRow[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return rows
}

async function objectExists(supabase: SupabaseClient, path: string): Promise<boolean> {
  const segments = path.split('/')
  const name = segments.pop()!
  const folder = segments.join('/')
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { search: name })
  // Surface list failures instead of treating them as "missing": a transient
  // error must never make a leftover object look already-swept.
  if (error) throw new Error(`Failed to list ${folder}: ${error.message}`)
  return !!data?.some((entry) => entry.name === name)
}

/**
 * Authoritative check that at least one document_attachments row still points
 * at the given storage key. Deliberately queries the LIVE table rather than
 * this run's in-memory snapshot: a --company or --limit window, a
 * NULL-company row, or a concurrent writer must never be able to hide a row
 * whose only object the key is.
 */
async function pathStillReferenced(supabase: SupabaseClient, path: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('storage_path', path)
    .limit(1)
  if (error) throw new Error(`Failed to check references for ${path}: ${error.message}`)
  return (data?.length ?? 0) > 0
}

/**
 * Remove a legacy object, but only when the live table confirms zero rows
 * still reference it. Every caller has already verified a company-scoped
 * copy for every row that pointed here; this function is the ONLY place the
 * script deletes a legacy source object. Returns true when the object was
 * actually removed.
 */
async function removeLegacySourceIfUnreferenced(
  supabase: SupabaseClient,
  legacyPath: string,
): Promise<boolean> {
  try {
    if (await pathStillReferenced(supabase, legacyPath)) {
      console.warn(`  [${legacyPath}] source kept: still referenced by at least one row`)
      return false
    }
  } catch (err) {
    console.warn(
      `  [${legacyPath}] source kept: reference check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }

  const { error: removeError } = await supabase.storage.from(BUCKET).remove([legacyPath])
  if (removeError) {
    console.warn(`  [${legacyPath}] source not removed: ${removeError.message}`)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Per-object migration (all rows sharing one legacy key, together)
// ---------------------------------------------------------------------------

interface TargetState {
  targetPath: string
  copyHash: string
  uploadedThisRun: boolean
  repointed: number
}

async function migrateGroup(
  supabase: SupabaseClient,
  group: PathGroup,
  failures: Failure[],
): Promise<{ migratedRows: number; failedRows: number; sourceRemoved: boolean }> {
  const { sourcePath, rows } = group

  const fail = (row: DocumentRow, step: string, reason: string) => {
    failures.push({ documentId: row.id, storagePath: sourcePath, step, reason })
  }

  // ---- 3. COPY (never move: the source must survive until step 6).
  // Downloaded once per key: several rows can share the object. ------------
  const { data: sourceBlob, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(sourcePath)

  if (downloadError || !sourceBlob) {
    const reason = downloadError?.message ?? 'no data returned'
    for (const row of rows) fail(row, 'download-source', reason)
    return { migratedRows: 0, failedRows: rows.length, sourceRemoved: false }
  }

  const sourceBytes = await sourceBlob.arrayBuffer()
  const sourceHash = sha256Hex(sourceBytes)

  // One scoped target per company referencing this source key: rows from
  // different companies sharing one object each get their own copy.
  const companies = [...new Set(rows.map((row) => row.company_id!))]
  const targets = new Map<string, TargetState>()

  for (const companyId of companies) {
    const companyRows = rows.filter((row) => row.company_id === companyId)
    const targetPath = companyScopedPath(sourcePath, companyId)!
    let uploadedThisRun = false

    try {
      // An already-present target means a previous run got this far: fall
      // through to verification rather than failing on the upsert:false
      // conflict.
      if (!(await objectExists(supabase, targetPath))) {
        const { error: uploadError } = await supabase.storage
          .from(BUCKET)
          .upload(targetPath, sourceBytes, {
            contentType: companyRows[0]!.mime_type ?? 'application/octet-stream',
            upsert: false,
          })

        if (uploadError) {
          for (const row of companyRows) fail(row, 'upload-copy', uploadError.message)
          continue
        }
        uploadedThisRun = true
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      for (const row of companyRows) fail(row, 'upload-copy', reason)
      continue
    }

    // ---- 4. VERIFY the new key is readable, once per target --------------
    const { data: copyBlob, error: verifyError } = await supabase.storage
      .from(BUCKET)
      .download(targetPath)

    if (verifyError || !copyBlob) {
      const reason = verifyError?.message ?? 'copy not readable at the new key'
      for (const row of companyRows) fail(row, 'verify-readable', reason)
      continue
    }

    targets.set(companyId, {
      targetPath,
      copyHash: sha256Hex(await copyBlob.arrayBuffer()),
      uploadedThisRun,
      repointed: 0,
    })
  }

  let migratedRows = 0

  for (const row of rows) {
    const target = targets.get(row.company_id!)
    if (!target) continue // upload/readability failure already recorded above

    // The stored hash is the strongest reference; fall back to the source
    // bytes for rows written before sha256_hash was populated.
    const expectedHash = row.sha256_hash ?? sourceHash
    if (target.copyHash !== expectedHash) {
      fail(row, 'verify-hash', `copy hash ${target.copyHash} does not match expected ${expectedHash}`)
      continue
    }

    // ---- 5. Repoint the DB, only now that the copy is proven. The row
    // count matters: a row deleted between fetch and migrate makes this a
    // 0-row UPDATE, which must NOT count as migrated (the scoped copy would
    // resurrect an erased document). ---------------------------------------
    const { data: updated, error: updateError } = await supabase
      .from('document_attachments')
      .update({ storage_path: target.targetPath })
      .eq('id', row.id)
      .select('id')

    if (updateError) {
      fail(row, 'update-pointer', updateError.message)
      continue
    }
    if (!updated || updated.length === 0) {
      fail(row, 'update-pointer', 'no row matched: deleted between fetch and migrate')
      continue
    }

    target.repointed++
    migratedRows++
  }

  // Roll back any scoped copy created THIS RUN that no row ended up pointing
  // at, so it cannot linger as an unreferenced resurrected duplicate. Safe:
  // the copy is seconds old, the live table confirms nothing references it,
  // and the SOURCE object is never touched here.
  for (const target of targets.values()) {
    if (!target.uploadedThisRun || target.repointed > 0) continue
    try {
      if (await pathStillReferenced(supabase, target.targetPath)) continue
      const { error: cleanupError } = await supabase.storage
        .from(BUCKET)
        .remove([target.targetPath])
      if (cleanupError) {
        console.warn(
          `  [${target.targetPath}] unreferenced fresh copy not rolled back: ${cleanupError.message}`,
        )
      }
    } catch (err) {
      console.warn(
        `  [${target.targetPath}] unreferenced fresh copy not rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  const failedRows = rows.length - migratedRows

  // ---- 6. Optional source removal, strictly last: only when EVERY row on
  // this key is repointed, and the live table double-checks that. ----------
  let sourceRemoved = false
  if (deleteSource && failedRows === 0) {
    sourceRemoved = await removeLegacySourceIfUnreferenced(supabase, sourcePath)
  }

  return { migratedRows, failedRows, sourceRemoved }
}

// ---------------------------------------------------------------------------
// Storage-level sweep over rows that are ALREADY company-scoped
// ---------------------------------------------------------------------------

interface SweepResult {
  /** Distinct derived legacy keys whose object still exists in storage. */
  keysWithLeftovers: number
  objectsRemoved: number
}

/**
 * An --apply run repoints rows and leaves the legacy objects behind, so a
 * later --delete-source run can no longer find them through the pointers:
 * it has to derive each legacy key from the scoped one (legacyPathFor) and
 * check storage directly. For every derived key whose object still exists:
 *
 *   - without --delete-source: count it (input to the Phase C gate)
 *   - with --delete-source: verify the scoped copy is readable and matches
 *     the expected hash for EVERY row mapping to the key, confirm via the
 *     live table that no row still references the key, and only then remove
 *     it (capped by --limit).
 */
async function sweepLegacyObjects(
  supabase: SupabaseClient,
  scopedRows: DocumentRow[],
  skipKeys: Set<string>,
  failures: Failure[],
  deleteBudget: number,
): Promise<SweepResult> {
  // Group scoped rows by derived legacy key: several rows (even from
  // different companies) can map to one key, and the key may only be removed
  // when every one of them has a verified scoped copy.
  const byLegacyKey = new Map<string, DocumentRow[]>()
  for (const row of scopedRows) {
    const legacyKey = legacyPathFor(row.storage_path!, row.company_id!)
    if (!legacyKey) continue
    if (skipKeys.has(legacyKey)) continue // handled by this run's migration phase
    const list = byLegacyKey.get(legacyKey)
    if (list) list.push(row)
    else byLegacyKey.set(legacyKey, [row])
  }

  const result: SweepResult = { keysWithLeftovers: 0, objectsRemoved: 0 }

  for (const [legacyKey, rows] of byLegacyKey) {
    let counted = false
    try {
      // Most keys belong to uploads born company-scoped: no legacy object
      // ever existed for them, and this check is all they cost.
      if (!(await objectExists(supabase, legacyKey))) continue
      result.keysWithLeftovers++
      counted = true

      if (!deleteSource) continue // report-only: feeds legacy_objects_remaining
      if (result.objectsRemoved >= deleteBudget) continue

      // VERIFY: every row mapping to this key must have a readable scoped
      // copy with the expected hash before the legacy object may go.
      let allVerified = true
      let legacyHash: string | null = null
      for (const row of rows) {
        const { data: copyBlob, error: copyError } = await supabase.storage
          .from(BUCKET)
          .download(row.storage_path!)

        if (copyError || !copyBlob) {
          failures.push({
            documentId: row.id,
            storagePath: legacyKey,
            step: 'sweep-verify-readable',
            reason: copyError?.message ?? 'scoped copy not readable',
          })
          allVerified = false
          break
        }
        const copyHash = sha256Hex(await copyBlob.arrayBuffer())

        let expectedHash = row.sha256_hash
        if (!expectedHash) {
          // No stored hash: the legacy bytes themselves are the reference.
          if (legacyHash === null) {
            const { data: legacyBlob, error: legacyError } = await supabase.storage
              .from(BUCKET)
              .download(legacyKey)
            if (legacyError || !legacyBlob) {
              failures.push({
                documentId: row.id,
                storagePath: legacyKey,
                step: 'sweep-download-legacy',
                reason: legacyError?.message ?? 'legacy object listed but not readable',
              })
              allVerified = false
              break
            }
            legacyHash = sha256Hex(await legacyBlob.arrayBuffer())
          }
          expectedHash = legacyHash
        }

        if (copyHash !== expectedHash) {
          failures.push({
            documentId: row.id,
            storagePath: legacyKey,
            step: 'sweep-verify-hash',
            reason: `scoped copy hash ${copyHash} does not match expected ${expectedHash}`,
          })
          allVerified = false
          break
        }
      }

      if (!allVerified) continue // stays counted as a leftover; gate stays closed

      if (await removeLegacySourceIfUnreferenced(supabase, legacyKey)) {
        console.log(
          `  [sweep] removed ${legacyKey} (${rows.length} row(s) verified at scoped keys)`,
        )
        result.objectsRemoved++
      }
    } catch (err) {
      // Unknown state: count the key as remaining so the gate stays closed.
      if (!counted) result.keysWithLeftovers++
      failures.push({
        documentId: rows[0]!.id,
        storagePath: legacyKey,
        step: 'sweep-unexpected',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await confirmOrExit()

  const supabase = createClient(supabaseUrl!, serviceRoleKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const rows = await fetchAllDocuments(supabase)

  const alreadyScoped: DocumentRow[] = []
  const candidates: DocumentRow[] = []
  const unmapped: DocumentRow[] = []

  for (const row of rows) {
    if (!row.storage_path) continue
    if (!row.company_id) {
      unmapped.push(row)
      continue
    }
    if (isCompanyScoped(row.storage_path, row.company_id)) {
      alreadyScoped.push(row)
    } else if (isLegacyDocumentPath(row.storage_path)) {
      candidates.push(row)
    } else {
      // Shapes this backfill deliberately does not touch, e.g. the MCP
      // audit-package keys `{userId}/audit-packages/...` and the demo-seed
      // `{userId}/{companyId}/inbox/...` keys. They are not covered by the
      // documents_*_company policies and are not document_attachments
      // underlag in the BFL sense.
      unmapped.push(row)
    }
  }

  // Group the legacy rows by source key: storage_path has no unique
  // constraint, so several rows can share one object. The object is copied
  // once, ALL its rows are repointed, and only then may the source go;
  // migrating rows one by one deleted the source after the first row and
  // stranded every later row on a dead pointer.
  const groupsByPath = new Map<string, DocumentRow[]>()
  for (const row of candidates) {
    const list = groupsByPath.get(row.storage_path!)
    if (list) list.push(row)
    else groupsByPath.set(row.storage_path!, [row])
  }
  const groups: PathGroup[] = [...groupsByPath.entries()].map(([sourcePath, groupRows]) => ({
    sourcePath,
    rows: groupRows,
  }))

  console.log(`document_attachments rows with a storage_path : ${rows.length}`)
  console.log(`  already company-scoped                      : ${alreadyScoped.length}`)
  console.log(
    `  legacy prefix, need migration               : ${candidates.length} (${groups.length} distinct objects)`,
  )
  console.log(`  outside the documents/ layout (skipped)     : ${unmapped.length}`)
  console.log('')

  if (unmapped.length > 0) {
    console.log('Skipped rows (first 20):')
    for (const row of unmapped.slice(0, 20)) {
      console.log(`  ${row.id}  company=${row.company_id ?? 'NULL'}  path=${row.storage_path}`)
    }
    console.log('')
  }

  // --limit caps processed rows, but a shared-key group is never split:
  // repointing only some of a key's rows would let a later --delete-source
  // remove an object the remaining rows still need.
  const batch: PathGroup[] = []
  let batchRows = 0
  for (const group of groups) {
    if (batchRows >= limit) break
    batch.push(group)
    batchRows += group.rows.length
  }

  const failures: Failure[] = []
  let migratedRows = 0
  let sourcesRemoved = 0
  // Groups fully migrated this run whose legacy object was (deliberately or
  // not) left in storage: they count as leftover legacy objects below.
  let sourcesKept = 0

  if (!apply) {
    console.log('DRY RUN: nothing was changed. Planned moves (first 20):')
    const preview = batch.flatMap((group) => group.rows).slice(0, 20)
    for (const row of preview) {
      console.log(`  ${row.id}`)
      console.log(`    from ${row.storage_path}`)
      console.log(`    to   ${companyScopedPath(row.storage_path!, row.company_id!)}`)
    }
    console.log('')
  } else {
    for (const [index, group] of batch.entries()) {
      const progress = `${index + 1}/${batch.length}`
      const rowCount = group.rows.length
      console.log(
        `[${progress}] ${group.sourcePath}  (${rowCount} row${rowCount === 1 ? '' : 's'})`,
      )
      try {
        const outcome = await migrateGroup(supabase, group, failures)
        migratedRows += outcome.migratedRows
        if (outcome.failedRows === 0) {
          if (outcome.sourceRemoved) sourcesRemoved++
          else sourcesKept++
        }
      } catch (err) {
        // Never abort the run on one bad object.
        const reason = err instanceof Error ? err.message : String(err)
        for (const row of group.rows) {
          failures.push({
            documentId: row.id,
            storagePath: group.sourcePath,
            step: 'unexpected',
            reason,
          })
        }
      }
    }
  }

  // Storage-level sweep over already-migrated rows. Without it, an --apply
  // run followed by a later --delete-source run finds zero legacy POINTERS
  // and deletes nothing, while every legacy OBJECT still sits in the bucket
  // readable by its uploader. Read-only unless --delete-source; the keys
  // this run already handled as migration sources are skipped.
  console.log('')
  console.log(
    `Sweeping ${alreadyScoped.length} already-scoped row(s) for leftover legacy objects` +
      (deleteSource ? ' (verify + delete)...' : ' (read-only)...'),
  )
  const batchSourcePaths = new Set(batch.map((group) => group.sourcePath))
  const sweep = await sweepLegacyObjects(
    supabase,
    alreadyScoped,
    batchSourcePaths,
    failures,
    limit,
  )

  const legacyRowsRemaining = candidates.length - migratedRows
  const legacyObjectsRemaining =
    sweep.keysWithLeftovers - sweep.objectsRemoved + sourcesKept

  console.log('')
  console.log('='.repeat(78))
  console.log(`  rows migrated            : ${migratedRows}`)
  console.log(`  failures                 : ${failures.length}`)
  console.log(`  legacy objects removed   : ${sourcesRemoved + sweep.objectsRemoved}`)
  console.log(`  legacy_prefix_remaining  : ${legacyRowsRemaining}`)
  console.log(`  legacy_objects_remaining : ${legacyObjectsRemaining}`)
  console.log('='.repeat(78))

  if (failures.length > 0) {
    console.log('')
    console.log('Failures (document id / step / reason):')
    for (const failure of failures) {
      console.log(`  ${failure.documentId}  [${failure.step}]  ${failure.reason}`)
      console.log(`    path: ${failure.storagePath}`)
    }
  }

  // The gate needs BOTH counters at zero: rows still on legacy pointers make
  // documents unreadable after Phase C, and leftover legacy objects keep the
  // uploader-scoped read hole open.
  const gateOpen =
    legacyRowsRemaining === 0 && legacyObjectsRemaining === 0 && failures.length === 0

  console.log('')
  if (gateOpen) {
    console.log(
      apply
        ? 'PHASE C GATE: OPEN. Re-run with --dry-run to confirm, then apply the Phase C migration.'
        : 'PHASE C GATE: OPEN. Zero legacy-prefix rows and zero leftover legacy objects; the Phase C migration may be applied.',
    )
  } else {
    const next =
      legacyRowsRemaining > 0
        ? 'Run with --apply until legacy_prefix_remaining reaches 0.'
        : legacyObjectsRemaining > 0
          ? 'Run with --apply --delete-source to remove the leftover legacy objects.'
          : 'Resolve the failures above and re-run.'
    console.log(
      `PHASE C GATE: CLOSED. Do NOT drop documents_select_own / documents_insert_own yet. ${next}`,
    )
  }

  // Non-zero exit on failures so a CI/ops wrapper notices, but only AFTER the
  // full report has been printed.
  if (failures.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
