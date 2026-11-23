/**
 * The active-company resolver RPC failing as it did in production, in the
 * shape postgrest-js hands back: a fetch that got no answer, a gateway's HTML
 * page where JSON was expected (no code), and PostgREST losing its schema
 * cache. Each makes getActiveCompanyId throw CompanyContextError
 * ('resolution_failed'): the active company is unknown for the moment, which
 * is not the same as the user having none.
 *
 * Used by the two session doors' tests:
 * - src/lib/api/__tests__/with-route-context-company-resolution.test.ts
 * - src/app/api/extensions/ext/[...path]/__tests__/route.company-resolution.test.ts
 */
export const RESOLVER_FAILURES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['a fetch that got no answer', { message: 'TypeError: fetch failed', details: '', hint: '', code: '' }],
  [
    'a Cloudflare error page in place of JSON',
    {
      message:
        '<!DOCTYPE html>\n<html class="no-js" lang="en-US">\n<head>\n<title>Script not found | example.supabase.co | Cloudflare</title>\n</head>\n</html>',
    },
  ],
  [
    'a gateway 502 page',
    { message: '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>' },
  ],
  [
    'PostgREST without its schema cache',
    { code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.', details: null, hint: null },
  ],
]
