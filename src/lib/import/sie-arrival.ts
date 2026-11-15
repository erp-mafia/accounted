/**
 * The arrival of one SIE import: how the file entered the books and where
 * its original is kept.
 *
 * Source 'sie' for a file a person, an API client or an agent handed over;
 * 'migration' for the SIE a provider migration fetched from the provider.
 * The reference is the sie_imports row (the job): an identical retry gets
 * the same job back and so the same arrival, while a later import of the
 * same file (after an undo, or a replacement) is a new delivery.
 *
 * The original is not stored again: submitSIEJob has already archived it in
 * the sie-files bucket (the bytes as uploaded, or the text as provided), and
 * the arrival points at that object. No arrival_outputs: an import produces
 * up to 150 000 verifikat (SIE_LIMITS.fileVouchers), and each already carries the import's id, which is
 * this arrival's reference.
 *
 * Best effort: never throws; a failure is logged by recordArrival and the
 * import goes on.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordArrival, SIE_FILES_BUCKET, type ArrivalActor } from '@/lib/intake/arrivals'
import { createLogger } from '@/lib/logger'

const log = createLogger('import/sie-arrival')

/** The door an SIE file came through, as its submitter knows it. */
export interface SIEArrivalDoor {
  source: 'sie' | 'migration'
  fetchedBy: ArrivalActor
  /** The surface that handed the file over. */
  via: 'app' | 'partner_api' | 'mcp' | 'provider_migration'
}

/** What submitSIEJob archived as the import's original. */
export interface SIEArchivedOriginal {
  /** original_bytes: the file as uploaded; provided_text: the text an agent or a provider sent. */
  format: 'original_bytes' | 'provided_text'
  path: string
  sha256: string
  size: number
  mime: string
}

/** The app's own door: the dashboard and the onboarding upload, by the signed-in user. */
export function appSIEArrivalDoor(userId: string): SIEArrivalDoor {
  return { source: 'sie', fetchedBy: { type: 'user', user_id: userId }, via: 'app' }
}

export async function recordSIEImportArrival(
  supabase: SupabaseClient,
  args: {
    companyId: string
    importId: string
    filename: string
    fileHash: string
    fiscalYear: { start: string; end: string } | null
    original: SIEArchivedOriginal
    door: SIEArrivalDoor
  },
): Promise<void> {
  try {
    await recordArrival(supabase, {
      companyId: args.companyId,
      source: args.door.source,
      sourceRef: args.importId,
      receivedAt: new Date(),
      fetchedBy: args.door.fetchedBy,
      sourceMeta: {
        kind: 'sie',
        via: args.door.via,
        sie_import_id: args.importId,
        filename: args.filename,
        file_hash: args.fileHash,
        original_format: args.original.format,
        fiscal_year_start: args.fiscalYear?.start ?? null,
        fiscal_year_end: args.fiscalYear?.end ?? null,
      },
      originalRef: {
        bucket: SIE_FILES_BUCKET,
        path: args.original.path,
        sha256: args.original.sha256,
        mime: args.original.mime,
        size: args.original.size,
      },
    })
  } catch (err) {
    log.warn('SIE import arrival could not be recorded', {
      companyId: args.companyId,
      entityId: args.importId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
