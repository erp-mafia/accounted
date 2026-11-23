/**
 * POST /api/v1/companies/{companyId}/accounts/oss-countries: say which EU
 * country each OSS account is for (operation accounts.oss-countries).
 *
 * Contract, docs and rules live in src/lib/operations/accounts.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { accountsOssCountries } from '@/lib/operations/accounts'

export const POST = v1OperationHandler(accountsOssCountries)
