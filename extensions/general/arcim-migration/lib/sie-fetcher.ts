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
import { WintClient } from '@/lib/providers/wint/client'
import {
  buildWintSieFile,
  deriveIbByYear,
  mapWintAccountForSie,
  mapWintVoucherForSie,
  type WintSieVoucher,
  type WintSieYear,
} from '@/lib/providers/wint/sie-builder'
import type { ProviderName } from '@/lib/providers/types'
import { detectEncoding, decodeBuffer } from '@/lib/import/sie-parser'
import { createLogger } from '@/lib/logger'

const log = createLogger('extensions/arcim-migration/sie-fetcher')

/**
 * The DEFAULT selection of fiscal years: the current year and the two before
 * it, keyed on each fiscal year's start year. A default, not a cap (issue
 * #2211 / #2238): the wizard lets the user add older years, and
 * fetchProviderSieFiles takes an explicit `years` selection. The default is
 * the cost bound: every selected year is one SIE export fetched and parsed
 * inside the single /sie-data invocation (hosted function limit 300 s), so
 * an older history is the user's own wait, chosen in the preview step.
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
   * Every fiscal year available at the provider within the selection (the
   * default window, or the explicit `years`): also populated when latestOnly
   * fetched just one file, so /preview can show the full year list without a
   * second round-trip.
   */
  availableYears: number[]
  /**
   * Every fiscal year the source has, oldest first, with the provider's own
   * bounds and whether it is in the default selection. The preview step
   * renders these as the year picker, so no year can be left out silently.
   */
  sourceYears: SourceFiscalYear[]
  /**
   * Allowed years whose export failed (or came back empty). Callers MUST
   * surface these to the user: silently importing e.g. 2024+2026 without 2025
   * breaks IB/UB continuity between the years without anyone noticing.
   */
  failedYears: { year: number; error: string }[]
  /**
   * Source fiscal years that were NOT part of this fetch (outside the
   * selection), oldest first. Until issue #2211 these were never mentioned:
   * the result step names them so nobody believes the books are complete.
   */
  omittedYears: SourceFiscalYear[]
}

/**
 * A fiscal year as the source reports it. Bounds are the provider's own
 * (ISO yyyy-mm-dd) so a broken year can be named as "2022-09-01 till
 * 2023-12-31" rather than as a calendar year that is wrong for it; null when
 * the provider reported none. `year` (the start year) is the key the whole
 * import uses for a fiscal year, and what `fetchProviderSieFiles` selects on.
 */
export interface SourceFiscalYear {
  year: number
  fromDate: string | null
  toDate: string | null
  /** True when the year falls in the default selection (getAllowedFiscalYears). */
  inDefaultSelection: boolean
}

// Singleton clients (they hold rate limiters)
const fortnoxClient = new FortnoxClient()
const brioxClient = new BrioxClient()
const bjornLundenClient = new BjornLundenClient()
const wintClient = new WintClient()

/**
 * True when the provider's API can serve the GL as SIE (no manual upload).
 * WINT qualifies even though its v1 API has no SIE endpoint: the ledger is
 * fetched voucher-by-voucher and RENDERED as SIE on our side (Tier A; see
 * lib/providers/wint/sie-builder.ts). Downstream the file is indistinguishable
 * from a provider export and goes through the same parse/validate/import path.
 */
export function providerSupportsSie(provider: ProviderName): boolean {
  return provider === 'fortnox' || provider === 'briox' || provider === 'bjornlunden' || provider === 'wint'
}

interface FiscalYearRef {
  id: string | number
  year: number
  /** Period bounds: required by BL, whose export URL is date-ranged. */
  fromDate?: string
  toDate?: string
}

/**
 * Fetch SIE type-4 exports from the provider, one file per selected fiscal
 * year (oldest first). The selection is `opts.years` (start years, as the
 * preview step's picker sends them) or, when absent, the default window.
 * Years whose export fails do not block the rest of the migration, but they
 * are reported in `failedYears` so the caller can warn the user before
 * importing a gap (IB/UB continuity). Years at the source outside the
 * selection are reported in `omittedYears`; the full list is `sourceYears`.
 */
export async function fetchProviderSieFiles(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId: string | undefined,
  opts?: { latestOnly?: boolean; years?: number[] },
): Promise<ProviderSieFetchResult> {
  const fetcher = getSieFetcher(provider, providerCompanyId, opts?.years)
  if (!fetcher) {
    throw new Error(`Provider ${provider} does not support SIE over API`)
  }

  const defaultFiscalYears = getAllowedFiscalYears()
  const selectedFiscalYears = opts?.years ? new Set(opts.years) : defaultFiscalYears
  const byYear = (a: FiscalYearRef, b: FiscalYearRef) =>
    a.year - b.year || (a.fromDate ?? '').localeCompare(b.fromDate ?? '')
  const allYears = (await fetcher.listYears(accessToken)).sort(byYear)
  const allowedYears = allYears.filter((fy) => selectedFiscalYears.has(fy.year))

  const availableYears = allowedYears.map((fy) => fy.year)
  const toFetch = opts?.latestOnly ? allowedYears.slice(-1) : allowedYears

  // Both derived from the year list already fetched: naming every source
  // year, and the ones left out, costs no extra provider call.
  const describe = (fy: FiscalYearRef): SourceFiscalYear => ({
    year: fy.year,
    fromDate: fy.fromDate ?? null,
    toDate: fy.toDate ?? null,
    inDefaultSelection: defaultFiscalYears.has(fy.year),
  })
  const sourceYears = allYears.map(describe)
  const omittedYears = allYears.filter((fy) => !selectedFiscalYears.has(fy.year)).map(describe)

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

  return { files, availableYears, sourceYears, failedYears, omittedYears }
}

interface SieFetcher {
  listYears(accessToken: string): Promise<FiscalYearRef[]>
  fetchSie(accessToken: string, fy: FiscalYearRef): Promise<string>
}

function getSieFetcher(
  provider: ProviderName,
  providerCompanyId: string | undefined,
  selectedYears?: number[],
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
          fromDate: typeof fy['FromDate'] === 'string' ? fy['FromDate'] : undefined,
          toDate: typeof fy['ToDate'] === 'string' ? fy['ToDate'] : undefined,
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
          fromDate: fy.fromdate,
          toDate: fy.todate,
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

  if (provider === 'wint') {
    // The SIE files are rendered from voucher data, and opening balances for
    // years before WINT's current fiscal year are derived by walking the
    // voucher deltas backward from the /api/Account Ib anchor. That walk
    // needs every year's vouchers at once, so the first fetchSie call builds
    // a shared context (this fetcher object lives for exactly one
    // fetchProviderSieFiles invocation: the closure is the right lifetime).
    interface WintSieContext {
      companyName: string
      orgNumber?: string
      accounts: ReturnType<typeof mapWintAccountForSie>[]
      /** Every year the source has, unfiltered: what listYears reports. */
      allYears: (WintSieYear & { id: number })[]
      /** The allowed subset: the years that render as SIE. */
      years: (WintSieYear & { id: number })[]
      vouchersByYear: Map<number, WintSieVoucher[]>
      ibByYear: Map<number, Map<string, number>>
      fetchErrors: Map<number, string>
    }
    let contextPromise: Promise<WintSieContext> | null = null

    const loadContext = (accessToken: string): Promise<WintSieContext> => {
      contextPromise ??= (async () => {
        const company = await wintClient.get<Record<string, unknown>>(accessToken, '/api/Auth')
        const rawYears = (company['FinancialYears'] as Record<string, unknown>[] | undefined) ?? []
        // The same selection fetchProviderSieFiles applies: the explicit
        // years when given, else the default window.
        const allowed = selectedYears ? new Set(selectedYears) : getAllowedFiscalYears()
        const allYears = rawYears
          .map((fy) => ({
            id: Number(fy['Id']),
            year: new Date((fy['Start'] as string) ?? '').getFullYear(),
            start: ((fy['Start'] as string) ?? '').slice(0, 10),
            end: ((fy['End'] as string) ?? '').slice(0, 10),
          }))
          .sort((a, b) => a.year - b.year)
        const years = allYears.filter((fy) => allowed.has(fy.year))

        const accountsRaw = await wintClient.getPaginated<Record<string, unknown>>(
          accessToken,
          '/api/Account',
        )
        const accounts = accountsRaw.map(mapWintAccountForSie).filter((a) => a.accountNumber)

        // The Ib anchor is WINT's ACTIVE fiscal year: selected from the
        // UNFILTERED year list, so an active year outside the allowed import
        // window can never be silently swapped for the latest allowed year
        // (that would attach the anchor balances to the wrong year). When the
        // anchor lies outside the window, its vouchers are still fetched below
        // so the derivation chain stays complete; only allowed years render.
        const today = new Date().toISOString().slice(0, 10)
        const anchor =
          allYears.find((fy) => fy.start <= today && today <= fy.end) ?? allYears[allYears.length - 1]

        const chainYears = new Map(years.map((fy) => [fy.year, fy]))
        if (anchor) {
          const lo = Math.min(anchor.year, ...years.map((fy) => fy.year))
          const hi = Math.max(anchor.year, ...years.map((fy) => fy.year))
          for (const fy of allYears) {
            if (fy.year >= lo && fy.year <= hi) chainYears.set(fy.year, fy)
          }
        }

        // A single year's fetch failure must not sink the whole migration:
        // the year is simply absent from vouchersByYear, deriveIbByYear stops
        // at the hole, and the affected years fail loudly in fetchSie while
        // the years on the anchor's side of the hole still render.
        const vouchersByYear = new Map<number, WintSieVoucher[]>()
        const fetchErrors = new Map<number, string>()
        for (const fy of [...chainYears.values()].sort((a, b) => a.year - b.year)) {
          try {
            const raw = await wintClient.getPaginated<Record<string, unknown>>(
              accessToken,
              `/api/Voucher?BookingDateStart=${fy.start}&BookingDateEnd=${fy.end}&IncludeTransactions=true`,
            )
            vouchersByYear.set(fy.year, raw.map(mapWintVoucherForSie))
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            log.warn(`WINT voucher fetch failed for fiscal year ${fy.year}`, { reason })
            fetchErrors.set(fy.year, reason)
          }
        }

        const anchorIb = new Map<string, number>()
        for (const account of accounts) {
          if (account.ib != null && account.ib !== 0) anchorIb.set(account.accountNumber, account.ib)
        }
        const ibByYear = anchor
          ? deriveIbByYear(anchor.year, anchorIb, vouchersByYear, years.map((fy) => fy.year))
          : new Map<number, Map<string, number>>()

        return {
          companyName: (company['Name'] as string) ?? 'Okänt företag',
          orgNumber: (company['Org'] as string | undefined) || undefined,
          accounts,
          allYears,
          years,
          vouchersByYear,
          ibByYear,
          fetchErrors,
        }
      })()
      return contextPromise
    }

    return {
      async listYears(accessToken) {
        // The unfiltered list: fetchProviderSieFiles applies the window
        // itself and needs the years outside it to name what is left out.
        const context = await loadContext(accessToken)
        return context.allYears.map((fy) => ({
          id: fy.id,
          year: fy.year,
          fromDate: fy.start,
          toDate: fy.end,
        }))
      },
      async fetchSie(accessToken, fy) {
        const context = await loadContext(accessToken)
        const yearRef = context.years.find((y) => y.year === fy.year)
        const vouchers = context.vouchersByYear.get(fy.year)
        const ibByAccount = context.ibByYear.get(fy.year)
        if (!yearRef || !vouchers) {
          const reason = context.fetchErrors.get(fy.year)
          throw new Error(
            reason
              ? `WINT voucher fetch failed for fiscal year ${fy.year}: ${reason}`
              : `WINT returned no ledger data for fiscal year ${fy.year}`,
          )
        }
        if (!ibByAccount) {
          // A hole in the voucher chain between this year and the Ib anchor
          // year: opening balances cannot be established. Failing the year is
          // better than importing broken IB/UB continuity.
          throw new Error(
            `Opening balances for ${fy.year} could not be derived from WINT's ledger data`,
          )
        }
        const previousYear = context.years.find((y) => y.year === fy.year - 1)
        return buildWintSieFile({
          companyName: context.companyName,
          orgNumber: context.orgNumber,
          programVersion: '1.0',
          generatedDate: new Date().toISOString().slice(0, 10),
          year: yearRef,
          previousYear,
          accounts: context.accounts,
          vouchers,
          ibByAccount,
        })
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
