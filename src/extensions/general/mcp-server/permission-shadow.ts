/**
 * The MCP door's half of the permission shadow (src/lib/permissions/
 * shadow.ts): one recorder per tool call, told what the dispatcher's checks
 * did, so decide() can be compared with it. It reads nothing and changes
 * nothing; the dispatcher's own checks decide. A missing scope is not
 * compared: scope checks stay at the wire and decide() runs behind them.
 *
 *   gate           assertMcpCompanyWriteAccess's verdict in the company the
 *                  call resolved to (a refusal, or the pass the outcome
 *                  below completes)
 *   settled        the tool ran: it staged (a staging tool) or acted
 *   failed         the tool threw: a 403-coded refusal is the handler's own
 *                  check, anything else means the checks let it through
 *
 * Approvals (gnubok_approve_pending_operation, the batch approve) are an
 * outside door: decided per staged operation at the commit seam, not here.
 */
import { agentShadow, todayFromToolFailure, type AgentShadowTarget } from '@/lib/permissions/shadow'
import type { DoorRule } from '@/lib/permissions/doors'
import type { McpCompanyContext, McpWriteRefusal } from './company-routing'

export interface McpShadowCaller {
  userId: string
  keyScopes: readonly string[]
  oauthKey: boolean
  serviceAccountId: string | null
  apiKeyId: string | null
  agentIdentityId: string | null
}

export interface McpCallShadow {
  /** The observer to hand assertMcpCompanyWriteAccess for this company. */
  gate(context: McpCompanyContext): (refusal: McpWriteRefusal | null) => void
  settled(dryRun: boolean): void
  failed(err: unknown): void
}

export function mcpCallShadow(
  caller: McpShadowCaller,
  toolName: string,
  /** The tool's door, resolved only when the shadow compares. */
  door: () => DoorRule | null | undefined,
  staging: boolean,
): McpCallShadow {
  const record = agentShadow({
    door: `mcp:${toolName}`,
    method: null,
    userId: caller.userId,
    key: {
      kind: caller.serviceAccountId ? 'service_account' : caller.oauthKey ? 'oauth' : 'manual',
      scopes: caller.keyScopes,
      apiKeyId: caller.apiKeyId,
      agentIdentityId: caller.agentIdentityId,
    },
    doorRule: door,
  })
  let target: AgentShadowTarget | null = null

  return {
    gate(context) {
      return (refusal) => {
        target = { companyId: context.companyId, role: context.role, companyAccess: context.keyAccess }
        if (refusal) {
          record({ outcome: 'deny', code: refusal, by: 'gate' }, target)
          target = null
        }
      }
    },
    settled(dryRun) {
      if (target) record({ outcome: staging ? 'stage' : 'allow', dryRun }, target)
      target = null
    },
    failed(err) {
      if (target) record(todayFromToolFailure(err, staging), target)
      target = null
    },
  }
}
