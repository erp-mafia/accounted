/**
 * POST /api/v1/companies/{companyId}/packages/{packageId}/disable?stage=true:
 * stage switching a package off for an owner or admin to approve (operation
 * packages.disable, pending type disable_package). Open work keeps running
 * and keeps the package winding down until it is settled. Stage only: a
 * direct call answers PACKAGE_SWITCH_STAGE_ONLY.
 *
 * Contract, docs and rules live in src/lib/operations/packages.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { packagesDisable } from '@/lib/operations/packages'

export const POST = v1OperationHandler(packagesDisable)
