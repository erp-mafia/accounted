/**
 * Top-level argument allow-listing for tools/call.
 *
 * Every tool inputSchema declares `additionalProperties: false` (guarded by
 * strict-schemas.test.ts), but hosts do not reliably enforce it, so a
 * misspelled parameter used to be dropped silently: gnubok_query_journal
 * called with {query} instead of {text} returned the whole journal with
 * applied_filters.text null (feedback seq 261545). Unknown top-level keys are
 * a caller error, never data, and are rejected before execute().
 *
 * company_id is tolerated everywhere: the company-routing layer strips it for
 * company-dependent tools, and a client that always sends it must not break
 * on the few tools that ignore it.
 */
export function listArgKeys(inputSchema: Record<string, unknown>): string[] {
  const properties = inputSchema.properties
  if (!properties || typeof properties !== 'object') return []
  return Object.keys(properties as Record<string, unknown>)
}

export function findUnknownArgKeys(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  if (inputSchema.additionalProperties !== false) return []
  const allowed = new Set(listArgKeys(inputSchema))
  return Object.keys(args).filter((key) => key !== 'company_id' && !allowed.has(key))
}

/**
 * The shortest worked example a tool publishes, serialized for an error
 * message, or '' when it has none or the shortest is too long to help.
 *
 * "Valid parameters: period_id" told DueCue's agent which key was wrong but
 * not what a correct call looks like, and the same rejected call repeated for
 * seven days (604 of them). One example costs nothing in tools/list, because
 * it only ships on the response to a call that already failed.
 */
export function shortestExampleFor(inputSchema: Record<string, unknown>, maxChars = 200): string {
  const examples = inputSchema.examples
  if (!Array.isArray(examples) || examples.length === 0) return ''
  const serialized = examples
    .map((e) => JSON.stringify(e))
    .filter((json): json is string => typeof json === 'string')
    .sort((a, b) => a.length - b.length)
  const shortest = serialized.find((json) => json.length <= maxChars)
  return shortest ?? ''
}
