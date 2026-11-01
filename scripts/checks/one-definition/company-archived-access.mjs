export default {
  rule: 'company-archived-access',
  says: 'An archived company is out of reach for every caller, reads and writes alike, whichever door the caller comes through.',
  home: 'src/lib/company/company-access.ts: readLiveMembership',
  why: 'The v1 gate read company_members with no archived check, so a key kept reading and writing a deleted company that MCP and /api/events refused.',
  match: [/\.from\('company_members'\)/],
  sanctioned: ['lib/company/company-access.ts'],
  allowed: {
    'app/api/v1/api-key/route.ts': 'lists every company the key reaches, archived filtered in the query',
    'app/api/v1/companies/route.ts': 'lists every company the key reaches, archived filtered in the query',
    'app/api/v1/companies/[companyId]/invoices/[id]/send/route.ts': 'a role check behind the company gate, not access to the company',
    'extensions/general/mcp-server/server.ts': 'asks whether any other live company exists, not access to one',
  },
  // The doors that run as the service role, where RLS does not hold this rule.
  scan: [
    'app/api/v1/',
    'app/api/events/',
    'app/api/calendar/',
    'app/attest/',
    'lib/api/v1/',
    'lib/supplier-invoices/attest-link-route.ts',
    'extensions/general/mcp-server/',
  ],
}
