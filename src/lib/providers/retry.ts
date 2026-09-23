import { checkExecutionBudget, ExecutionBudgetExceeded, waitInExecutionBudget } from '@/lib/http/execution-budget';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Return a custom delay in ms for this error, or undefined to use default backoff. */
  getDelayMs?: (error: unknown, attempt: number) => number | undefined;
}

const DEFAULT_OPTIONS = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    checkExecutionBudget();
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ExecutionBudgetExceeded) throw error;
      checkExecutionBudget();
      lastError = error;

      if (attempt === opts.maxAttempts) break;

      if (options?.shouldRetry && !options.shouldRetry(error, attempt)) {
        break;
      }

      const customDelay = options?.getDelayMs?.(error, attempt);
      const delay = customDelay ?? Math.min(
        opts.initialDelayMs * opts.backoffMultiplier ** (attempt - 1),
        opts.maxDelayMs,
      );

      await waitInExecutionBudget(delay);
    }
  }

  throw lastError;
}
