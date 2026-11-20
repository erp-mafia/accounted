/**
 * The company is built through the doors a customer's agent uses: the MCP tools,
 * called as the server calls them. A staged write is approved at once, as a
 * person would approve it, so a refusal anywhere in the chain stops the build
 * with the tool's own sentence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { tools } from '@/extensions/general/mcp-server/server'

export type Args = Record<string, unknown>
// Tool answers are JSON whose shape the build reads field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Answer = Record<string, any>

const byName = new Map(tools.map((tool) => [tool.name, tool]))

export class SimDoors {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly companyId: string,
    private readonly userId: string,
  ) {}

  /** A read, or a write that commits on the call. */
  async call(name: string, args: Args = {}): Promise<Answer> {
    const tool = byName.get(name)
    if (!tool) throw new Error(`no MCP tool named ${name}`)
    const answer = await tool.execute(
      { __keyScopes: [], ...args } as never,
      this.companyId,
      this.userId,
      this.supabase as never,
      { type: 'api_key' } as never,
    )
    return answer as Answer
  }

  /** A staged write, approved: answers what the commit answered. */
  async write(name: string, args: Args = {}): Promise<Answer> {
    const staged = await this.call(name, args)
    if (typeof staged.operation_id !== 'string') {
      throw new Error(`${name} staged nothing: ${JSON.stringify(staged).slice(0, 500)}`)
    }
    return this.approve(name, staged.operation_id)
  }

  async approve(name: string, operationId: string): Promise<Answer> {
    const answer = await this.call('gnubok_approve_pending_operation', { operation_id: operationId, confirmed: true })
    if (answer.status !== 'committed') {
      throw new Error(`${name} was not committed: ${JSON.stringify(answer).slice(0, 800)}`)
    }
    return (answer.data ?? {}) as Answer
  }
}
