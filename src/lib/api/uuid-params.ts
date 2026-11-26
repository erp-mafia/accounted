/**
 * Path parameters that name a uuid row: withRouteContext's `uuidParams`.
 *
 * A dynamic segment such as `[id]` reaches the handler as whatever the URL
 * carried: `/bookkeeping/new`, typed by hand, asked the verifikat routes about
 * `new`. A value that is not a uuid names no row, but in a filter on a uuid
 * column Postgres refuses it outright (22P02, invalid input syntax for type
 * uuid), and a route's error branch answered that as a 500. Checked here,
 * before the handler runs, the route answers its own not-found instead. Only
 * the parameter is judged: a 22P02 raised by anything else the handler does
 * still surfaces as the error it is.
 */

import { isUuid } from '@/lib/invariants/uuid'

/**
 * Each path parameter that names a uuid row, with the code its route answers
 * for a row that is not there: a registered 404 such as ASSET_NOT_FOUND, or
 * NOT_FOUND where the route has no code of its own.
 */
export type UuidParamCodes<Name extends string = string> = { readonly [K in Name]?: string }

/**
 * The first declared parameter whose value is not a uuid, with its code; null
 * when every declared parameter holds one. A declared parameter the request
 * does not carry names no row either.
 */
export function malformedUuidParam(
  values: Readonly<Record<string, unknown>> | undefined,
  declared: UuidParamCodes | undefined,
): { param: string; code: string } | null {
  if (!declared) return null
  for (const [param, code] of Object.entries(declared)) {
    if (code && !isUuid(values?.[param])) return { param, code }
  }
  return null
}
