// pending_operations.operation_type stores the bare action name
// ('categorize_transaction'), while the MCP tool surface and the live chat
// stream carry the prefixed tool name ('gnubok_categorize_transaction').
// These two functions are the single translation point between the two
// vocabularies: every surface that needs to cross over imports from here
// instead of hand-rolling a prefix. The 'gnubok_' wire prefix is deliberate
// and must stay (rebrand rule: wire-format identifiers keep the old name).

const TOOL_NAME_PREFIX = 'gnubok_'

/**
 * MCP tool name -> bare operation_type. A name without the prefix is already
 * a bare operation_type (or a non-gnubok tool) and passes through unchanged.
 */
export function operationTypeFromToolName(toolName: string): string {
  return toolName.startsWith(TOOL_NAME_PREFIX)
    ? toolName.slice(TOOL_NAME_PREFIX.length)
    : toolName
}

/**
 * Bare operation_type -> MCP tool name. Defensive on already-prefixed input
 * so a value that was a tool name all along is never double-prefixed.
 */
export function toolNameForOperationType(operationType: string): string {
  return operationType.startsWith(TOOL_NAME_PREFIX)
    ? operationType
    : `${TOOL_NAME_PREFIX}${operationType}`
}
