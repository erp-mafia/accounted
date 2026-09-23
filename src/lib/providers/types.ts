import type { ResourceType } from './dto';

export type ProviderName = 'fortnox' | 'visma' | 'briox' | 'bokio' | 'bjornlunden' | 'wint';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface ResourceConfig {
  listEndpoint: string;
  detailEndpoint: string;
  idField: string;
  mapper: (raw: Record<string, unknown>) => unknown;
  singleton?: boolean;
}

export interface FortnoxResourceConfig extends ResourceConfig {
  listKey: string;
  detailKey: string;
  supportsLastModified: boolean;
  resolveDetailPath?: (resourceId: string, query?: Record<string, string>) => string;
  supportsEntryHydration?: boolean;
}

export interface VismaResourceConfig extends ResourceConfig {
  supportsModifiedFilter: boolean;
  modifiedField?: string;
}

export interface BrioxResourceConfig extends ResourceConfig {
  listKey: string;
  supportsModifiedFilter: boolean;
  yearScoped?: boolean;
  supportsEntryHydration?: boolean;
  detailKey?: string;
}

export interface BokioResourceConfig extends ResourceConfig {
  paginated?: boolean;
}

export interface BjornLundenResourceConfig extends ResourceConfig {
  paginated?: boolean;
}

export interface WintResourceConfig extends ResourceConfig {
  paginated?: boolean;
  /** Query-param name for incremental fetches (WINT uses `UpdatedAfter` / `LastUpdated`). */
  modifiedParam?: string;
}
