import { ResourceType } from '../dto';
import type { VismaResourceConfig, RateLimitConfig } from '../types';
import {
  mapVismaToSalesInvoice,
  mapVismaToSupplierInvoice,
  mapVismaToCustomer,
  mapVismaToSupplier,
  mapVismaToJournal,
  mapVismaToAccountingAccount,
  mapVismaToCompanyInformation,
} from './mapper';

export const VISMA_BASE_URL = 'https://eaccountingapi.vismaonline.com/v2';
export const VISMA_AUTH_URL = 'https://identity.vismaonline.com/connect/authorize';
export const VISMA_TOKEN_URL = 'https://identity.vismaonline.com/connect/token';
export const VISMA_RATE_LIMIT: RateLimitConfig = { maxRequests: 10, windowMs: 1000 };

export const VISMA_RESOURCE_CONFIGS: Partial<Record<ResourceType, VismaResourceConfig>> = {
  [ResourceType.SalesInvoices]: {
    listEndpoint: '/customerinvoices',
    detailEndpoint: '/customerinvoices/{id}',
    idField: 'Id',
    mapper: mapVismaToSalesInvoice,
    supportsModifiedFilter: true,
    modifiedField: 'ModifiedUtc',
  },
  [ResourceType.SupplierInvoices]: {
    listEndpoint: '/supplierinvoices',
    detailEndpoint: '/supplierinvoices/{id}',
    idField: 'Id',
    mapper: mapVismaToSupplierInvoice,
    supportsModifiedFilter: true,
    modifiedField: 'ModifiedUtc',
  },
  [ResourceType.Customers]: {
    listEndpoint: '/customers',
    detailEndpoint: '/customers/{id}',
    idField: 'Id',
    mapper: mapVismaToCustomer,
    supportsModifiedFilter: true,
    modifiedField: 'ChangedUtc',
  },
  [ResourceType.Suppliers]: {
    listEndpoint: '/suppliers',
    detailEndpoint: '/suppliers/{id}',
    idField: 'Id',
    mapper: mapVismaToSupplier,
    supportsModifiedFilter: true,
    modifiedField: 'ModifiedUtc',
  },
  [ResourceType.Journals]: {
    listEndpoint: '/vouchers',
    detailEndpoint: '/vouchers/{id}',
    idField: 'Id',
    mapper: mapVismaToJournal,
    supportsModifiedFilter: false,
  },
  [ResourceType.AccountingAccounts]: {
    listEndpoint: '/accounts',
    detailEndpoint: '/accounts/{id}',
    idField: 'Number',
    mapper: mapVismaToAccountingAccount,
    supportsModifiedFilter: false,
  },
  [ResourceType.CompanyInformation]: {
    listEndpoint: '/companysettings',
    detailEndpoint: '/companysettings',
    idField: 'CorporateIdentityNumber',
    mapper: mapVismaToCompanyInformation,
    supportsModifiedFilter: false,
    singleton: true,
  },
};
