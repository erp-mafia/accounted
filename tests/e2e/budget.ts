import { performance } from 'node:perf_hooks'

export const BUDGET = { startup: 5000, navigation: 3000, interaction: 1000 } as const

/** One deadline covers the action and its meaningful ready state together. */
export async function withinBudget<T>(name: string, milliseconds: number, action: () => Promise<T>): Promise<{ value: T; elapsed: number }> {
  const start = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} exceeded ${milliseconds} ms`)), milliseconds)
  })
  try {
    const value = await Promise.race([action(), timeout])
    const elapsed = performance.now() - start
    // Also catch a synchronously blocked event loop whose timer has not fired.
    if (elapsed > milliseconds) throw new Error(`${name} took ${Math.round(elapsed)} ms, budget ${milliseconds} ms`)
    return { value, elapsed }
  } finally {
    clearTimeout(timer)
  }
}
