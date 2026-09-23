import { AsyncLocalStorage } from 'node:async_hooks'

/** A work deadline is a deferral, never an authentication or provider failure. */
export class ExecutionBudgetExceeded extends Error {
  constructor(readonly stage: string) {
    super(`Execution budget exhausted during ${stage}`)
    this.name = 'ExecutionBudgetExceeded'
  }
}

interface ExecutionBudget {
  deadline: number
  stage: string
  signal: AbortSignal
}

// Clients are singletons. A request-local scope keeps concurrent invocations
// independent without putting mutable deadlines on those shared clients.
const budgets = new AsyncLocalStorage<ExecutionBudget>()

export function currentExecutionBudget(): ExecutionBudget | undefined {
  return budgets.getStore()
}

export function executionBudgetSignal(): AbortSignal | undefined {
  checkExecutionBudget()
  return budgets.getStore()?.signal
}

export function checkExecutionBudget(): void {
  const budget = budgets.getStore()
  if (budget && (budget.signal.aborted || Date.now() >= budget.deadline)) {
    throw new ExecutionBudgetExceeded(budget.stage)
  }
}

export async function withExecutionDeadline<T>(
  deadline: number,
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = budgets.getStore()
  const end = Math.min(deadline, parent?.deadline ?? Infinity)
  if (Date.now() >= end || parent?.signal.aborted) throw new ExecutionBudgetExceeded(stage)
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new ExecutionBudgetExceeded(stage)), end - Date.now())
  try {
    return await budgets.run({ deadline: end, signal, stage }, operation)
  } finally {
    clearTimeout(timer)
    controller.abort(new ExecutionBudgetExceeded(stage))
  }
}

/** Keep the signal attached while callers consume the response body too. */
export async function fetchInExecutionBudget(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  checkExecutionBudget()
  const budget = budgets.getStore()
  const signal = budget
    ? init?.signal ? AbortSignal.any([budget.signal, init.signal]) : budget.signal
    : init?.signal
  try {
    return await fetch(input, { ...init, ...(signal ? { signal } : {}) })
  } catch (error) {
    checkExecutionBudget()
    throw error
  }
}

/** PostgREST cancellation bounds the request; a cancelled write may have committed. */
export async function queryInExecutionBudget<T>(query: PromiseLike<T> & { abortSignal?: (signal: AbortSignal) => unknown }): Promise<T> {
  checkExecutionBudget()
  const budget = budgets.getStore()
  if (budget) query.abortSignal?.(budget.signal)
  try {
    const result = await query
    // PostgREST normally returns cancellation as { error }, not a rejection.
    checkExecutionBudget()
    if (budget && (result as { error?: { code?: string } } | null)?.error?.code === '57014') {
      throw new ExecutionBudgetExceeded(budget.stage)
    }
    return result
  } catch (error) {
    checkExecutionBudget()
    throw error
  }
}

/** Do not start a delay that cannot fit; cancellation also removes its timer. */
export async function waitInExecutionBudget(ms: number): Promise<void> {
  checkExecutionBudget()
  const budget = budgets.getStore()
  if (budget && ms >= budget.deadline - Date.now()) throw new ExecutionBudgetExceeded(budget.stage)
  await new Promise<void>((resolve, reject) => {
    const finish = () => { budget?.signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.max(0, ms))
    const abort = () => {
      clearTimeout(timer)
      budget?.signal.removeEventListener('abort', abort)
      reject(new ExecutionBudgetExceeded(budget!.stage))
    }
    budget?.signal.addEventListener('abort', abort, { once: true })
  })
  checkExecutionBudget()
}

/** Only for queued work that checks the budget before it eventually starts. */
export async function waitForExecutionTurn<T>(turn: Promise<T>): Promise<T> {
  const budget = budgets.getStore()
  if (!budget) return turn
  checkExecutionBudget()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ExecutionBudgetExceeded(budget.stage))
    budget.signal.addEventListener('abort', abort, { once: true })
    turn.then(resolve, reject).finally(() => budget.signal.removeEventListener('abort', abort))
  })
}
