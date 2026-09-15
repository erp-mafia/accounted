import { ResourceType } from '../dto';
import type { BjornLundenResourceConfig, RateLimitConfig } from '../types';
import {
  mapBLToSalesInvoice,
  mapBLToSupplierInvoice,
  mapBLToCustomer,
  mapBLToSupplier,
  mapBLToJournal,
  mapBLToAccountingAccount,
  mapBLToCompanyInformation,
} from './mapper';

export const BL_BASE_URL = 'https://apigateway.blinfo.se/bla-api/v1/sp';
export const BL_RATE_LIMIT: RateLimitConfig = { maxRequests: 10, windowMs: 1000 };

/**
 * Rows per page on the batch endpoints (/customerinvoice/batch,
 * /supplierinvoice/batch, /journal/entry/batch).
 *
 * Measured against production BL on 2026-09-08 for a company holding 9 415
 * customer invoices: `rows` is honored at every size tried up to 10 000 (the
 * whole register in one 28 MB answer), and a 1 000-row page comes back in
 * about 1.4 s at ~3 MB. The previous default of 50 walked that register in
 * 189 sequential requests, which alone spent a third of the migration's
 * function ceiling before a single invoice was inserted.
 */
export const BL_BATCH_PAGE_SIZE = 1000;

export const BL_RESOURCE_CONFIGS: Partial<Record<ResourceType, BjornLundenResourceConfig>> = {
  [ResourceType.SalesInvoices]: {
    listEndpoint: '/customerinvoice/batch',
    detailEndpoint: '/customerinvoice/{id}',
    idField: 'invoiceNumber',
    mapper: mapBLToSalesInvoice,
    paginated: true,
  },
  [ResourceType.SupplierInvoices]: {
    listEndpoint: '/supplierinvoice/batch',
    detailEndpoint: '/supplierinvoice/byId/{id}',
    idField: 'entityId',
    mapper: mapBLToSupplierInvoice,
    paginated: true,
  },
  [ResourceType.Customers]: {
    listEndpoint: '/customer',
    detailEndpoint: '/customer/{id}',
    idField: 'id',
    mapper: mapBLToCustomer,
    paginated: false,
  },
  [ResourceType.Suppliers]: {
    listEndpoint: '/supplier',
    detailEndpoint: '/supplier/{id}',
    idField: 'id',
    mapper: mapBLToSupplier,
    paginated: false,
  },
  [ResourceType.Journals]: {
    listEndpoint: '/journal/entry/batch',
    detailEndpoint: '/journal/entry/{id}',
    idField: 'entityId',
    mapper: mapBLToJournal,
    paginated: true,
  },
  [ResourceType.AccountingAccounts]: {
    listEndpoint: '/account',
    detailEndpoint: '/account/{id}',
    idField: 'id',
    mapper: mapBLToAccountingAccount,
    paginated: false,
  },
  [ResourceType.CompanyInformation]: {
    listEndpoint: '/details',
    detailEndpoint: '',
    idField: '',
    mapper: mapBLToCompanyInformation,
    singleton: true,
    paginated: false,
  },
};
