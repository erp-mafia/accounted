import type { AgentTool } from './types'
import type { DoorRule } from '@/lib/permissions/doors'
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'

// Process-singleton registry the chat agent reads from. Extensions register a
// tool loader at module load (lib/init.ts → extensionRegistry.register →
// side-effect of mcp-server/index.ts calling registerAgentToolLoader). The
// first lookup waits for lib/init (lib/initialized.ts) and then runs the
// loaders, so a route that never asks for a tool loads no tool module.
//
// Why a singleton: same lifetime story as the event bus and extension
// registry: there's exactly one chat loop per process, it must see the same
// tool set on every invocation, and tests can reset via clear(). Kept on
// globalThis (lib/global-singleton.ts): lib/init registers the loaders through
// its own copy of this module.
export type AgentToolLoader = () => Promise<AgentTool[]>
/** The permission door a tool goes through (lib/permissions/doors.ts), as the extension that defines it classifies it. */
export type AgentToolDoorResolver = (tool: AgentTool) => DoorRule | null

class AgentToolRegistry {
  private tools = new Map<string, AgentTool>()
  private loaders = new Set<AgentToolLoader>()
  // Shared by concurrent lookups so the loaders run once. Cleared when the
  // load settles: on success the loaders are gone, on failure they stay and
  // the next lookup retries instead of replaying the cached rejection.
  private loading: Promise<void> | null = null
  private doorResolver: AgentToolDoorResolver | null = null

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

  registerDoorResolver(resolver: AgentToolDoorResolver): void {
    this.doorResolver = resolver
  }

  /** A tool's door, or null when no extension classified it (the permission shadow then skips it). */
  doorOf(tool: AgentTool): DoorRule | null {
    try {
      return this.doorResolver?.(tool) ?? null
    } catch {
      // Safe to ignore: a door only feeds the permission shadow, which skips
      // an unclassified tool; no tool call depends on it.
      return null
    }
  }

  clear(): void {
    this.tools.clear()
    this.loaders.clear()
    this.loading = null
    this.doorResolver = null
  }

  private async ensureLoaded(): Promise<void> {
    await whenInitialized()
    if (this.loaders.size === 0) return
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

export const agentToolRegistry = globalSingleton('agentToolRegistry', () => new AgentToolRegistry())

// Public registration entry point used by extensions: hand over a loader, not
// the tools, so the module that defines them loads only when a tool is needed.
export function registerAgentToolLoader(loader: AgentToolLoader): void {
  agentToolRegistry.registerLoader(loader)
}

// How the extension that defines the tools classifies their doors, for the
// permission shadow in the chat loop (lib/permissions/shadow.ts).
export function registerAgentToolDoorResolver(resolver: AgentToolDoorResolver): void {
  agentToolRegistry.registerDoorResolver(resolver)
}
