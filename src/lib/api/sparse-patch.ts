/**
 * Sparse PATCH parsing: keep only the fields the caller actually sent.
 *
 * ## The problem
 *
 * Zod's `.partial()` makes every key optional; it does NOT strip `.default()`.
 * Verified against the zod version in this repo (4.4.3):
 *
 * ```
 * const Base  = z.object({ amount: z.number(), is_taxable: z.boolean().default(true) })
 * Base.partial().parse({ amount: 5500 })
 * // -> { amount: 5500, is_taxable: true }     <- is_taxable was NEVER sent
 * ```
 *
 * Routes that spread that result into `.update()` therefore reset every
 * defaulted column on every PATCH: naming one field silently rewrites the
 * others. The repo hit this three times independently (an
 * `EmployeeSchemaPatchBase` re-declaration in lib/api/schemas.ts and a
 * hand-rolled `rawKeys` intersection in three v1 routes). This module is the
 * shared version of the `rawKeys` intersection, which is the one that
 * generalises: it needs nothing from the schema's internals, so it works on
 * `.partial()`, `.omit()`, and `.superRefine()`-wrapped schemas alike, and it
 * cannot drift the way a hand-maintained duplicate base shape does.
 *
 * ## Semantics
 *
 * The output contains exactly the keys that are BOTH (a) literally present as
 * own properties of the raw JSON body and (b) known to the schema.
 *
 * | raw body                | in output?                                      |
 * |-------------------------|-------------------------------------------------|
 * | `{ "amount": 5500 }`    | `amount: 5500` only. Defaults never materialise. |
 * | `{ "note": null }`      | `note: null`. An explicit null is a deliberate   |
 * |                         | clear and MUST survive: null-vs-absent is the    |
 * |                         | entire point of this helper.                     |
 * | key absent              | absent. The column is left untouched.            |
 * | `{ "q": undefined }`    | dropped. `undefined` is not expressible in JSON, |
 * |                         | so a caller can never have meant it; inventing a |
 * |                         | `null` would clear a column nobody asked to      |
 * |                         | clear. (Only reachable from in-process callers.) |
 * | unknown key             | dropped. The intersection runs over the schema's |
 * |                         | parsed output, so unknown keys cannot reach the  |
 * |                         | database (mass-assignment defense).              |
 * | `{ "tags": [] }`        | `tags: []`. An array VALUE is a value: it is     |
 * |                         | taken wholesale, empty array included.           |
 * | body is an array/scalar | rejected. A patch document must be a JSON object.|
 *
 * **Shallow by design.** A key whose value is an object is replaced wholesale,
 * including any `.default()` Zod filled in *inside* that object. This is
 * correct for the intended sink: `UPDATE ... SET col = $1` replaces a whole
 * jsonb column, so a "partially patched" nested object would write a value the
 * caller never described. If a nested field genuinely needs per-key merge
 * semantics, merge it against the stored row in the route, explicitly.
 *
 * Validation itself is unchanged: the schema parses the raw body first, so
 * refinements still see the default-filled object exactly as before. Only the
 * *write set* is narrowed.
 *
 * ## When NOT to use this
 *
 * The narrowing happens AFTER parsing, so it only helps a sink that writes the
 * keys it is handed. Two shapes it does not fix:
 *
 * 1. **A fixed-column sink** (an upsert that writes a whole row or a whole
 *    jsonb document). Narrowing the patch does not stop the unmentioned columns
 *    from being written; it only makes them `undefined`. Such a route must merge
 *    the sparse patch over the STORED row before writing (see
 *    `app/api/kpi/preferences/route.ts`).
 * 2. **A CROSS-FIELD `.refine` / `.superRefine`.** The refinement runs on the
 *    default-filled parse, so it judges values the caller never sent: it can
 *    reject a legitimate patch and accept an illegitimate one. Strip the
 *    defaults from the patch base instead (see `EmployeeSchemaPatchBase` in
 *    `lib/api/schemas.ts`), or validate against the stored row in the route.
 *
 * A schema whose own top-level `.transform()` reshapes the output is also out of
 * scope: the intersection runs against the raw body's keys, so invented keys are
 * dropped. Narrow before transforming, not after.
 *
 * ## Usage
 *
 * With `validateBody` (cookie-session routes):
 * ```ts
 * const validation = await validateBody(request, sparsePatchBody(UpdateThingSchema))
 * if (!validation.success) return validation.response
 * if (Object.keys(validation.data).length === 0) { ... nothing to update ... }
 * ```
 *
 * With a raw body already in hand (v1 REST / MCP):
 * ```ts
 * const patch = sparsePatch(UpdateThingSchema, rawBody)
 * if (!patch.success) return v1ErrorResponseFromCode('VALIDATION_ERROR', ...)
 * ```
 */

import { z } from 'zod'

/**
 * Own properties that `JSON.parse` can produce but that must never be carried
 * into an object literal. `parsed.data` (Zod's output) can never contain them,
 * so the intersection already blocks them; filtering the present-key set too
 * makes the intent unambiguous. Mirrors the guard the v1 routes already ship.
 */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export type SparsePatchResult<T> =
  | { success: true; data: Partial<T> }
  | { success: false; error: z.ZodError }

/** A patch document is a plain JSON object: not null, not an array, not a scalar. */
export function isPatchDocument(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

/** Own enumerable keys of a raw JSON body, minus the prototype-polluting ones. */
function presentKeys(rawBody: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(rawBody).filter((key) => !POLLUTING_KEYS.has(key)))
}

/**
 * Parse `rawBody` with `schema`, then keep only the keys the caller literally
 * sent. See the module docblock for the exact null-vs-absent semantics.
 */
export function sparsePatch<S extends z.ZodType>(
  schema: S,
  rawBody: unknown,
): SparsePatchResult<z.infer<S>> {
  if (!isPatchDocument(rawBody)) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'object',
          input: rawBody,
          path: [],
          message: 'Body must be a JSON object.',
        },
      ]),
    }
  }

  const parsed = schema.safeParse(rawBody)
  if (!parsed.success) {
    return { success: false, error: parsed.error }
  }

  // A schema whose output is not an object has no keys to narrow, so the caller
  // has misused the helper. Fail loudly instead of throwing an opaque
  // "Cannot convert undefined or null to object" out of Object.entries.
  if (!isPatchDocument(parsed.data)) {
    throw new TypeError(
      'sparsePatch requires a schema whose output is an object; got ' + typeof parsed.data,
    )
  }

  const present = presentKeys(rawBody)
  const data: Record<string, unknown> = {}
  // Iterate the PARSED output, not the raw body: unknown keys the schema
  // stripped must not reappear, and the values must be the coerced/validated
  // ones. `value !== undefined` drops keys that survived parsing without a
  // value (see the table above); an explicit `null` is kept.
  for (const [key, value] of Object.entries(parsed.data)) {
    if (present.has(key) && value !== undefined) {
      data[key] = value
    }
  }

  return { success: true, data: data as Partial<z.infer<S>> }
}

/**
 * Wrap a schema so `validateBody()` yields the sparse patch instead of the
 * default-filled object. Every validation issue is forwarded with its original
 * `code` and `path`, so the 400 envelope is byte-identical to a plain
 * `validateBody(request, schema)` (pinned by a test that compares the two).
 */
export function sparsePatchBody<S extends z.ZodType>(
  schema: S,
): z.ZodType<Partial<z.infer<S>>, unknown> {
  return z.unknown().transform((raw, ctx) => {
    const result = sparsePatch(schema, raw)
    if (!result.success) {
      // Forwarded by spread, not by passing `issue` straight through: Zod 4
      // types `addIssue` against the RAW issue shape, and a finalized
      // `$ZodIssue` is an interface, so it gets no implicit index signature and
      // will not satisfy that shape. A spread produces an object literal type,
      // which does, so the original `code` and `path` survive into the 400
      // envelope with no cast and without flattening to `custom`.
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue })
      }
      return z.NEVER
    }
    return result.data
  })
}
