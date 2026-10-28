/**
 * Which bank ingest matchers run for a company: behind INGEST_PACKAGE_GATING
 * (off unless `true` or `1`; an operator switch), a batch skips the matchers of a
 * package that is fully off, and the pools only those matchers read stay
 * empty and unread (INGEST_POOL_OWNERS in ./ingest-matcher.ts).
 *
 * The rules (Phase 2 registries, decision 2026-10-16-readers-hide-by-
 * package-only):
 *   - Only the package switch decides (the company's choice, else its
 *     profile), never the plan or the country.
 *   - A switched-off package that is winding down (something still open in
 *     it, lib/modules/obligations.ts) keeps every matcher: an unpaid invoice
 *     or a ROT/RUT begäran must still find its payment. Only a package that
 *     is off with nothing open is skipped.
 *   - The switch is read once per batch (lib/modules/packages-off.ts: two
 *     small reads, plus the obligation probes of a switched-off package).
 *   - The flag off, or a failed read: every matcher runs, exactly as before
 *     the gate existed.
 *
 * A matcher's package is its module's package (packageForModule): Kundfakturor
 * owns the customer invoice match, the ROT/RUT payout and payout set and the
 * collections sweep; Leverantörsfakturor och betalningar owns the payment
 * order debit and the supplier invoice heuristics.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import { packageForModule, type PackageId } from '@/lib/modules/packages'
import { readPackagesOff } from '@/lib/modules/packages-off'
import type { IngestMatcher } from './ingest-matcher'

/** INGEST_PACKAGE_GATING: switched-off packages skip their ingest matchers. Off unless `true` or `1`. */
export function ingestPackageGatingEnabled(): boolean {
  const raw = process.env.INGEST_PACKAGE_GATING?.trim().toLowerCase()
  return raw === 'true' || raw === '1'
}

export interface IngestPackageGate {
  /** The packages this batch skips: switched off with nothing open. Empty runs everything. */
  readonly off: ReadonlySet<PackageId>
  /** Whether the matchers and pools a module owns are skipped. */
  skips(moduleId: ModuleId): boolean
}

function gateSkipping(off: ReadonlySet<PackageId>): IngestPackageGate {
  return {
    off,
    skips(moduleId) {
      const pkg = packageForModule(moduleId)
      return pkg !== null && off.has(pkg)
    },
  }
}

/** The gate that skips nothing: the flag is off, the switch was unreadable, or every package is on. */
export const RUN_EVERY_MATCHER: IngestPackageGate = gateSkipping(new Set())

/**
 * Read the gate for one batch: which of the packages that own a matcher in
 * `matchers` are fully off. A failed read skips nothing.
 */
export async function readIngestPackageGate(
  supabase: SupabaseClient,
  companyId: string,
  matchers: readonly IngestMatcher[],
): Promise<IngestPackageGate> {
  const packages = [...new Set(matchers.map((m) => packageForModule(m.module)))].filter((id): id is PackageId => id !== null)
  const off = await readPackagesOff(supabase, companyId, packages)
  return off && off.size > 0 ? gateSkipping(off) : RUN_EVERY_MATCHER
}

/** The matchers a batch runs: every matcher whose module the gate does not skip, in their order. */
export function gateIngestMatchers(matchers: readonly IngestMatcher[], gate: IngestPackageGate): readonly IngestMatcher[] {
  return gate.off.size === 0 ? matchers : matchers.filter((m) => !gate.skips(m.module))
}
