/**
 * Enable Banking JWT (moved to lib/connect/upstreams/enable-banking-jwt.ts).
 *
 * The hosted connector proxy (core, app/api/connect/*) needs to mint this JWT
 * too, and core must never import from @/extensions/ (the zero-extension build
 * would break). So the implementation lives in lib/; the extension re-exports
 * it here so its own imports and tests are unchanged. The re-import direction
 * (extension -> lib) is the allowed one.
 */
export { getAuthorizationHeader, _resetTokenCache } from '@/lib/connect/upstreams/enable-banking-jwt'
