import { ResourceType } from '../dto';
import type { BokioResourceConfig, RateLimitConfig } from '../types';
import {
  mapBokioToSalesInvoice,
  mapBokioToCreditNote,
  mapBokioToCustomer,
  mapBokioToSupplier,
  mapBokioToSupplierInvoice,
  mapBokioToJournal,
  mapBokioToAccountingAccount,
  mapBokioToCompanyInformation,
} from './mapper';

export const BOKIO_BASE_URL = 'https://api.bokio.se/v1';
export const BOKIO_RATE_LIMIT: RateLimitConfig = { maxRequests: 5, windowMs: 1000 };

export const BOKIO_RESOURCE_CONFIGS: Partial<Record<ResourceType, BokioResourceConfig>> = {
  [ResourceType.SalesInvoices]: {
    listEndpoint: '/invoices',
    detailEndpoint: '/invoices/{id}',
    idField: 'id',
    mapper: mapBokioToSalesInvoice,
    paginated: true,
  },
  // Kreditfakturor are a resource of their own in Bokio's company API
  // (scope credit-notes:read). The fetcher lists them beside /invoices and
  // hydrates a credit note from this detail endpoint, never /invoices/{id}.
  [ResourceType.CreditNotes]: {
    listEndpoint: '/credit-notes',
    detailEndpoint: '/credit-notes/{id}',
    idField: 'id',
    mapper: mapBokioToCreditNote,
    paginated: true,
  },
  [ResourceType.Customers]: {
    listEndpoint: '/customers',
    detailEndpoint: '/customers/{id}',
    idField: 'id',
    mapper: mapBokioToCustomer,
    paginated: true,
  },
  [ResourceType.Suppliers]: {
    listEndpoint: '/suppliers',
    detailEndpoint: '/suppliers/{id}',
    idField: 'id',
    mapper: mapBokioToSupplier,
    paginated: true,
  },
  [ResourceType.SupplierInvoices]: {
    listEndpoint: '/supplier-invoices',
    detailEndpoint: '/supplier-invoices/{id}',
    idField: 'id',
    mapper: mapBokioToSupplierInvoice,
    paginated: true,
  },
  [ResourceType.Journals]: {
    listEndpoint: '/journal-entries',
    detailEndpoint: '/journal-entries/{id}',
    idField: 'id',
    mapper: mapBokioToJournal,
    paginated: true,
  },
  [ResourceType.AccountingAccounts]: {
    listEndpoint: '/chart-of-accounts',
    detailEndpoint: '/chart-of-accounts/{id}',
    idField: 'number',
    mapper: mapBokioToAccountingAccount,
    paginated: false,
  },
  [ResourceType.CompanyInformation]: {
    listEndpoint: '/company-information',
    detailEndpoint: '/company-information',
    idField: 'id',
    mapper: mapBokioToCompanyInformation,
    singleton: true,
    paginated: false,
  },
};
