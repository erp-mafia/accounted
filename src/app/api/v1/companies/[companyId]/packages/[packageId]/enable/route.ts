/**
 * POST /api/v1/companies/{companyId}/packages/{packageId}/enable?stage=true:
 * stage switching a package on for an owner or admin to approve (operation
 * packages.enable, pending type enable_package). Stage only: a direct call
 * answers PACKAGE_SWITCH_STAGE_ONLY.
 *
 * Contract, docs and rules live in src/lib/operations/packages.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { packagesEnable } from '@/lib/operations/packages'

export const POST = v1OperationHandler(packagesEnable)
