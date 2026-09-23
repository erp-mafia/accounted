import type { AgentTool } from './types'

// Process-singleton registry the chat agent reads from. Extensions register
// tools at module load (lib/init.ts → extensionRegistry.register → side-effect
// of mcp-server/index.ts calling registerAgentTools).
//
// Why a singleton: same lifetime story as the event bus and extension
// registry: there's exactly one chat loop per process, it must see the same
// tool set on every invocation, and tests can reset via clear().
class AgentToolRegistry {
  private tools = new Map<string, AgentTool>()

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  registerMany(tools: AgentTool[]): void {
    for (const t of tools) this.register(t)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  getMany(names: string[]): AgentTool[] {
    const out: AgentTool[] = []
    for (const n of names) {
      const t = this.tools.get(n)
      if (t) out.push(t)
    }
    return out
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values())
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  clear(): void {
    this.tools.clear()
  }

  size(): number {
    return this.tools.size
  }
}

export const agentToolRegistry = new AgentToolRegistry()

// Public registration entry point used by extensions. Stable name kept short
// so extension side-effect modules read clean.
export function registerAgentTools(tools: AgentTool[]): void {
  agentToolRegistry.registerMany(tools)
}
