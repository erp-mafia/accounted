/**
 * /api/v1/companies/{companyId}/peppol/registration: the company's Peppol
 * receiving status (GET, operation peppol.get-registration) and publishing
 * its participant id at the access point (POST, operation peppol.register).
 *
 * Contract, docs and rules live in src/lib/operations/peppol.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { peppolGetRegistration, peppolRegister } from '@/lib/operations/peppol'

ensureInitialized()

// The connector transport waits up to 60 s for the hosted access point; the
// platform default would cut the registration off mid-call and leave a
// pending row behind.
export const maxDuration = 90

export const GET = v1OperationHandler(peppolGetRegistration)
export const POST = v1OperationHandler(peppolRegister)
