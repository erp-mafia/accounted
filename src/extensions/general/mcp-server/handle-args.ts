/**
 * Typed handles in MCP tool arguments (lib/handles has the format): a
 * `je_...`/`inv_...` handle an agent got from the REST API is read as the
 * plain UUID every tool expects, once, at the dispatcher, before the company
 * is resolved and the tool runs. A handle of the wrong type for its argument
 * is refused with HANDLE_TYPE_MISMATCH. Arguments without handles come back
 * as the same object. Tool output is unchanged: tools still answer UUIDs.
 */
import { normalizeHandleFields, type FieldTypeOverrides } from '@/lib/handles'
import { codedRefusal } from '@/lib/errors/refusal'

/**
 * Where MCP names a field differently from the REST API: the approve and
 * reject tools take a pending operation as `operation_id` (on REST that name
 * is an async operation, which takes no handle in a body).
 */
export const MCP_HANDLE_FIELD_OVERRIDES: FieldTypeOverrides = Object.freeze({
  operation_id: 'pending_operation',
})

/** The arguments with handles replaced by UUIDs; throws HANDLE_TYPE_MISMATCH on a wrong-type handle. */
export function normalizeToolArgHandles(args: Record<string, unknown>): Record<string, unknown> {
  const result = normalizeHandleFields(args, MCP_HANDLE_FIELD_OVERRIDES)
  if (result.ok) return result.value
  throw codedRefusal('HANDLE_TYPE_MISMATCH', result.mismatches.map((m) => m.message).join(' '))
}
