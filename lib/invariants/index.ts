/**
 * Shared product contracts: the formats and bounds more than one consumer must
 * agree on. See `README.md` in this directory for what belongs here.
 *
 * Zod primitives are deliberately NOT re-exported from this barrel: import them
 * from `@/lib/invariants/zod` so that non-Zod consumers keep a clean module
 * graph.
 */

export {
  ACCOUNT_NUMBER_RE,
  ACCOUNT_NUMBER_MESSAGE,
  isAccountNumber,
  accountClass,
} from './account-number'

export {
  ISO_DATE_RE,
  ISO_DATE_MESSAGE,
  ISO_DATE_MESSAGE_SV,
  SANE_DATE_MESSAGE,
  SANE_DATE_MIN_YEAR,
  SANE_DATE_MAX_YEAR,
  isIsoDateShaped,
  isSaneDateString,
} from './iso-date'

export {
  FISCAL_YEAR_RE,
  FISCAL_YEAR_MESSAGE,
  FISCAL_YEAR_MIN,
  FISCAL_YEAR_MAX,
  isFiscalYear,
} from './fiscal-year'

export {
  ORG_NUMBER_LENGTH,
  stripOrgNumberFormatting,
  isOrgNumberShaped,
  normalizeOrgNumber,
  isValidOrgNumber,
  hasInvalidOrgNumberCheckDigit,
  formatOrgNumberDisplay,
  toRedovisare12,
} from './org-number'
