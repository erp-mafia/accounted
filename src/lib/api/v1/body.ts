/**
 * JSON body reader for v1 routes.
 *
 * Every v1 write route parses its body the same way: read JSON, and on a
 * malformed body answer with the VALIDATION_ERROR envelope pointing at
 * `body`. This helper is that block, so routes do:
 *
 *   const raw = await readV1JsonBody(request, ctx)
 *   if (!raw.ok) return raw.response
 *   const parsed = Schema.safeParse(raw.body)
 */

import type { NextResponse } from 'next/server'
import { v1ErrorResponseFromCode, type V1ValidationContext } from './errors'

export type V1JsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse }

export async function readV1JsonBody(
  request: Request,
  ctx: V1ValidationContext,
): Promise<V1JsonBodyResult> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      }),
    }
  }
}
