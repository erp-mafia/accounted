/**
 * Typed domain errors for the member register and the värdeöverföringar
 * (distributions) of an ekonomisk förening. Each carries a code from the
 * structured error catalogue (lib/errors/structured-errors.ts), so a route
 * maps it to the canonical envelope with errorResponseFromCode.
 */
export type AssociationRegisterErrorCode =
  | 'ASSOCIATION_FORM_REQUIRED'
  | 'ASSOCIATION_MEMBER_NOT_FOUND'
  | 'ASSOCIATION_MEMBER_ALREADY_EXITED'
  | 'ASSOCIATION_CONTRIBUTION_NOT_FOUND'
  | 'ASSOCIATION_CONTRIBUTION_ALREADY_SETTLED'
  | 'ASSOCIATION_REPAYMENT_BEFORE_EXIT'
  | 'ASSOCIATION_REPAYMENT_EXCEEDS_CONTRIBUTION'
  | 'ASSOCIATION_DISTRIBUTION_NOT_FOUND'
  | 'ASSOCIATION_DISTRIBUTION_EXCEEDS_FREE_EQUITY'
  | 'ASSOCIATION_DISTRIBUTION_NO_BASIS'
  | 'ASSOCIATION_DISTRIBUTION_ALLOCATIONS_MISMATCH'
  | 'ASSOCIATION_DISTRIBUTION_ALREADY_BOOKED'
  | 'ASSOCIATION_DISTRIBUTION_NOT_BOOKED'
  | 'ASSOCIATION_DISTRIBUTION_ALREADY_PAID'
  | 'ASSOCIATION_DISTRIBUTION_NO_OPEN_PERIOD'
  | 'ASSOCIATION_AUDITOR_NOT_FOUND'
  | 'ASSOCIATION_AUDITOR_ALREADY_ENDED'
  | 'ASSOCIATION_AUDIT_DOCUMENT_NOT_FOUND'

export class AssociationRegisterError extends Error {
  readonly code: AssociationRegisterErrorCode
  constructor(code: AssociationRegisterErrorCode) {
    super(code)
    this.name = 'AssociationRegisterError'
    this.code = code
  }
}
