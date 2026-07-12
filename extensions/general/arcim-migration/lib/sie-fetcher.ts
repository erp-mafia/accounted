/**
 * Per-provider SIE-over-API fetcher.
 *
 * Providers that expose their general ledger as a SIE export over the API get
 * the "Fortnox-grade" migration experience: the wizard pulls the GL itself
 * instead of requiring a manual SIE upload. Everything downstream (parsing,
 * validation, account mapping, replace-mode import) is provider-agnostic:
 * this module's only job is to produce raw SIE file contents per fiscal year.
 *
 * Shared by /preview (latest year, for stats) and /sie-data (all years).
 */

import { FortnoxClient } from '@/lib/providers/fortnox/client'
import { BrioxClient } from '@/lib/providers/briox/client'
import { BjornLundenClient } from '@/lib/providers/bjornlunden/client'
import type { ProviderName } from '@/lib/providers/types'
import { detectEncoding, decodeBuffer } from '@/lib/import/sie-parser'
import { createLogger } from '@/lib/logger'

const log = createLogger('extensions/arcim-migration/sie-fetcher')

/**
 * Fiscal years we support importing: the current year and the two before it.
 * Derived at call time (not a module constant) so the window rolls forward
 * automatically at new year without a code change.
 */
export function getAllowedFiscalYears(now: Date = new Date()): Set<number> {
  const currentYear = now.getFullYear()
  return new Set([currentYear - 2, currentYear - 1, currentYear])
}

export interface ProviderSieFile {
  fiscalYear: number
  rawContent: string
}

export interface ProviderSieFetchResult {
  files: ProviderSieFile[]
  /**
   * Every fiscal year available at the provider within the allowed window:
   * also populated when latestOnly fetched just one file, so /preview can show
   * the full year list without a second round-trip.
   */
  availableYears: number[]
  /**
   * Allowed years whose export failed (or came back empty). Callers MUST
   * surface these to the user: silently importing e.g. 2024+2026 without 2025
   * breaks IB/UB continuity between the years without anyone noticing.
   */
  failedYears: { year: number; error: string }[]
}

// Singleton clients (they hold rate limiters)
const fortnoxClient = new FortnoxClient()
const brioxClient = new BrioxClient()
const bjornLundenClient = new BjornLundenClient()

/** True when the provider's API can serve the GL as SIE (no manual upload). */
export function providerSupportsSie(provider: ProviderName): boolean {
  return provider === 'fortnox' || provider === 'briox' || provider === 'bjornlunden'
}

interface FiscalYearRef {
  id: string | number
  year: number
  /** Period bounds: required by BL, whose export URL is date-ranged. */
  fromDate?: string
  toDate?: string
}

/**
 * Fetch SIE type-4 exports from the provider, one file per allowed fiscal
 * year (oldest first). Years whose export fails do not block the rest of the
 * migration, but they are reported in `failedYears` so the caller can warn
 * the user before importing a gap (IB/UB continuity).
 */
export async function fetchProviderSieFiles(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId: string | undefined,
  opts?: { latestOnly?: boolean },
): Promise<ProviderSieFetchResult> {
  const fetcher = getSieFetcher(provider, providerCompanyId)
  if (!fetcher) {
    throw new Error(`Provider ${provider} does not support SIE over API`)
  }

  const allowedFiscalYears = getAllowedFiscalYears()
  const allYears = await fetcher.listYears(accessToken)
  const allowedYears = allYears
    .filter((fy) => allowedFiscalYears.has(fy.year))
    .sort((a, b) => a.year - b.year)

  const availableYears = allowedYears.map((fy) => fy.year)
  const toFetch = opts?.latestOnly ? allowedYears.slice(-1) : allowedYears

  const files: ProviderSieFile[] = []
  const failedYears: { year: number; error: string }[] = []
  for (const fy of toFetch) {
    try {
      const rawContent = await fetcher.fetchSie(accessToken, fy)
      if (rawContent) {
        files.push({ fiscalYear: fy.year, rawContent })
      } else {
        failedYears.push({ year: fy.year, error: 'Provider returned an empty SIE export' })
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.warn(`Failed to fetch SIE for ${provider} fiscal year ${fy.year} (id ${fy.id})`, {
        reason,
      })
      failedYears.push({ year: fy.year, error: reason })
    }
  }

  return { files, availableYears, failedYears }
}

interface SieFetcher {
  listYears(accessToken: string): Promise<FiscalYearRef[]>
  fetchSie(accessToken: string, fy: FiscalYearRef): Promise<string>
}

function getSieFetcher(
  provider: ProviderName,
  providerCompanyId: string | undefined,
): SieFetcher | null {
  if (provider === 'fortnox') {
    return {
      async listYears(accessToken) {
        const fyResponse = await fortnoxClient.get<Record<string, unknown>>(
          accessToken,
          '/financialyears',
        )
        const years = (fyResponse['FinancialYears'] as Record<string, unknown>[] | undefined) ?? []
        return years.map((fy) => ({
          id: fy['Id'] as number,
          year: new Date(fy['FromDate'] as string).getFullYear(),
        }))
      },
      async fetchSie(accessToken, fy) {
        // Fortnox normally serves the SIE body as UTF-8, but endpoint variants
        // have been seen answering CP437 (the SIE spec encoding): a blind
        // response.text() would turn å/ä/ö into U+FFFD irrecoverably. Fetch
        // raw bytes and detect-decode like the Briox/BL paths.
        const buffer = await fortnoxClient.getBytes(accessToken, `/sie/4?financialyear=${fy.id}`)
        return decodeBuffer(buffer, detectEncoding(buffer))
      },
    }
  }

  if (provider === 'briox') {
    return {
      async listYears(accessToken) {
        const years = await brioxClient.listFinancialYears(accessToken)
        return years.map((fy) => ({
          id: fy.id,
          year: new Date(fy.fromdate).getFullYear(),
        }))
      },
      async fetchSie(accessToken, fy) {
        // Briox serves SIE as an octet-stream whose encoding varies
        // (CP437/Windows-1252/UTF-8): fetch bytes and detect-decode.
        const buffer = await brioxClient.getBytes(accessToken, `/sie/${fy.id}/4`)
        return decodeBuffer(buffer, detectEncoding(buffer))
      },
    }
  }

  if (provider === 'bjornlunden') {
    // providerCompanyId carries the per-company User-Key header value.
    const userKey = providerCompanyId
    if (!userKey) {
      throw new Error('Björn Lundén requires a company User-Key: reconnect the provider')
    }
    return {
      async listYears(accessToken) {
        const years = await bjornLundenClient.listFinancialYears(accessToken, userKey)
        return years.map((fy) => ({
          id: fy.id ?? fy.entityId,
          year: new Date(fy.fromDate).getFullYear(),
          fromDate: fy.fromDate,
          toDate: fy.toDate,
        }))
      },
      async fetchSie(accessToken, fy) {
        // BL's export is date-ranged rather than year-id based. Sandbox-
        // verified: the body is RAW SIE bytes (CP437, Content-Type
        // text/vnd.sie-gruppen.si) even though the swagger declares a base64
        // string: decodeSieBytes handles both shapes.
        const buffer = await bjornLundenClient.getBytes(
          accessToken,
          userKey,
          `/sie/export/${fy.fromDate}/${fy.toDate}`,
        )
        return decodeSieBytes(buffer)
      },
    }
  }

  return null
}

/**
 * Decode a SIE payload that may arrive either as raw SIE bytes or as a
 * base64 string (optionally JSON-quoted). BL's swagger declares base64 but
 * the live API sends raw CP437: handle both so a future API change doesn't
 * silently break the import.
 */
function decodeSieBytes(buffer: ArrayBuffer): string {
  const direct = decodeBuffer(buffer, detectEncoding(buffer))
  if (looksLikeSie(direct)) return direct

  const candidate = direct.trim().replace(/^"|"$/g, '')
  if (/^[A-Za-z0-9+/=\s]+$/.test(candidate)) {
    try {
      const bytes = Buffer.from(candidate, 'base64')
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const decoded = decodeBuffer(ab, detectEncoding(ab))
      if (looksLikeSie(decoded)) return decoded
    } catch {
      // fall through to returning the direct decode
    }
  }

  // Neither shape matched: return the direct decode and let the SIE parser
  // produce its own diagnostics instead of failing silently here.
  return direct
}

/** SIE files start with a #-record (#FLAGGA per spec; be lenient about order). */
function looksLikeSie(text: string): boolean {
  return text.trimStart().startsWith('#')
}
