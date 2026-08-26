import type {
  CompanyInformationDto,
  CustomerDto,
  SupplierDto,
  SalesInvoiceDto,
  SupplierInvoiceDto,
} from './dto';
import type { ProviderName } from './types';

import { FortnoxClient } from './fortnox/client';
import { FORTNOX_RESOURCE_CONFIGS } from './fortnox/config';
import { VismaClient } from './visma/client';
import { VISMA_RESOURCE_CONFIGS } from './visma/config';
import { BrioxClient } from './briox/client';
import { BRIOX_RESOURCE_CONFIGS } from './briox/config';
import { BokioClient, BokioApiError } from './bokio/client';
import { BOKIO_RESOURCE_CONFIGS } from './bokio/config';
import { BjornLundenClient } from './bjornlunden/client';
import { BL_RESOURCE_CONFIGS } from './bjornlunden/config';
import { WintClient } from './wint/client';
import { WINT_RESOURCE_CONFIGS } from './wint/config';
import { ResourceType } from './dto';

// Singleton clients (they hold rate limiters)
const fortnoxClient = new FortnoxClient();
const vismaClient = new VismaClient();
const brioxClient = new BrioxClient();
const bokioClient = new BokioClient();
const bjornLundenClient = new BjornLundenClient();
const wintClient = new WintClient();

// ── Helper to paginate Bokio (uses getPage with companyId) ──────────

async function bokioPaginate<T>(
  accessToken: string,
  companyId: string,
  path: string,
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await bokioClient.getPage<T>(accessToken, companyId, path, { page });
    allItems.push(...result.items);
    totalPages = result.totalPages;
    page++;
  } while (page <= totalPages);

  console.log(`[bokio-paginate] ${path}: fetched ${allItems.length} total items across ${totalPages} page(s)`);
  return allItems;
}

// ── Helper to paginate BjornLunden (uses getPage with userKey) ──────

async function blPaginate<T>(
  accessToken: string,
  userKey: string,
  path: string,
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await bjornLundenClient.getPage<T>(accessToken, userKey, path, { page });
    allItems.push(...result.items);
    totalPages = result.totalPages;
    page++;
  } while (page <= totalPages);

  return allItems;
}

// ── Public fetch functions ──────────────────────────────────────────

export async function fetchCompanyInfoDirect(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
): Promise<CompanyInformationDto | null> {
  try {
    if (provider === 'fortnox') {
      const config = FORTNOX_RESOURCE_CONFIGS[ResourceType.CompanyInformation]!;
      const response = await fortnoxClient.get<Record<string, unknown>>(accessToken, config.listEndpoint);
      const data = response[config.detailKey];
      return data ? config.mapper(data as Record<string, unknown>) as CompanyInformationDto : null;
    }

    if (provider === 'visma') {
      const config = VISMA_RESOURCE_CONFIGS[ResourceType.CompanyInformation]!;
      const response = await vismaClient.get<Record<string, unknown>>(accessToken, config.listEndpoint);
      return config.mapper(response) as CompanyInformationDto;
    }

    if (provider === 'briox') {
      const config = BRIOX_RESOURCE_CONFIGS[ResourceType.CompanyInformation]!;
      const response = await brioxClient.get<Record<string, unknown>>(accessToken, config.listEndpoint);
      return config.mapper(response) as CompanyInformationDto;
    }

    if (provider === 'bokio') {
      const config = BOKIO_RESOURCE_CONFIGS[ResourceType.CompanyInformation];
      if (!config || !providerCompanyId) return null;
      const response = await bokioClient.getCompany<Record<string, unknown>>(accessToken, providerCompanyId);
      return response ? config.mapper(response) as CompanyInformationDto : null;
    }

    if (provider === 'bjornlunden') {
      const config = BL_RESOURCE_CONFIGS[ResourceType.CompanyInformation]!;
      if (!providerCompanyId) return null;
      const response = await bjornLundenClient.get<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
      return config.mapper(response) as CompanyInformationDto;
    }

    if (provider === 'wint') {
      // The WINT token is company-scoped: GET /api/Auth describes the company
      // the token opens, no providerCompanyId needed on the request.
      const config = WINT_RESOURCE_CONFIGS[ResourceType.CompanyInformation]!;
      const response = await wintClient.get<Record<string, unknown>>(accessToken, config.listEndpoint);
      return config.mapper(response) as CompanyInformationDto;
    }

    return null;
  } catch (error) {
    console.error(`[provider-data-fetcher] Failed to fetch company info from ${provider}:`, error);
    return null;
  }
}

export async function fetchCustomersDirect(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
): Promise<CustomerDto[]> {
  if (provider === 'fortnox') {
    const config = FORTNOX_RESOURCE_CONFIGS[ResourceType.Customers]!;
    const items = await fortnoxClient.getPaginated<Record<string, unknown>>(
      accessToken, config.listEndpoint, config.listKey,
    );
    return items.map((item) => config.mapper(item) as CustomerDto);
  }

  if (provider === 'visma') {
    const config = VISMA_RESOURCE_CONFIGS[ResourceType.Customers]!;
    const items = await vismaClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint);
    return items.map((item) => config.mapper(item) as CustomerDto);
  }

  if (provider === 'briox') {
    const config = BRIOX_RESOURCE_CONFIGS[ResourceType.Customers]!;
    const items = await brioxClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint, config.listKey);
    return items.map((item) => config.mapper(item) as CustomerDto);
  }

  if (provider === 'bokio') {
    const config = BOKIO_RESOURCE_CONFIGS[ResourceType.Customers];
    if (!config || !providerCompanyId) {
      console.warn(`[provider-data-fetcher] Bokio customers: skipped, config=${!!config}, providerCompanyId=${providerCompanyId ?? 'undefined'}`);
      return [];
    }
    const items = await bokioPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    if (items.length > 0) {
      console.log(`[provider-data-fetcher] Bokio customers: first item keys: ${Object.keys(items[0]).join(', ')}`);
    }
    return items.map((item) => config.mapper(item) as CustomerDto);
  }

  if (provider === 'bjornlunden') {
    const config = BL_RESOURCE_CONFIGS[ResourceType.Customers]!;
    if (!providerCompanyId) return [];
    const items = await blPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    return items.map((item) => config.mapper(item) as CustomerDto);
  }

  if (provider === 'wint') {
    const config = WINT_RESOURCE_CONFIGS[ResourceType.Customers]!;
    const items = await wintClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint);
    return items.map((item) => config.mapper(item) as CustomerDto);
  }

  return [];
}

export async function fetchSuppliersDirect(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
): Promise<SupplierDto[]> {
  if (provider === 'fortnox') {
    const config = FORTNOX_RESOURCE_CONFIGS[ResourceType.Suppliers]!;
    const items = await fortnoxClient.getPaginated<Record<string, unknown>>(
      accessToken, config.listEndpoint, config.listKey,
    );
    return items.map((item) => config.mapper(item) as SupplierDto);
  }

  if (provider === 'visma') {
    const config = VISMA_RESOURCE_CONFIGS[ResourceType.Suppliers]!;
    const items = await vismaClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SupplierDto);
  }

  if (provider === 'briox') {
    const config = BRIOX_RESOURCE_CONFIGS[ResourceType.Suppliers]!;
    const items = await brioxClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint, config.listKey);
    return items.map((item) => config.mapper(item) as SupplierDto);
  }

  if (provider === 'bokio') {
    const config = BOKIO_RESOURCE_CONFIGS[ResourceType.Suppliers];
    if (!config || !providerCompanyId) return [];
    try {
      const items = await bokioPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
      return items.map((item) => config.mapper(item) as SupplierDto);
    } catch (err) {
      if (err instanceof BokioApiError && err.statusCode === 404) {
        console.log('[provider-data-fetcher] Bokio suppliers endpoint not available (404), skipping');
        return [];
      }
      throw err;
    }
  }

  if (provider === 'bjornlunden') {
    const config = BL_RESOURCE_CONFIGS[ResourceType.Suppliers]!;
    if (!providerCompanyId) return [];
    const items = await blPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SupplierDto);
  }

  // WINT (Tier A): the supplier register lives on the IncomingInvoice surface,
  // which exists only in WINT's internal Full spec. Deliberately not fetched:
  // see lib/providers/wint/config.ts.

  return [];
}

export async function fetchSalesInvoicesDirect(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
): Promise<SalesInvoiceDto[]> {
  if (provider === 'fortnox') {
    const config = FORTNOX_RESOURCE_CONFIGS[ResourceType.SalesInvoices]!;
    const items = await fortnoxClient.getPaginated<Record<string, unknown>>(
      accessToken, config.listEndpoint, config.listKey,
    );
    return items.map((item) => config.mapper(item) as SalesInvoiceDto);
  }

  if (provider === 'visma') {
    const config = VISMA_RESOURCE_CONFIGS[ResourceType.SalesInvoices]!;
    const items = await vismaClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SalesInvoiceDto);
  }

  if (provider === 'briox') {
    const config = BRIOX_RESOURCE_CONFIGS[ResourceType.SalesInvoices]!;
    const items = await brioxClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint, config.listKey);
    return items.map((item) => config.mapper(item) as SalesInvoiceDto);
  }

  if (provider === 'bokio') {
    const config = BOKIO_RESOURCE_CONFIGS[ResourceType.SalesInvoices];
    if (!config || !providerCompanyId) {
      console.warn(`[provider-data-fetcher] Bokio invoices: skipped, config=${!!config}, providerCompanyId=${providerCompanyId ?? 'undefined'}`);
      return [];
    }
    const items = await bokioPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    if (items.length > 0) {
      console.log(`[provider-data-fetcher] Bokio invoices: first item keys: ${Object.keys(items[0]).join(', ')}`);
    }
    return items.map((item) => config.mapper(item) as SalesInvoiceDto);
  }

  if (provider === 'bjornlunden') {
    const config = BL_RESOURCE_CONFIGS[ResourceType.SalesInvoices]!;
    if (!providerCompanyId) return [];
    const items = await blPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SalesInvoiceDto);
  }

  if (provider === 'wint') {
    const config = WINT_RESOURCE_CONFIGS[ResourceType.SalesInvoices]!;
    const items = await wintClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SalesInvoiceDto);
  }

  return [];
}

export async function fetchSupplierInvoicesDirect(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
): Promise<SupplierInvoiceDto[]> {
  if (provider === 'fortnox') {
    const config = FORTNOX_RESOURCE_CONFIGS[ResourceType.SupplierInvoices]!;
    const items = await fortnoxClient.getPaginated<Record<string, unknown>>(
      accessToken, config.listEndpoint, config.listKey,
    );
    return items.map((item) => config.mapper(item) as SupplierInvoiceDto);
  }

  if (provider === 'visma') {
    const config = VISMA_RESOURCE_CONFIGS[ResourceType.SupplierInvoices]!;
    const items = await vismaClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SupplierInvoiceDto);
  }

  if (provider === 'briox') {
    const config = BRIOX_RESOURCE_CONFIGS[ResourceType.SupplierInvoices]!;
    const items = await brioxClient.getPaginated<Record<string, unknown>>(accessToken, config.listEndpoint, config.listKey);
    return items.map((item) => config.mapper(item) as SupplierInvoiceDto);
  }

  if (provider === 'bokio') {
    const config = BOKIO_RESOURCE_CONFIGS[ResourceType.SupplierInvoices];
    if (!config || !providerCompanyId) return [];
    try {
      const items = await bokioPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
      return items.map((item) => config.mapper(item) as SupplierInvoiceDto);
    } catch (err) {
      if (err instanceof BokioApiError && err.statusCode === 404) {
        console.log('[provider-data-fetcher] Bokio supplier-invoices endpoint not available (404), skipping');
        return [];
      }
      throw err;
    }
  }

  if (provider === 'bjornlunden') {
    const config = BL_RESOURCE_CONFIGS[ResourceType.SupplierInvoices]!;
    if (!providerCompanyId) return [];
    const items = await blPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    return items.map((item) => config.mapper(item) as SupplierInvoiceDto);
  }

  // WINT (Tier A): supplier invoices (/api/IncomingInvoice) are Full-spec
  // only; not fetched. The GL vouchers they produced still arrive via the
  // SIE path, so the ledger stays complete: only the AP register is skipped.

  return [];
}

// ── Detail hydration ────────────────────────────────────────────────
//
// Every provider config has always declared a `detailEndpoint`, and nothing
// ever called one: invoices were mapped from the LIST payload alone. For
// Fortnox that payload is the short form, which omits `Net`, `TotalVAT` and
// `InvoiceRows` entirely, so the migration wrote 8 700+ invoices carrying a
// 25 % label and 0 kr of VAT, with no line items behind them. Briox omits its
// net the same way, and Björn Lundén ships no line items in a list response
// at all.
//
// Hydration closes that hole by fetching the detail form for the invoices
// that need it. It is bounded, because the volume is real: the largest
// migrated company holds 1 911 invoices and Fortnox allows 4 requests per
// second, so hydrating everything would take ~8 minutes against a 300 s
// function ceiling. Two properties keep it safe:
//
//   1. Open invoices are hydrated FIRST. They are the ones that can still
//      reach the ledger (a payment match books revenue and VAT off these
//      numbers, and crediting one posts a reversal), and there are few of
//      them: at most 71 per company across the migrated set.
//   2. Whatever the budget does not cover is REPORTED, never silently
//      dropped. A migration that hydrated 300 of 1 900 invoices says so.

/** The two resources hydration applies to. */
type InvoiceResource =
  | typeof ResourceType.SalesInvoices
  | typeof ResourceType.SupplierInvoices;

/** What a hydration pass managed to do, for the migration summary. */
export interface HydrationReport {
  /** Invoices whose payload was missing VAT, a net, or line items. */
  needed: number;
  /** Detail payloads successfully fetched and re-mapped. */
  hydrated: number;
  /** Detail fetches that errored; the list-form invoice was kept. */
  failed: number;
  /** Needed but not attempted because the time budget ran out. */
  skippedForBudget: number;
  /**
   * Set when hydration stopped early. `auth` means the provider rejected the
   * token or the scope, so every remaining call would fail the same way and
   * issuing them would just burn the shared rate-limit budget; `budget` means
   * the clock ran out. Absent when the pass ran to completion.
   */
  abortedBy?: 'auth' | 'budget';
}

const EMPTY_HYDRATION_REPORT: HydrationReport = {
  needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0,
};

/**
 * Default wall-clock ceiling for one hydration pass.
 *
 * The migration route runs under `maxDuration = 300`, and hydration is one
 * step among many (customers, suppliers, invoices, SIE, documents). 90 s
 * covers every open invoice in the migrated set several times over at
 * Fortnox's 4 req/s while leaving the rest of the run its share.
 */
const DEFAULT_HYDRATION_BUDGET_MS = 90_000;

/** Parallel detail fetches. The per-client token bucket is the real limit. */
const HYDRATION_CONCURRENCY = 3;

/**
 * Does this invoice still have something to gain from its detail payload?
 *
 * An invoice that already carries a VAT total, a net and its lines was fully
 * described by the list payload (Bokio, WINT) and is left alone: hydrating it
 * would spend a request to learn nothing.
 */
function salesInvoiceNeedsDetail(dto: SalesInvoiceDto): boolean {
  return dto.taxTotal === undefined
    || dto.legalMonetaryTotal.lineExtensionAmount === undefined
    || dto.lines.length === 0;
}

function supplierInvoiceNeedsDetail(dto: SupplierInvoiceDto): boolean {
  return dto.taxTotal === undefined
    || dto.legalMonetaryTotal.lineExtensionAmount === undefined
    || dto.lines.length === 0;
}

/**
 * Fetch one raw detail payload, or null when the provider cannot serve one.
 *
 * Returns a closure rather than taking the provider on every call so the
 * per-provider branch is resolved once, and so a provider that cannot hydrate
 * (Bokio and BL need a company id; WINT has no supplier endpoint) is
 * detectable before any work starts.
 */
type DetailFetch = (dto: { id: string; _raw?: Record<string, unknown> })
  => Promise<Record<string, unknown> | null>;

/**
 * The id the DETAIL endpoint expects, which is not always `dto.id`.
 *
 * Each config names its own `idField`, and Björn Lundén's sales config names
 * `invoiceNumber` while its mapper sets `dto.id` from `entityId`: passing the
 * DTO id there would request a different invoice, or none. The config is the
 * authority, so the raw payload is read through it and `dto.id` is only the
 * fallback for a payload that did not survive mapping.
 */
function detailId(dto: { id: string; _raw?: Record<string, unknown> }, idField: string): string {
  const raw = dto._raw?.[idField];
  return raw !== undefined && raw !== null && raw !== '' ? String(raw) : dto.id;
}

function detailFetcher(
  provider: ProviderName,
  resource: InvoiceResource,
  accessToken: string,
  providerCompanyId?: string,
): DetailFetch | null {
  const path = (endpoint: string, id: string) =>
    endpoint.replace('{id}', encodeURIComponent(id));

  if (provider === 'fortnox') {
    const config = FORTNOX_RESOURCE_CONFIGS[resource];
    if (!config) return null;
    return async (dto) => {
      const response = await fortnoxClient.get<Record<string, unknown>>(
        accessToken, path(config.detailEndpoint, detailId(dto, config.idField)),
      );
      // Fortnox wraps the detail in a single-key envelope ("Invoice", …).
      const body = response[config.detailKey];
      return (body as Record<string, unknown> | undefined) ?? null;
    };
  }

  if (provider === 'visma') {
    const config = VISMA_RESOURCE_CONFIGS[resource];
    if (!config) return null;
    return async (dto) => vismaClient.get<Record<string, unknown>>(
      accessToken, path(config.detailEndpoint, detailId(dto, config.idField)),
    );
  }

  if (provider === 'briox') {
    const config = BRIOX_RESOURCE_CONFIGS[resource];
    if (!config) return null;
    return async (dto) => {
      const response = await brioxClient.get<Record<string, unknown>>(
        accessToken, path(config.detailEndpoint, detailId(dto, config.idField)),
      );
      // Briox wraps some detail bodies and returns others bare.
      const body = config.detailKey ? response[config.detailKey] : response;
      return (body as Record<string, unknown> | undefined) ?? null;
    };
  }

  if (provider === 'bokio') {
    const config = BOKIO_RESOURCE_CONFIGS[resource];
    if (!config || !providerCompanyId) return null;
    return async (dto) => bokioClient.getDetail<Record<string, unknown>>(
      accessToken, providerCompanyId, path(config.detailEndpoint, detailId(dto, config.idField)),
    );
  }

  if (provider === 'bjornlunden') {
    const config = BL_RESOURCE_CONFIGS[resource];
    if (!config || !providerCompanyId) return null;
    return async (dto) => bjornLundenClient.getDetail<Record<string, unknown>>(
      accessToken, providerCompanyId, path(config.detailEndpoint, detailId(dto, config.idField)),
    );
  }

  if (provider === 'wint') {
    const config = WINT_RESOURCE_CONFIGS[resource];
    if (!config) return null;
    return async (dto) => wintClient.get<Record<string, unknown>>(
      accessToken, path(config.detailEndpoint, detailId(dto, config.idField)),
    );
  }

  return null;
}

/** Resolve the mapper for a provider/resource pair, or null if unsupported. */
function resourceMapper(
  provider: ProviderName,
  resource: InvoiceResource,
): ((raw: Record<string, unknown>) => unknown) | null {
  const configs: Partial<Record<InvoiceResource, { mapper: (raw: Record<string, unknown>) => unknown }>> = {
    fortnox: FORTNOX_RESOURCE_CONFIGS,
    visma: VISMA_RESOURCE_CONFIGS,
    briox: BRIOX_RESOURCE_CONFIGS,
    bokio: BOKIO_RESOURCE_CONFIGS,
    bjornlunden: BL_RESOURCE_CONFIGS,
    wint: WINT_RESOURCE_CONFIGS,
  }[provider];

  return configs?.[resource]?.mapper ?? null;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Replace list-form invoices with their detail form, open ones first.
 *
 * Returns a NEW array in the original order; entries that were not hydrated
 * (already complete, out of budget, or the fetch failed) are the originals,
 * so the caller never ends up with fewer invoices than it passed in.
 */
async function hydrateInvoices<T extends SalesInvoiceDto | SupplierInvoiceDto>(
  items: T[],
  needsDetail: (dto: T) => boolean,
  fetchDetail: DetailFetch | null,
  mapper: ((raw: Record<string, unknown>) => unknown) | null,
  label: string,
  budgetMs: number,
): Promise<{ items: T[]; report: HydrationReport }> {
  if (!fetchDetail || !mapper) return { items, report: { ...EMPTY_HYDRATION_REPORT } };

  const pending = items
    .map((dto, index) => ({ dto, index }))
    .filter(({ dto }) => needsDetail(dto) && dto.id);

  if (pending.length === 0) return { items, report: { ...EMPTY_HYDRATION_REPORT } };

  // Unpaid invoices are the ones a later payment match or credit note will
  // book, so they get the budget first.
  pending.sort((a, b) => Number(a.dto.paymentStatus.paid) - Number(b.dto.paymentStatus.paid));

  const hydrated = [...items];
  const report: HydrationReport = { ...EMPTY_HYDRATION_REPORT, needed: pending.length };
  const deadline = Date.now() + budgetMs;
  let aborted: 'auth' | 'budget' | null = null;

  await mapWithConcurrency(pending, HYDRATION_CONCURRENCY, async ({ dto, index }) => {
    if (aborted) {
      report.skippedForBudget++;
      return;
    }
    if (Date.now() >= deadline) {
      aborted = 'budget';
      report.skippedForBudget++;
      return;
    }

    try {
      // Race the clock as well as checking it beforehand. The provider clients
      // retry 429s and 5xx with backoff (Fortnox: 6 attempts, up to 60 s
      // apart), so a call that starts one millisecond inside the budget can
      // still be retrying minutes later. Without this bound, three concurrent
      // calls hitting a rate-limit wall would hold the whole migration past
      // its 300 s function ceiling. The underlying request is not cancelled,
      // but control returns and the remaining invoices are reported as
      // unhydrated instead of the run dying.
      const raw = await withDeadline(fetchDetail(dto), deadline);
      if (!raw) {
        report.failed++;
        return;
      }
      hydrated[index] = mapper(raw) as T;
      report.hydrated++;
    } catch (err) {
      report.failed++;

      if (err instanceof HydrationDeadlineError) {
        aborted = 'budget';
        return;
      }

      // A rejected token or a missing scope fails identically for every
      // remaining invoice. Issuing hundreds more doomed calls would spend the
      // rate-limit budget (shared platform-wide, see acquire()) for nothing
      // and bury the real cause under a wall of identical warnings.
      if (isAuthFailure(err)) {
        aborted = 'auth';
        console.warn(
          `[provider-data-fetcher] ${label} hydration stopped: provider rejected the token or scope`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      // Anything else is per-invoice: the list form is incomplete, not wrong,
      // so the invoice is kept and the shortfall reported.
      console.warn(
        `[provider-data-fetcher] ${label} detail fetch failed for ${dto.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  if (aborted) report.abortedBy = aborted;

  console.log(
    `[provider-data-fetcher] ${label} hydration: ${report.hydrated}/${report.needed} hydrated, `
    + `${report.failed} failed, ${report.skippedForBudget} not attempted`
    + (aborted ? ` (stopped early: ${aborted})` : ''),
  );

  return { items: hydrated, report };
}

/** Thrown when a detail fetch is still outstanding at the budget deadline. */
class HydrationDeadlineError extends Error {
  constructor() {
    super('Hydration budget exhausted while a detail fetch was in flight');
    this.name = 'HydrationDeadlineError';
  }
}

/** Resolve `promise`, or reject with HydrationDeadlineError at `deadline`. */
function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new HydrationDeadlineError());

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HydrationDeadlineError()), remaining);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Does this error mean the credential itself is refused?
 *
 * Every provider client throws its own error class carrying `statusCode`, so
 * the shape is read structurally rather than by instanceof across six classes.
 * 401 and 403 are the credential answers; a 404 is about one invoice and must
 * not stop the pass.
 */
function isAuthFailure(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 401 || status === 403;
}

/**
 * Sales invoices with their detail payloads merged in where needed.
 *
 * Separate from `fetchSalesInvoicesDirect` so callers that only need the
 * register (a connection test, a count) keep paying one request.
 */
export async function fetchSalesInvoicesHydrated(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
): Promise<{ invoices: SalesInvoiceDto[]; hydration: HydrationReport }> {
  const invoices = await fetchSalesInvoicesDirect(provider, accessToken, providerCompanyId);

  const { items, report } = await hydrateInvoices<SalesInvoiceDto>(
    invoices,
    salesInvoiceNeedsDetail,
    detailFetcher(provider, ResourceType.SalesInvoices, accessToken, providerCompanyId),
    resourceMapper(provider, ResourceType.SalesInvoices),
    `${provider} sales-invoice`,
    budgetMs,
  );

  return { invoices: items, hydration: report };
}

/** Supplier invoices with their detail payloads merged in where needed. */
export async function fetchSupplierInvoicesHydrated(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
): Promise<{ invoices: SupplierInvoiceDto[]; hydration: HydrationReport }> {
  const invoices = await fetchSupplierInvoicesDirect(provider, accessToken, providerCompanyId);

  const { items, report } = await hydrateInvoices<SupplierInvoiceDto>(
    invoices,
    supplierInvoiceNeedsDetail,
    detailFetcher(provider, ResourceType.SupplierInvoices, accessToken, providerCompanyId),
    resourceMapper(provider, ResourceType.SupplierInvoices),
    `${provider} supplier-invoice`,
    budgetMs,
  );

  return { invoices: items, hydration: report };
}
