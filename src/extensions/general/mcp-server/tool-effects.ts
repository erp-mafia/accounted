export type McpToolEffect = 'read_only' | 'additive' | 'destructive'

export interface McpToolEffectAnnotations {
  effect: McpToolEffect
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export function annotationsForEffect(
  effect: McpToolEffect,
  hints: Pick<McpToolEffectAnnotations, 'idempotentHint' | 'openWorldHint'> = {},
): McpToolEffectAnnotations {
  return {
    effect,
    readOnlyHint: effect === 'read_only',
    destructiveHint: effect === 'destructive',
    ...hints,
  }
}

export function withToolEffect<T extends McpToolEffectAnnotations>(
  annotations: T,
  effect: McpToolEffect,
): T {
  return {
    ...annotations,
    ...annotationsForEffect(effect, {
      idempotentHint: annotations.idempotentHint,
      openWorldHint: annotations.openWorldHint,
    }),
  }
}

/**
 * The annotations a client sees in tools/list and gnubok_search_tools. `effect`
 * is the server's own classification, not an MCP annotation, so it stays on the
 * server: the spec's hints already carry it, and every listed byte counts
 * against the tools/list budget.
 */
export function publicToolAnnotations<T extends { effect?: McpToolEffect }>(
  annotations: T,
): Omit<T, 'effect'> {
  const { effect: _effect, ...hints } = annotations
  return hints
}

export function isReadOnlyTool(tool: { annotations: { effect: McpToolEffect } }): boolean {
  return tool.annotations.effect === 'read_only'
}
