/**
 * The unexplained queue (see ./registry.ts): differences that should be
 * zero, each read from the report a person sees, explained down to the
 * items behind it.
 */
export {
  BRIEFING_TOP,
  CHECK_DEFINITIONS,
  DEFAULT_ITEM_LIMIT,
  MAX_ITEM_LIMIT,
  MAX_LIST_ROWS,
  REGISTERED_CHECK_IDS,
  explainUnexplained,
  getCheckDefinition,
  getUnexplainedCheck,
  listUnexplained,
  summarizeUnexplained,
  type UnexplainedBriefing,
  type UnexplainedCheck,
  type UnexplainedExplanation,
  type UnexplainedList,
  type UnexplainedOutcome,
  type UnexplainedRow,
} from './registry'
export {
  CHECK_IDS,
  SUBJECT_PARAM_KEYS,
  isCheckId,
  type CheckId,
  type CheckStatus,
  type CheckSubjectParams,
} from './types'
