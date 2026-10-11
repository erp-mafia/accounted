import type { AgentTool } from './types'

// Process-singleton registry the chat agent reads from. Extensions register a
// tool loader at module load (lib/init.ts → extensionRegistry.register →
// side-effect of mcp-server/index.ts calling registerAgentToolLoader). The
// loader runs on the first lookup, so a route that never asks for a tool
// never loads the module graph behind it.
//
// Why a singleton: same lifetime story as the event bus and extension
// registry: there's exactly one chat loop per process, it must see the same
// tool set on every invocation, and tests can reset via clear().
export type AgentToolLoader = () => Promise<AgentTool[]>

class AgentToolRegistry {
  private tools = new Map<string, AgentTool>()
  private loaders = new Set<AgentToolLoader>()
  // Shared by concurrent lookups so the loaders run once. Cleared when the
  // load settles: on success the loaders are gone, on failure they stay and
  // the next lookup retries instead of replaying the cached rejection.
  private loading: Promise<void> | null = null

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  registerMany(tools: AgentTool[]): void {
    for (const t of tools) this.register(t)
  }

  registerLoader(loader: AgentToolLoader): void {
    this.loaders.add(loader)
  }

  async get(name: string): Promise<AgentTool | undefined> {
    await this.ensureLoaded()
    return this.tools.get(name)
  }

  async getMany(names: string[]): Promise<AgentTool[]> {
    await this.ensureLoaded()
    const out: AgentTool[] = []
    for (const n of names) {
      const t = this.tools.get(n)
      if (t) out.push(t)
    }
    return out
  }

  clear(): void {
    this.tools.clear()
    this.loaders.clear()
    this.loading = null
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaders.size === 0) return Promise.resolve()
    this.loading ??= this.runLoaders().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async runLoaders(): Promise<void> {
    const batch = [...this.loaders]
    const results = await Promise.all(batch.map((load) => load()))
    results.forEach((tools, i) => {
      this.registerMany(tools)
      this.loaders.delete(batch[i])
    })
  }
}

export const agentToolRegistry = new AgentToolRegistry()

// Public registration entry point used by extensions: hand over a loader, not
// the tools, so the module that defines them loads only when a tool is needed.
export function registerAgentToolLoader(loader: AgentToolLoader): void {
  agentToolRegistry.registerLoader(loader)
}
