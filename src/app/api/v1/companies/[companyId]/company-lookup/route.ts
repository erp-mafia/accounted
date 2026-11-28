/**
 * POST /api/v1/companies/{companyId}/company-lookup: a company in the public
 * register by organisationsnummer (operation company-lookup.get, the register
 * answer gnubok_lookup_company gives over MCP). A read sent as POST so the
 * number stays out of the URL.
 *
 * Contract, docs and rules live in src/lib/operations/company-lookup.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { companyLookupGet } from '@/lib/operations/company-lookup'

export const POST = v1OperationHandler(companyLookupGet)
