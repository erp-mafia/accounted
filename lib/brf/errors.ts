/**
 * Typed domain errors of the bostadsrättsförening apartment register
 * (BRL 1991:614 9 kap.) and its KU55 export. Each carries a code from the
 * structured error catalogue (lib/errors/structured-errors.ts), so a route
 * maps it to the canonical envelope with errorResponseFromCode.
 */
export type BrfRegisterErrorCode =
  | 'BRF_APARTMENT_NOT_FOUND'
  | 'BRF_APARTMENT_NUMBER_TAKEN'
  | 'BRF_HOLDING_EXCEEDS_APARTMENT'
  | 'BRF_HOLDING_MEMBER_NOT_FOUND'
  | 'BRF_TRANSFER_FORBIDDEN'
  | 'BRF_TRANSFER_SAME_MEMBER'
  | 'BRF_TRANSFER_SELLER_NOT_HOLDER'
  | 'BRF_TRANSFER_SHARE_EXCEEDS_HOLDING'
  | 'BRF_TRANSFER_DATE_BEFORE_HOLDING'
  | 'BRF_TRANSFER_BUYER_NOT_MEMBER'
  | 'BRF_TRANSFER_DOCUMENT_NOT_FOUND'
  | 'BRF_PLEDGE_NOT_FOUND'
  | 'BRF_PLEDGE_ALREADY_RELEASED'
  | 'BRF_MEMBER_NOT_FOUND'

export class BrfRegisterError extends Error {
  readonly code: BrfRegisterErrorCode
  constructor(code: BrfRegisterErrorCode) {
    super(code)
    this.name = 'BrfRegisterError'
    this.code = code
  }
}
