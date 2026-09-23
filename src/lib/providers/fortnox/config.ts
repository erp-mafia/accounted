import { ResourceType } from '../dto';
import type { FortnoxResourceConfig, RateLimitConfig } from '../types';
import {
  mapFortnoxToSalesInvoice,
  mapFortnoxToSupplierInvoice,
  mapFortnoxToCustomer,
  mapFortnoxToSupplier,
  mapFortnoxToJournal,
  mapFortnoxToAccountingAccount,
  mapFortnoxToCompanyInformation,
} from './mapper';

export const FORTNOX_BASE_URL = 'https://api.fortnox.se/3';
export const FORTNOX_AUTH_URL = 'https://apps.fortnox.se/oauth-v1/auth';
export const FORTNOX_TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token';
export const FORTNOX_RATE_LIMIT: RateLimitConfig = { maxRequests: 4, windowMs: 1000 };

export const FORTNOX_RESOURCE_CONFIGS: Partial<Record<ResourceType, FortnoxResourceConfig>> = {
  [ResourceType.SalesInvoices]: {
    listEndpoint: '/invoices',
    listKey: 'Invoices',
    detailEndpoint: '/invoices/{id}',
    detailKey: 'Invoice',
    idField: 'DocumentNumber',
    mapper: mapFortnoxToSalesInvoice,
    supportsLastModified: true,
  },
  [ResourceType.SupplierInvoices]: {
    // Only fetch unpaid/open supplier invoices. Historic paid invoices add
    // noise and Fortnox's list endpoint doesn't reliably expose FullyPaid,
    // which caused paid invoices to be imported as unpaid.
    listEndpoint: '/supplierinvoices?filter=unpaid',
    listKey: 'SupplierInvoices',
    detailEndpoint: '/supplierinvoices/{id}',
    detailKey: 'SupplierInvoice',
    idField: 'GivenNumber',
    mapper: mapFortnoxToSupplierInvoice,
    supportsLastModified: true,
  },
  [ResourceType.Customers]: {
    listEndpoint: '/customers',
    listKey: 'Customers',
    detailEndpoint: '/customers/{id}',
    detailKey: 'Customer',
    idField: 'CustomerNumber',
    mapper: mapFortnoxToCustomer,
    supportsLastModified: true,
  },
  [ResourceType.Suppliers]: {
    listEndpoint: '/suppliers',
    listKey: 'Suppliers',
    detailEndpoint: '/suppliers/{id}',
    detailKey: 'Supplier',
    idField: 'SupplierNumber',
    mapper: mapFortnoxToSupplier,
    supportsLastModified: true,
  },
  [ResourceType.Journals]: {
    listEndpoint: '/vouchers',
    listKey: 'Vouchers',
    detailEndpoint: '/vouchers/{id}',
    detailKey: 'Voucher',
    idField: 'VoucherNumber',
    mapper: mapFortnoxToJournal,
    supportsLastModified: false,
    supportsEntryHydration: true,
    resolveDetailPath: (resourceId, query) => {
      const dashIdx = resourceId.indexOf('-');
      const series = dashIdx >= 0 ? resourceId.slice(0, dashIdx) : resourceId;
      const number = dashIdx >= 0 ? resourceId.slice(dashIdx + 1) : resourceId;
      const fy = query?.['financialyear'] ?? '';
      const params = fy ? `?financialyear=${fy}` : '';
      return `/vouchers/${series}/${number}${params}`;
    },
  },
  [ResourceType.AccountingAccounts]: {
    listEndpoint: '/accounts',
    listKey: 'Accounts',
    detailEndpoint: '/accounts/{id}',
    detailKey: 'Account',
    idField: 'Number',
    mapper: mapFortnoxToAccountingAccount,
    supportsLastModified: false,
  },
  [ResourceType.CompanyInformation]: {
    listEndpoint: '/companyinformation',
    listKey: 'CompanyInformation',
    detailEndpoint: '/companyinformation',
    detailKey: 'CompanyInformation',
    idField: 'OrganizationNumber',
    mapper: mapFortnoxToCompanyInformation,
    supportsLastModified: false,
    singleton: true,
  },
};
