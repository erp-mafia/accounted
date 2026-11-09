/**
 * The MCP half of the door catalog (src/lib/permissions/doors.ts): the
 * permission each tool needs, its effect, and whether it stages.
 *
 *   - A tool generated from an operation is the operation's door.
 *   - A hand-written tool defaults to its scope's door (TOOL_SCOPE_MAP and
 *     SCOPE_DOORS); MCP_TOOL_DOORS overrides the default where the scope is
 *     too coarse (a period close under bookkeeping:write, a register write
 *     under a ledger scope, an upload that changes no books) and names the
 *     tools no company permission governs (public documentation, the
 *     bridges, approval, creating a company).
 *   - A tool stages when its output is the staged-operation envelope
 *     (isStagingTool in ./server.ts); the caller passes that in, so this
 *     module stays free of the server.
 *
 * __tests__/permission-doors.test.ts fails on a tool in TOOL_SCOPE_MAP or
 * UNSCOPED_TOOLS with no door, on an override that names a generated or
 * missing tool, and on a hand-written tool whose permission differs from
 * the permission of a pending type it stages.
 */
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import {
  DOOR_SPECS as D,
  isOutsideDoor,
  operationDoor,
  OUTSIDE,
  scopeDoorSpec,
  type DoorRule,
  type DoorSpec,
  type OperationLike,
  type OutsideDoor,
} from '@/lib/permissions/doors'

/** Hand-written tools whose scope's default door is too coarse, or that no company permission governs. */
export const MCP_TOOL_DOORS: Readonly<Record<string, DoorSpec | OutsideDoor>> = Object.freeze({
  // Public documentation: no tenant data, no scope (public-tools.ts).
  gnubok_search_tools: OUTSIDE.public,
  gnubok_list_skills: OUTSIDE.public,
  gnubok_load_skill: OUTSIDE.public,
  // Bridges: the dispatcher decides the tool each one carries.
  gnubok_call_tool: OUTSIDE.bridge,
  gnubok_stage_tool: OUTSIDE.bridge,
  gnubok_run_across_companies: OUTSIDE.bridge,
  gnubok_stage_across_companies: OUTSIDE.bridge,
  // Approving and rejecting: decided per staged operation by its pending type.
  gnubok_approve_pending_operation: OUTSIDE.approval,
  gnubok_approve_from_view: OUTSIDE.approval,
  gnubok_reject_pending_operation: OUTSIDE.approval,
  // A new company, which the person will own: no membership exists yet.
  gnubok_create_company: OUTSIDE.newCompany,
  // Feedback to the product team: anyone who reads the books may send it.
  gnubok_feedback: D.READER_HOUSE,
  // Periods and bokslut.
  gnubok_close_period: D.PERIODS,
  gnubok_lock_period: D.PERIODS,
  gnubok_run_year_end: D.PERIODS,
  gnubok_post_kontantmetod_cutoff: D.PERIODS,
  // Registers written under a ledger scope.
  gnubok_create_asset: D.BOOK_RECORD,
  gnubok_update_asset: D.BOOK_RECORD,
  gnubok_delete_asset: D.BOOK_RECORD,
  gnubok_create_dimension_value: D.BOOK_RECORD,
  gnubok_create_supplier: D.BOOK_RECORD,
  gnubok_auto_match_period: D.BOOK_RECORD,
  gnubok_set_quote_status: D.INVOICING_RECORD,
  gnubok_create_sales_order: D.INVOICING_RECORD,
  gnubok_transition_sales_order: D.INVOICING_RECORD,
  gnubok_register_sales_order_delivery: D.INVOICING_RECORD,
  gnubok_create_employee: D.PAYROLL_RECORD,
  gnubok_update_employee: D.PAYROLL_RECORD,
  gnubok_register_absence: D.PAYROLL_RECORD,
  gnubok_delete_absence: D.PAYROLL_RECORD,
  gnubok_set_employee_opening_balances: D.PAYROLL_RECORD,
  gnubok_log_mileage_trip: D.PAYROLL_RECORD,
  // No books change: uploads, the bank feed, links between documents, a
  // run's recomputation from its inputs.
  gnubok_sync_bank: D.BOOK_HOUSE,
  gnubok_backfill_feed: D.BOOK_HOUSE,
  gnubok_create_document_upload: D.BOOK_HOUSE,
  gnubok_complete_document_upload: D.BOOK_HOUSE,
  gnubok_upload_document: D.BOOK_HOUSE,
  gnubok_set_inbox_extracted_data: D.BOOK_HOUSE,
  gnubok_link_document_to_voucher: D.BOOK_HOUSE,
  gnubok_link_documents_to_vouchers: D.BOOK_HOUSE,
  gnubok_calculate_salary_run: D.PAYROLL_HOUSE,
})

export interface McpToolLike {
  readonly name: string
  readonly annotations?: {
    readonly effect?: 'read_only' | 'additive' | 'destructive'
    readonly readOnlyHint?: boolean
  }
}

/**
 * A tool's door. `stageable` is isStagingTool(tool); `operation` is the
 * operation a generated tool comes from. Null: unclassified.
 */
export function mcpToolDoor(
  tool: McpToolLike,
  options: { stageable: boolean; operation?: OperationLike },
): DoorRule | null {
  if (options.operation) {
    const door = operationDoor(options.operation)
    return door ? { ...door, stageable: options.stageable } : null
  }
  const override = MCP_TOOL_DOORS[tool.name]
  if (override) return isOutsideDoor(override) ? override : { ...override, stageable: options.stageable }
  const scope = TOOL_SCOPE_MAP[tool.name]
  if (!scope) return null
  const found = scopeDoorSpec(scope, tool.annotations?.effect === 'read_only')
  return found ? { ...found, stageable: options.stageable } : null
}
