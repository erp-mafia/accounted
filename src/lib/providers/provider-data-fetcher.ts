import { currentExecutionBudget, ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget';
import type {
  AccountingAccountDto,
  CompanyInformationDto,
  CustomerDto,
  SupplierDto,
  SalesInvoiceDto,
  SupplierInvoiceDto,
} from './dto';
import type { ProviderName } from './types';

import { FortnoxClient } from './fortnox/client';
import { ISO_DATE_RE } from '@/lib/invariants';
import { FORTNOX_RESOURCE_CONFIGS } from './fortnox/config';
import { fortnoxSupplierInvoiceNotOpen } from './fortnox/mapper';
import { VismaClient } from './visma/client';
import { VISMA_RESOURCE_CONFIGS } from './visma/config';
import { BrioxClient } from './briox/client';
import { BRIOX_RESOURCE_CONFIGS } from './briox/config';
import { BokioClient, BokioApiError } from './bokio/client';
import { BOKIO_RESOURCE_CONFIGS } from './bokio/config';
import { isBokioCreditNotePayload } from './bokio/mapper';
import { fetchBokioVoucherRef } from './bokio/attachments';
import { enrichBokioSupplierInvoice } from './bokio/supplier-evidence';
import { BjornLundenClient } from './bjornlunden/client';
import { BL_RESOURCE_CONFIGS } from './bjornlunden/config';
import { WintClient } from './wint/client';
import { WINT_RESOURCE_CONFIGS } from './wint/config';
import { ResourceType } from './dto';
import type { MigrationResource } from './migration-contract';
import { createLogger } from '@/lib/logger';
import { isProviderRefusal } from './with-provider-call';

const log = createLogger('providers/provider-data-fetcher');

// Singleton clients (they hold rate limiters)
const fortnoxClient = new FortnoxClient();
const vismaClient = new VismaClient();
const brioxClient = new BrioxClient();
const bokioClient = new BokioClient();
const bjornLundenClient = new BjornLundenClient();
const wintClient = new WintClient();

export type MigrationDto = CustomerDto | SupplierDto | SalesInvoiceDto | SupplierInvoiceDto;

/** Minimal discovery evidence. No customer, line, amount, or credential payload. */
export interface InvoiceCompletionSource {
  id: string;
  detailId: string;
  invoiceNumber: string;
  issueDate: string;
  creditNote: boolean;
}

export async function fetchInvoiceCompletionPage(
  provider: ProviderName, accessToken: string, providerCompanyId: string | undefined,
  part: 'invoices' | 'creditNotes', page: number,
): Promise<{ sources: InvoiceCompletionSource[]; nextPage: number | null; nextPart: 'invoices' | 'creditNotes' }> {
  let invoices: SalesInvoiceDto[];
  let nextPage: number | null;
  let nextPart = part;
  if (provider === 'bokio') {
    if (!providerCompanyId) throw new Error('MIGRATION_SOURCE_IDENTITY_MISSING');
    const resource = part === 'creditNotes' ? ResourceType.CreditNotes : ResourceType.SalesInvoices;
    const config = BOKIO_RESOURCE_CONFIGS[resource]!;
    try {
      const result = await bokioClient.getPage<Record<string, unknown>>(
        accessToken, providerCompanyId, config.listEndpoint, { page, pageSize: 100, timeoutMs: MIGRATION_LIST_TIMEOUT_MS },
      );
      if (result.page !== page || (!result.items.length && page < result.totalPages)) throw new Error('MIGRATION_PROVIDER_PAGE_MISMATCH');
      invoices = result.items.map(item => BOKIO_RESOURCE_CONFIGS[ResourceType.SalesInvoices]!.mapper(item) as SalesInvoiceDto);
      nextPage = page < result.totalPages ? page + 1 : null;
    } catch (error) {
      if (part !== 'creditNotes' || !(error instanceof BokioApiError) || error.statusCode !== 404) throw error;
      invoices = []; nextPage = null;
    }
    if (nextPage === null && part === 'invoices') { nextPage = 1; nextPart = 'creditNotes'; }
  } else {
    const result = await fetchMigrationPage(provider, accessToken, providerCompanyId, 'salesInvoices', page);
    invoices = result.items as SalesInvoiceDto[];
    nextPage = result.nextPage;
  }
  const configs = { fortnox: FORTNOX_RESOURCE_CONFIGS, visma: VISMA_RESOURCE_CONFIGS, briox: BRIOX_RESOURCE_CONFIGS,
    bokio: BOKIO_RESOURCE_CONFIGS, bjornlunden: BL_RESOURCE_CONFIGS, wint: WINT_RESOURCE_CONFIGS };
  const idField = configs[provider][ResourceType.SalesInvoices]!.idField;
  return {
    sources: invoices.flatMap(dto => {
      const day = dto.issueDate?.slice(0, 10);
      if (!dto.id || !dto.invoiceNumber || !day || !ISO_DATE_RE.test(day)) return [];
      const parsed = new Date(day);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return [];
      return [{ id: dto.id, detailId: detailId(dto, idField), invoiceNumber: dto.invoiceNumber, issueDate: day,
        creditNote: provider === 'bokio' && (part === 'creditNotes' || isBokioCreditNotePayload(dto._raw)) }];
    }),
    nextPage, nextPart,
  };
}

/** Resolve a stored source reference through the same adapter and mapper as migration. */
export async function fetchInvoiceCompletionDetail(
  provider: ProviderName, accessToken: string, providerCompanyId: string | undefined, source: InvoiceCompletionSource,
): Promise<SalesInvoiceDto | null> {
  const fetchDetail = detailFetcher(provider, ResourceType.SalesInvoices, accessToken, providerCompanyId);
  const mapper = resourceMapper(provider, ResourceType.SalesInvoices);
  if (!fetchDetail || !mapper) throw new Error('INVOICE_COMPLETION_DETAIL_UNSUPPORTED');
  const raw = await fetchDetail({ id: source.id, _raw: {
    _completionDetailId: source.detailId, _completionCreditNote: source.creditNote,
  } });
  return raw ? mapper(raw) as SalesInvoiceDto : null;
}

/**
 * A 1000-row register page is a report, not a record: the client's 15 s
 * single-record timeout cut every supplier invoice page of a 4805-invoice
 * register short. Every provider's register pages get it, not only Visma's
 * (#3136). The limit applies per attempt; the migration worker's
 * execution budget, shared by everything one invocation does, cancels the
 * request, the rate-limit wait and any further attempt at its deadline.
 */
export const MIGRATION_LIST_TIMEOUT_MS = 60_000

/** Fortnox supplier invoices a listed page left out of the default import, by reason. */
export type FortnoxNotOpenCounts = Partial<Record<NonNullable<ReturnType<typeof fortnoxSupplierInvoiceNotOpen>>, number>>;

/** The open payables of a Fortnox supplier-invoice list, and what was left out and why. */
function keepOpenFortnoxSupplierInvoices(items: Record<string, unknown>[]): {
  open: Record<string, unknown>[]; declined: FortnoxNotOpenCounts;
} {
  const declined: FortnoxNotOpenCounts = {};
  const open = items.filter((item) => {
    const reason = fortnoxSupplierInvoiceNotOpen(item);
    if (reason) declined[reason] = (declined[reason] ?? 0) + 1;
    return !reason;
  });
  return { open, declined };
}

/**
 * One provider page, never a whole-register loop. The worker persists its cursor.
 * `allSupplierInvoices` is the job's request for Fortnox's paid supplier
 * invoices too; without it a Fortnox page keeps only the open ones and says
 * how many it left out (`declined`). Every other provider lists the whole
 * register regardless.
 */
export async function fetchMigrationPage(
  provider: ProviderName, accessToken: string, providerCompanyId: string | undefined,
  resource: MigrationResource, page: number, options: { allSupplierInvoices?: boolean } = {},
): Promise<{ items: MigrationDto[]; nextPage: number | null; total: number; declined?: FortnoxNotOpenCounts }> {
  const kind = { customers: ResourceType.Customers, suppliers: ResourceType.Suppliers,
    salesInvoices: ResourceType.SalesInvoices, supplierInvoices: ResourceType.SupplierInvoices }[resource];
  const configs = { fortnox: FORTNOX_RESOURCE_CONFIGS, visma: VISMA_RESOURCE_CONFIGS,
    briox: BRIOX_RESOURCE_CONFIGS, bokio: BOKIO_RESOURCE_CONFIGS,
    bjornlunden: BL_RESOURCE_CONFIGS, wint: WINT_RESOURCE_CONFIGS };
  const config = configs[provider][kind];
  if (!config) return { items: [], nextPage: null, total: 0 };
  if ((provider === 'bokio' || provider === 'bjornlunden') && !providerCompanyId) {
    throw new Error('MIGRATION_SOURCE_IDENTITY_MISSING');
  }
  let result: { items: Record<string, unknown>[]; page: number; totalPages: number; totalCount: number };
  if (provider === 'visma') {
    result = await vismaClient.getPage(accessToken, config.listEndpoint, { page, pageSize: 1000, timeoutMs: MIGRATION_LIST_TIMEOUT_MS });
  } else if (provider === 'fortnox') {
    result = await fortnoxClient.getPage(accessToken, config.listEndpoint, FORTNOX_RESOURCE_CONFIGS[kind]!.listKey, { page, timeoutMs: MIGRATION_LIST_TIMEOUT_MS });
  } else if (provider === 'briox') {
    result = await brioxClient.getPage(accessToken, config.listEndpoint, BRIOX_RESOURCE_CONFIGS[kind]!.listKey, { page, timeoutMs: MIGRATION_LIST_TIMEOUT_MS });
  } else if (provider === 'bokio') {
    try {
      result = await bokioClient.getPage(accessToken, providerCompanyId!, config.listEndpoint, { page, timeoutMs: MIGRATION_LIST_TIMEOUT_MS });
    } catch (error) {
      // Preserve the direct importer's handling of optional Bokio AP endpoints.
      if ((resource === 'suppliers' || resource === 'supplierInvoices')
        && error instanceof BokioApiError && error.statusCode === 404) {
        return { items: [], nextPage: null, total: 0 };
      }
      throw error;
    }
  } else if (provider === 'bjornlunden') {
    // BL's party registers are a single unpaged response. Its invoice APIs page.
    result = await bjornLundenClient.getPage(accessToken, providerCompanyId!, config.listEndpoint, { page, timeoutMs: MIGRATION_LIST_TIMEOUT_MS });
  } else {
    const response = await wintClient.getPage<Record<string, unknown>>(accessToken, config.listEndpoint, { page, timeoutMs: MIGRATION_LIST_TIMEOUT_MS });
    result = { ...response, totalPages: Math.ceil(response.totalItems / response.pageSize), totalCount: response.totalItems };
  }
  if (result.page !== page) throw new Error('MIGRATION_PROVIDER_PAGE_MISMATCH');
  if (result.items.length === 0 && page < result.totalPages) throw new Error('MIGRATION_PROVIDER_EMPTY_PAGE');
  const nextPage = result.items.length > 0 && page < result.totalPages ? page + 1 : null;
  let items = result.items;
  let total = result.totalCount;
  let declined: FortnoxNotOpenCounts | undefined;
  if (provider === 'fortnox' && resource === 'supplierInvoices' && !options.allSupplierInvoices) {
    // After the page checks above: a page of only paid invoices is no end of the register.
    ({ open: items, declined } = keepOpenFortnoxSupplierInvoices(items));
  }
  if (provider === 'bokio' && resource === 'salesInvoices' && page === 1) {
    // Bokio keeps kreditfakturor on /credit-notes, not in /invoices. The job
    // worker persists ONE cursor per resource and its page RPC
    // (save_provider_migration_page) accepts only page + 1 as the next
    // cursor, so a second endpoint cannot get pages of its own: the whole
    // credit-note register rides on page 1 instead, AHEAD of the invoices.
    // Ahead, because the RPC keeps the first record per source id, and where
    // /invoices repeats a credit note (status `credit`) the /credit-notes
    // form is the one that names the credited invoice.
    const creditNotes = await fetchBokioCreditNotes(accessToken, providerCompanyId!, MIGRATION_LIST_TIMEOUT_MS);
    items = mergeBokioSalesDocuments(creditNotes, items);
    total += creditNotes.length;
  }
  return {
    items: items.map(item => config.mapper(item) as MigrationDto),
    nextPage,
    total,
    ...(declined ? { declined } : {}),
  };
}

// ── Helper to paginate Bokio (uses getPage with companyId) ──────────

async function bokioPaginate<T>(
  accessToken: string,
  companyId: string,
  path: string,
  pageSize?: number,
  timeoutMs?: number,
): Promise<T[]> {
  const allItems: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await bokioClient.getPage<T>(accessToken, companyId, path, { page, pageSize, timeoutMs });
    allItems.push(...result.items);
    totalPages = result.totalPages;
    page++;
  } while (page <= totalPages);

  log.info(`${path}: fetched ${allItems.length} total items across ${totalPages} page(s)`);
  return allItems;
}

/** The spec's maximum for /credit-notes; the register is usually small. */
const BOKIO_CREDIT_NOTE_PAGE_SIZE = 100;

/**
 * Every Bokio credit note, raw. Bokio publishes kreditfakturor on
 * /companies/{id}/credit-notes (scope credit-notes:read), a resource of its
 * own beside /invoices; a sales register read from /invoices alone has none
 * of them, which is how a Bokio customer's credit notes went missing or
 * landed as unsent invoices (crm#110).
 *
 * A 404 is read the way the AP endpoints' is: the resource is absent for
 * this account, nothing to import. A 401/403 (a token without the scope) is
 * a credential answer and propagates, because a run that silently drops
 * every credit note is the bug this exists to fix.
 */
async function fetchBokioCreditNotes(
  accessToken: string,
  companyId: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>[]> {
  const config = BOKIO_RESOURCE_CONFIGS[ResourceType.CreditNotes];
  if (!config) return [];
  try {
    return await bokioPaginate<Record<string, unknown>>(
      accessToken, companyId, config.listEndpoint, BOKIO_CREDIT_NOTE_PAGE_SIZE, timeoutMs,
    );
  } catch (err) {
    if (err instanceof BokioApiError && err.statusCode === 404) {
      log.info('Bokio credit-notes endpoint not available (404), skipping');
      return [];
    }
    throw err;
  }
}

/**
 * One Bokio sales register out of the two endpoints: the credit notes first,
 * then every invoice whose id is not already among them. /invoices can list
 * a credit document under its own id (status `credit`); the /credit-notes
 * form of it carries `invoiceRef`, the pointer at the credited invoice, so
 * that form wins and comes first, which is what makes it win the importer's
 * first-seen dedupe as well.
 */
function mergeBokioSalesDocuments(
  creditNotes: Record<string, unknown>[],
  invoices: Record<string, unknown>[],
): Record<string, unknown>[] {
  const creditNoteIds = new Set(
    creditNotes.map((raw) => String(raw['id'] ?? '')).filter((id) => id !== ''),
  );
  return [
    ...creditNotes,
    ...invoices.filter((raw) => !creditNoteIds.has(String(raw['id'] ?? ''))),
  ];
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

/**
 * Company information straight from the provider.
 *
 * Throws whatever the provider client threw. It used to catch everything and
 * return null, which made a Visma company whose api_standard module is off
 * look like a company with no details: the preview answered 200 with
 * companyInfo: null and its classify-and-rethrow remediation was unreachable
 * code. Callers decide what is soft (the preview keeps transient failures
 * soft, the migration records a step error). `null` still means "nothing to
 * fetch here" (no resource config, or no provider company id), never "the
 * call failed".
 */
export async function fetchCompanyInfoDirect(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
): Promise<CompanyInformationDto | null> {
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
}

/**
 * List fetches. Every one of them can answer `[]` WITHOUT issuing a request:
 * Bokio and Björn Lundén key their list endpoints on a provider company id
 * this consent may not carry, WINT has no supplier register, and Bokio's
 * supplier 404 is swallowed on purpose. So an empty array means "nothing to
 * import", never "the provider answered nothing", and callers must not read a
 * resolved promise as proof that the access token works. A failed request
 * still throws; only genuinely absent resources return [].
 */
/**
 * The provider's chart of accounts, with the per-account momskod the SIE
 * export leaves out (SIE4 #KONTO carries no VAT code). Fortnox only so far:
 * its VATCode is a named code whose meaning is documented
 * (lib/providers/fortnox/vat-codes.ts). Visma's VatCodeId is an opaque id
 * that needs a second lookup, and the Björn Lundén and Briox code sets are
 * unverified, so those answer [] until their semantics are pinned down.
 *
 * Fortnox lists the chart of the CURRENT financial year when no
 * financialyear filter is given; that is the chart the user sees in Fortnox
 * today, which is what the mapping step should agree with.
 */
export async function fetchAccountingAccountsDirect(
  provider: ProviderName,
  accessToken: string,
): Promise<AccountingAccountDto[]> {
  if (provider === 'fortnox') {
    const config = FORTNOX_RESOURCE_CONFIGS[ResourceType.AccountingAccounts]!;
    const items = await fortnoxClient.getPaginated<Record<string, unknown>>(
      accessToken, config.listEndpoint, config.listKey, { pageSize: 500 },
    );
    return items.map((item) => config.mapper(item) as AccountingAccountDto);
  }

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
    const invoices = await bokioPaginate<Record<string, unknown>>(accessToken, providerCompanyId, config.listEndpoint);
    const creditNotes = await fetchBokioCreditNotes(accessToken, providerCompanyId);
    const items = mergeBokioSalesDocuments(creditNotes, invoices);
    if (items.length > 0) {
      log.info(
        `Bokio invoices: ${invoices.length} invoices, ${creditNotes.length} credit notes; `
        + `first item keys: ${Object.keys(items[0]).join(', ')}`,
      );
    }
    // The sales mapper recognises both payload shapes, so one map covers
    // invoices and credit notes alike (see mapBokioToSalesInvoice).
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
    // The open register, read the way the migration job reads it.
    const items = await fortnoxClient.getPaginated<Record<string, unknown>>(
      accessToken, config.listEndpoint, config.listKey, { pageSize: 500 },
    );
    return keepOpenFortnoxSupplierInvoices(items).open.map((item) => config.mapper(item) as SupplierInvoiceDto);
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
        log.info('Bokio supplier-invoices endpoint not available (404), skipping');
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

/**
 * The resources hydration applies to: both invoice registers, and Fortnox's
 * customer and supplier registers, whose list forms are short
 * (partyNeedsDetail).
 */
type DetailResource =
  | typeof ResourceType.SalesInvoices
  | typeof ResourceType.SupplierInvoices
  | typeof ResourceType.Customers
  | typeof ResourceType.Suppliers;

/** What a hydration pass managed to do, for the migration summary. */
export interface HydrationReport {
  /** Invoices missing detail fields or needing their journal UUID resolved. */
  needed: number;
  /** Invoices whose required detail and voucher lookups completed. */
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

/** A register with its detail payloads merged in, plus what hydration missed. */
export interface HydratedInvoices<T extends SalesInvoiceDto | SupplierInvoiceDto> {
  invoices: T[];
  hydration: HydrationReport;
  /**
   * Ids (`dto.id`) of invoices that needed their detail form and did not get
   * it. Fields that only the detail form carries are UNKNOWN for these, not
   * absent: the migration must not report them as "the provider had none".
   */
  unhydratedIds: Set<string>;
  /**
   * The provider's own error when the pass stopped on it (`abortedBy: 'auth'`),
   * so a caller can still tell a dead token (401) from one resource the token
   * may not read (403). Kept off the report, which is serialized into the
   * migration summary.
   */
  authError?: unknown;
  /**
   * Listed invoices the caller's `select` predicate declined BEFORE the
   * detail pass, so no budget was spent on them. Absent when no predicate
   * was given (every listed invoice is in `invoices`).
   */
  excluded?: T[];
}

/**
 * Caller's choice of which listed invoices are worth a detail fetch. Runs on
 * the list payload, before hydration, so a declined invoice costs nothing
 * beyond its share of the list page.
 */
export type InvoiceSelect<T extends SalesInvoiceDto | SupplierInvoiceDto> = (dto: T) => boolean;

function partitionBySelect<T extends SalesInvoiceDto | SupplierInvoiceDto>(
  invoices: T[],
  select: InvoiceSelect<T> | undefined,
): { kept: T[]; excluded: T[] } {
  if (!select) return { kept: invoices, excluded: [] };
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const dto of invoices) (select(dto) ? kept : excluded).push(dto);
  return { kept, excluded };
}

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
  const raw = dto._raw?._completionDetailId ?? dto._raw?.[idField];
  return raw !== undefined && raw !== null && raw !== '' ? String(raw) : dto.id;
}

function detailFetcher(
  provider: ProviderName,
  resource: DetailResource,
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
    const creditNotes = resource === ResourceType.SalesInvoices
      ? BOKIO_RESOURCE_CONFIGS[ResourceType.CreditNotes]
      : undefined;
    return async (dto) => {
      // A Bokio kreditfaktura lives on /credit-notes/{id}; asking
      // /invoices/{id} for it answers 404. The list payload's shape says
      // which one this is.
      const target = creditNotes && (dto._raw?._completionCreditNote || isBokioCreditNotePayload(dto._raw)) ? creditNotes : config;
      return bokioClient.getDetail<Record<string, unknown>>(
        accessToken, providerCompanyId, path(target.detailEndpoint, detailId(dto, target.idField)),
      );
    };
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
  resource: DetailResource,
): ((raw: Record<string, unknown>) => unknown) | null {
  const configs: Partial<Record<DetailResource, { mapper: (raw: Record<string, unknown>) => unknown }>> = {
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

interface InvoiceEnrichment<T> {
  needed: (dto: T) => boolean;
  apply: (dto: T) => Promise<T>;
}

/**
 * Bokio names the journal UUID, while the SIE linker needs its voucher number.
 * Fetch only that entry, after any invoice detail replacement, under the same
 * hydration deadline. No process-wide cache can leak refs between companies.
 */
function bokioVoucherEnrichment<T extends SalesInvoiceDto | SupplierInvoiceDto>(
  provider: ProviderName, accessToken: string, companyId: string | undefined,
  supplier = false,
): InvoiceEnrichment<T> | undefined {
  if (provider !== 'bokio' || !companyId) return undefined;
  const entryId = (dto: T): string | undefined => {
    const ref = dto._raw?.['journalEntryRef'] as { id?: unknown } | null | undefined;
    return typeof ref?.id === 'string' && ref.id ? ref.id : undefined;
  };
  const entries = new Map<string, ReturnType<typeof fetchBokioVoucherRef>>();
  return {
    needed: dto => supplier ? !(dto as SupplierInvoiceDto).supplierEvidence?.sourceEntryId && !!entryId(dto) : !dto.sourceVoucher && !!entryId(dto),
    apply: async dto => {
      const id = entryId(dto);
      if (!id) return supplier ? enrichBokioSupplierInvoice(dto as SupplierInvoiceDto) as T : dto;
      if (!supplier && dto.sourceVoucher) return dto;
      let pending = entries.get(id);
      if (!pending) {
        pending = fetchBokioVoucherRef(bokioClient, accessToken, companyId, id);
        entries.set(id, pending);
      }
      const entry = await pending;
      if (supplier) return enrichBokioSupplierInvoice(dto as SupplierInvoiceDto, entry) as T;
      const { series, number } = entry;
      return { ...dto, sourceVoucher: { series, number } };
    },
  };
}

/**
 * Drafts first, then the other unpaid invoices, then the paid ones. A draft
 * is the next document the user sends, and without its detail form it has
 * no rows and no VAT to send with (crm#1245: 29 of 63 drafts lost the
 * budget to sent invoices). Unpaid invoices are the ones a later payment
 * match or credit note will book.
 */
function invoiceHydrationRank(dto: SalesInvoiceDto | SupplierInvoiceDto): number {
  return dto.status === 'draft' ? 0 : dto.paymentStatus.paid ? 2 : 1;
}

/**
 * Replace list-form records with their detail form, in `rank` order (invoices:
 * open ones first, see invoiceHydrationRank).
 *
 * Returns a NEW array in the original order; entries that were not hydrated
 * (already complete, out of budget, or the fetch failed) retain the latest
 * successfully mapped payload. The caller never loses a record.
 *
 * `unhydratedIds` names the invoices that NEEDED a detail form and did not
 * get one (budget, abort, or a failed fetch). A consumer that reads a field
 * only the detail form carries (Fortnox's booking voucher, for instance) can
 * tell "the provider reported none" from "we never asked" only through this
 * set; the counts in the report do not say which invoices they were.
 */
async function hydrateRegister<T extends { id: string }>(
  items: T[],
  needsDetail: (dto: T) => boolean,
  fetchDetail: DetailFetch | null,
  mapper: ((raw: Record<string, unknown>) => unknown) | null,
  label: string,
  budgetMs: number,
  enrichment?: InvoiceEnrichment<T>,
  rank: (dto: T) => number = () => 0,
): Promise<{ items: T[]; report: HydrationReport; unhydratedIds: Set<string>; authError?: unknown }> {
  if (!fetchDetail || !mapper) {
    return { items, report: { ...EMPTY_HYDRATION_REPORT }, unhydratedIds: new Set() };
  }

  const pending = items
    .map((dto, index) => ({ dto, index }))
    .filter(({ dto }) => (needsDetail(dto) || enrichment?.needed(dto)) && dto.id);

  if (pending.length === 0) {
    return { items, report: { ...EMPTY_HYDRATION_REPORT }, unhydratedIds: new Set() };
  }

  // The sort is stable, so list order holds within each rank.
  pending.sort((a, b) => rank(a.dto) - rank(b.dto));

  const hydrated = [...items];
  const report: HydrationReport = { ...EMPTY_HYDRATION_REPORT, needed: pending.length };
  // Every pending id starts out unhydrated and is removed on success.
  const unhydratedIds = new Set<string>(pending.map(({ dto }) => dto.id));
  const deadline = Math.min(Date.now() + budgetMs, currentExecutionBudget()?.deadline ?? Infinity);
  let aborted: 'auth' | 'budget' | null = null;
  let authError: unknown;

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
      let result = dto;
      if (needsDetail(dto)) {
        const raw = await withExecutionDeadline(deadline, 'invoice-detail', () => fetchDetail(dto));
        if (!raw) {
          report.failed++;
          return;
        }
        result = mapper(raw) as T;
        // Retain recovered detail even if the optional voucher lookup fails.
        hydrated[index] = result;
      }
      if (enrichment?.needed(result)) {
        result = await withExecutionDeadline(deadline, 'invoice-enrichment', () => enrichment.apply(result));
      }
      hydrated[index] = result;
      report.hydrated++;
      unhydratedIds.delete(dto.id);
    } catch (err) {
      if (err instanceof ExecutionBudgetExceeded) {
        report.skippedForBudget++;
        aborted = 'budget';
        return;
      }
      report.failed++;

      // A rejected token or a missing scope fails identically for every
      // remaining invoice. Issuing hundreds more doomed calls would spend the
      // rate-limit budget (shared platform-wide, see acquire()) for nothing
      // and bury the real cause under a wall of identical warnings.
      if (isProviderRefusal(err)) {
        aborted = 'auth';
        authError = err;
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

  log.info(
    `${label} hydration: ${report.hydrated}/${report.needed} hydrated, `
    + `${report.failed} failed, ${report.skippedForBudget} not attempted`
    + (aborted ? ` (stopped early: ${aborted})` : ''),
  );

  return { items: hydrated, report, unhydratedIds, authError };
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
  select?: InvoiceSelect<SalesInvoiceDto>,
): Promise<HydratedInvoices<SalesInvoiceDto>> {
  const listed = await fetchSalesInvoicesDirect(provider, accessToken, providerCompanyId);
  const { kept, excluded } = partitionBySelect(listed, select);
  const hydrated = await hydrateSalesInvoices(provider, accessToken, providerCompanyId, kept, budgetMs);
  return { ...hydrated, excluded };
}

/**
 * Hydrate a caller-chosen set of already-listed sales invoices.
 *
 * The migration's own pass (above) spends its budget on the WHOLE register,
 * open invoices first, and reports what it did not reach. A follow-up that
 * wants to finish the job must not repeat that: re-hydrating the register
 * from the top would spend every run on the same open invoices and never get
 * to the ones still missing their rows. This entry point takes the subset the
 * caller already knows to be incomplete on its own side, so each run makes
 * progress on exactly those. Invoices that need nothing (a list payload that
 * carried its rows) pass through unrequested, as in the full pass.
 *
 * Returns the invoices in the order given; see `hydrateRegister` for the
 * report and `unhydratedIds` semantics.
 */
export async function hydrateSalesInvoices(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId: string | undefined,
  invoices: SalesInvoiceDto[],
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
): Promise<HydratedInvoices<SalesInvoiceDto>> {
  const { items, report, unhydratedIds, authError } = await hydrateRegister<SalesInvoiceDto>(
    invoices,
    salesInvoiceNeedsDetail,
    detailFetcher(provider, ResourceType.SalesInvoices, accessToken, providerCompanyId),
    resourceMapper(provider, ResourceType.SalesInvoices),
    `${provider} sales-invoice`,
    budgetMs,
    bokioVoucherEnrichment(provider, accessToken, providerCompanyId),
    invoiceHydrationRank,
  );

  return { invoices: items, hydration: report, unhydratedIds, authError };
}

/** Supplier invoices with their detail payloads merged in where needed. */
export async function fetchSupplierInvoicesHydrated(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId?: string,
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
  select?: InvoiceSelect<SupplierInvoiceDto>,
): Promise<HydratedInvoices<SupplierInvoiceDto>> {
  const listed = await fetchSupplierInvoicesDirect(provider, accessToken, providerCompanyId);
  const { kept, excluded } = partitionBySelect(listed, select);
  const hydrated = await hydrateSupplierInvoices(provider, accessToken, providerCompanyId, kept, budgetMs);
  return { ...hydrated, excluded };
}

/**
 * Hydrate a caller-chosen set of already-listed supplier invoices: the
 * supplier-side twin of hydrateSalesInvoices, for callers that list first,
 * drop what they already hold, and spend the budget on the rest.
 */
export async function hydrateSupplierInvoices(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId: string | undefined,
  invoices: SupplierInvoiceDto[],
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
): Promise<HydratedInvoices<SupplierInvoiceDto>> {
  const { items, report, unhydratedIds, authError } = await hydrateRegister<SupplierInvoiceDto>(
    invoices,
    provider === 'bokio' ? () => false : supplierInvoiceNeedsDetail,
    detailFetcher(provider, ResourceType.SupplierInvoices, accessToken, providerCompanyId),
    resourceMapper(provider, ResourceType.SupplierInvoices),
    `${provider} supplier-invoice`,
    budgetMs,
    bokioVoucherEnrichment(provider, accessToken, providerCompanyId, true),
    invoiceHydrationRank,
  );

  return { invoices: provider === 'bokio' ? items.map(dto => dto.supplierEvidence ? dto : enrichBokioSupplierInvoice(dto)) : items, hydration: report, unhydratedIds, authError };
}

/**
 * Does a listed customer or supplier need its detail form?
 *
 * Fortnox lists both registers in a short form, and what the short form
 * leaves out is lost without a word: a customer's TermsOfPayment, VATNumber,
 * EmailInvoice and its copies, YourReference and Type (crm#1245), a
 * supplier's Country and VATNumber, and the phone, which the list names
 * Phone where the record names it Phone1 (crm#1436). So a Fortnox customer or
 * supplier is always read from its own record, one request each. The other
 * providers are left as they were.
 */
function partyNeedsDetail(provider: ProviderName): () => boolean {
  return provider === 'fortnox' ? () => true : () => false;
}

/** A customer register with its detail payloads merged in, plus what the pass missed. */
export interface HydratedCustomers {
  customers: CustomerDto[];
  hydration: HydrationReport;
  /** Ids of customers that needed their detail form and did not get it. */
  unhydratedIds: Set<string>;
  /** The provider's own error when the pass stopped on it (`abortedBy: 'auth'`). */
  authError?: unknown;
}

/**
 * Listed customers in their detail form where the provider lists a short one
 * (partyNeedsDetail), in the order given. Bounded like the invoice passes: a
 * customer the budget does not reach, or whose detail cannot be read, keeps
 * its list form and is named in `unhydratedIds`.
 */
export async function hydrateCustomers(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId: string | undefined,
  customers: CustomerDto[],
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
): Promise<HydratedCustomers> {
  const { items, report, unhydratedIds, authError } = await hydrateRegister<CustomerDto>(
    customers,
    partyNeedsDetail(provider),
    detailFetcher(provider, ResourceType.Customers, accessToken, providerCompanyId),
    resourceMapper(provider, ResourceType.Customers),
    `${provider} customer`,
    budgetMs,
  );

  return { customers: items, hydration: report, unhydratedIds, authError };
}

/** A supplier register with its detail payloads merged in, plus what the pass missed. */
export interface HydratedSuppliers {
  suppliers: SupplierDto[];
  hydration: HydrationReport;
  /** Ids of suppliers that needed their detail form and did not get it. */
  unhydratedIds: Set<string>;
  /** The provider's own error when the pass stopped on it (`abortedBy: 'auth'`). */
  authError?: unknown;
}

/** The supplier twin of hydrateCustomers, under the same rule and bounds. */
export async function hydrateSuppliers(
  provider: ProviderName,
  accessToken: string,
  providerCompanyId: string | undefined,
  suppliers: SupplierDto[],
  budgetMs: number = DEFAULT_HYDRATION_BUDGET_MS,
): Promise<HydratedSuppliers> {
  const { items, report, unhydratedIds, authError } = await hydrateRegister<SupplierDto>(
    suppliers,
    partyNeedsDetail(provider),
    detailFetcher(provider, ResourceType.Suppliers, accessToken, providerCompanyId),
    resourceMapper(provider, ResourceType.Suppliers),
    `${provider} supplier`,
    budgetMs,
  );

  return { suppliers: items, hydration: report, unhydratedIds, authError };
}
