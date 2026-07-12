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
import { ResourceType } from './dto';

// Singleton clients (they hold rate limiters)
const fortnoxClient = new FortnoxClient();
const vismaClient = new VismaClient();
const brioxClient = new BrioxClient();
const bokioClient = new BokioClient();
const bjornLundenClient = new BjornLundenClient();

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

  return [];
}
