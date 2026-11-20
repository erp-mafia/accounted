/**
 * When an AGI declaration is on record as filed at Skatteverket. It lives in
 * the deadlines block because deadlines sits below payroll and payments in
 * the module layers (lib/modules/README.md), so all three can read the one
 * definition. Pure: client components reach it through payroll's
 * agi-submission-state.
 */

/** agi_declarations statuses that carry Skatteverket's filing receipt. */
export const AGI_RECEIPT_STATUSES: readonly string[] = ['submitted', 'accepted']
