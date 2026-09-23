import { ResourceType } from '../dto';
import type { BrioxResourceConfig, RateLimitConfig } from '../types';
import {
  mapBrioxToSalesInvoice,
  mapBrioxToSupplierInvoice,
  mapBrioxToCustomer,
  mapBrioxToSupplier,
  mapBrioxToJournal,
  mapBrioxToAccountingAccount,
  mapBrioxToCompanyInformation,
} from './mapper';

export const BRIOX_BASE_URL = 'https://api-se.briox.services/v2';
export const BRIOX_TOKEN_URL = 'https://api-se.briox.services/v2/token';
export const BRIOX_REFRESH_URL = 'https://api-se.briox.services/v2/tokenrefresh';
export const BRIOX_RATE_LIMIT: RateLimitConfig = { maxRequests: 10, windowMs: 1000 };

export const BRIOX_RESOURCE_CONFIGS: Partial<Record<ResourceType, BrioxResourceConfig>> = {
  [ResourceType.SalesInvoices]: {
    listEndpoint: '/customerinvoice',
    detailEndpoint: '/customerinvoice/{id}',
    listKey: 'invoices',
    idField: 'id',
    mapper: mapBrioxToSalesInvoice,
    supportsModifiedFilter: true,
  },
  [ResourceType.SupplierInvoices]: {
    listEndpoint: '/supplierinvoice',
    detailEndpoint: '/supplierinvoice/{id}',
    listKey: 'supplierinvoices',
    idField: 'id',
    mapper: mapBrioxToSupplierInvoice,
    supportsModifiedFilter: true,
  },
  [ResourceType.Customers]: {
    listEndpoint: '/customer',
    detailEndpoint: '/customer/{id}',
    listKey: 'customers',
    idField: 'id',
    mapper: mapBrioxToCustomer,
    supportsModifiedFilter: true,
  },
  [ResourceType.Suppliers]: {
    listEndpoint: '/supplier',
    detailEndpoint: '/supplier/{id}',
    listKey: 'suppliers',
    idField: 'id',
    mapper: mapBrioxToSupplier,
    supportsModifiedFilter: true,
  },
  [ResourceType.Journals]: {
    listEndpoint: '/journal',
    detailEndpoint: '/journal/{id}',
    listKey: 'journals',
    idField: 'id',
    mapper: mapBrioxToJournal,
    supportsModifiedFilter: false,
    yearScoped: true,
    supportsEntryHydration: true,
    detailKey: 'journal',
  },
  [ResourceType.AccountingAccounts]: {
    listEndpoint: '/account',
    detailEndpoint: '/account/{id}',
    listKey: 'accounts',
    idField: 'id',
    mapper: mapBrioxToAccountingAccount,
    supportsModifiedFilter: false,
  },
  [ResourceType.CompanyInformation]: {
    listEndpoint: '/user/info',
    detailEndpoint: '/user/info',
    listKey: '',
    idField: 'id',
    mapper: mapBrioxToCompanyInformation,
    supportsModifiedFilter: false,
    singleton: true,
  },
};
