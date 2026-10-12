/**
 * What a v1 REST route requires of the calling key.
 *
 * Each route states it once, in its own endpoint definition
 * (`registerEndpoint({ scope })` in the route file, or the operation's `scope`
 * through v1OperationHandler), and withApiV1 reads it from there on every
 * request. A handler whose route never registered answers NOT_FOUND to every
 * caller: a missing scope fails closed. The MCP analogue is TOOL_SCOPE_MAP in
 * scope-catalog.ts.
 */

import type { ApiKeyScope } from './api-keys'

/**
 * A key scope, or 'authenticated' for a route any valid key may call (the
 * key's own grant, GET /api/v1/api-key, must answer whatever scopes the key
 * holds: a key that lacks a scope could otherwise never learn which one).
 * A public route declares `scope: null` instead.
 */
export type V1RequiredScope = ApiKeyScope | 'authenticated'
