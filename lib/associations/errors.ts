/**
 * Typed domain errors for the member register. Each carries a code from the
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

export class AssociationRegisterError extends Error {
  readonly code: AssociationRegisterErrorCode
  constructor(code: AssociationRegisterErrorCode) {
    super(code)
    this.name = 'AssociationRegisterError'
    this.code = code
  }
}
