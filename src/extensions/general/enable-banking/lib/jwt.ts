/**
 * Enable Banking JWT (moved to lib/connect/upstreams/enable-banking-jwt.ts).
 *
 * Core must never import from @/extensions/ (the zero-extension build would
 * break), so the implementation lives in lib/ where core code can reach it;
 * the extension re-exports it here so its own imports and tests are unchanged. The re-import direction
 * (extension -> lib) is the allowed one.
 */
export { getAuthorizationHeader, hasSigningCredentials, _resetTokenCache } from '@/lib/connect/upstreams/enable-banking-jwt'
