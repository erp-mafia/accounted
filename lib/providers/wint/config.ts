import { ResourceType } from '../dto';
import type { RateLimitConfig, WintResourceConfig } from '../types';
import {
  mapWintToSalesInvoice,
  mapWintToCustomer,
  mapWintToAccountingAccount,
  mapWintToCompanyInformation,
} from './mapper';

// WINT has no published developer docs; every endpoint below comes from the
// OpenAPI specs their API host serves itself (https://api.wint.se/index.html,
// spec /swagger/v1/swagger.json, fetched 2026-08-06). We deliberately stay on
// the partner-facing "v1" surface: the SIE export and IncomingInvoice
// endpoints exist only in their Full/Internal specs and are NOT used here
// (Tier A: the general ledger is reconstructed from /api/Voucher + /api/Account
// and rendered as SIE on our side; see sie-builder.ts).
export const WINT_BASE_URL = 'https://api.wint.se';

// Undocumented; start conservative until WINT confirms a real budget.
export const WINT_RATE_LIMIT: RateLimitConfig = { maxRequests: 3, windowMs: 1000 };

export const WINT_RESOURCE_CONFIGS: Partial<Record<ResourceType, WintResourceConfig>> = {
  [ResourceType.SalesInvoices]: {
    listEndpoint: '/api/Invoice',
    detailEndpoint: '/api/Invoice/{id}',
    idField: 'Id',
    mapper: mapWintToSalesInvoice,
    paginated: true,
    modifiedParam: 'LastUpdated',
  },
  [ResourceType.Customers]: {
    listEndpoint: '/api/Customer',
    detailEndpoint: '/api/Customer/{id}',
    idField: 'Id',
    mapper: mapWintToCustomer,
    paginated: true,
    modifiedParam: 'UpdatedAfter',
  },
  [ResourceType.AccountingAccounts]: {
    listEndpoint: '/api/Account',
    detailEndpoint: '/api/Account',
    idField: 'Id',
    mapper: mapWintToAccountingAccount,
    paginated: true,
  },
  [ResourceType.CompanyInformation]: {
    // GET /api/Auth describes the company the current token is scoped to
    // (Id, Name, Org, NoVat, FinancialYears, ...): WINT has no separate
    // company-information endpoint on the v1 surface.
    listEndpoint: '/api/Auth',
    detailEndpoint: '/api/Auth',
    idField: 'Id',
    mapper: mapWintToCompanyInformation,
    singleton: true,
  },
};
