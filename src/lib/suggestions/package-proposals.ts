/**
 * Package switches as suggestion proposals: the plain Swedish question, the
 * params the executor runs (lib/pending-operations/commit.ts, enable_package
 * and disable_package) and what the approver's preview shows.
 */
import { getPackage, type PackageId } from '@/lib/modules/packages'
import type { SwitchablePackageId } from '@/lib/modules/profiles'
import type { DetectorContext, SuggestionProposal } from './types'

/** Higher first: the order the open suggestions are shown in (at most three). */
export const SUGGESTION_RANKS = {
  /** Lön for a company that has registered an employee: payroll is a legal obligation. */
  enablePayroll: 30,
  /** Kassa och webbshop for a company that has connected one. */
  enableSalesChannels: 20,
  /** Hiding an unused package only tidies the menu. */
  hideUnused: 10,
} as const

/** The dedupe key of a package switch: one open suggestion per company, direction and package. */
export function packageSuggestionKey(operation: 'enable_package' | 'disable_package', packageId: PackageId): string {
  return `${operation}:${packageId}`
}

export function enablePackageProposal(
  packageId: SwitchablePackageId,
  opts: { reason: string; rank: number },
): SuggestionProposal {
  const name = getPackage(packageId).nameSv
  return {
    key: packageSuggestionKey('enable_package', packageId),
    operationType: 'enable_package',
    params: { package_id: packageId, source: 'suggestion' },
    title: `Slå på ${name}?`,
    reason: opts.reason,
    rank: opts.rank,
    preview: { package: name, change: 'Slå på' },
  }
}

export function disablePackageProposal(
  packageId: SwitchablePackageId,
  opts: { reason: string; rank: number },
): SuggestionProposal {
  const name = getPackage(packageId).nameSv
  return {
    key: packageSuggestionKey('disable_package', packageId),
    operationType: 'disable_package',
    params: { package_id: packageId, source: 'suggestion' },
    title: `Dölj ${name}?`,
    reason: opts.reason,
    rank: opts.rank,
    preview: { package: name, change: 'Dölj' },
  }
}

/**
 * Whether a package is switched off for the company right now: by its
 * profile or by its own choice. A package outside the plan or the country is
 * not "off" in this sense, and an unreadable company is not either: a
 * suggestion is never made on a guess.
 */
export async function packageIsOff(ctx: DetectorContext, packageId: PackageId): Promise<boolean> {
  const capabilities = await ctx.capabilities()
  return capabilities?.packages.find((p) => p.id === packageId)?.availability === 'off'
}
