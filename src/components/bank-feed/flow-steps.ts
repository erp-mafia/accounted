/**
 * The screens of Koppla banken and how they count. One list per mode: a
 * switch from Enable Banking opens with what changes, a new connection and a
 * renewal start at the bank. Betalningar (the payments verification) is an
 * offer, present only when payments are available to the company and not
 * yet verified, so the "Steg n av N" line counts it only then.
 */

import { BANK_CONNECT_SIGNATORY_TARGET, type BankConnectReturnTarget } from '@/lib/bank-feed/return-url'

export type FlowMode = 'new' | 'switch' | 'renew' | 'resume'

export type FlowStep = 'intro' | 'bank' | 'bankid' | 'accounts' | 'payments' | 'done'

const ALL_STEPS: FlowStep[] = ['intro', 'bank', 'bankid', 'accounts', 'payments', 'done']

/** The steps a mode walks through, in order. `paymentsOffered` null means not known yet (counted as offered until the answer lands). */
export function stepsFor(mode: FlowMode, paymentsOffered: boolean | null): FlowStep[] {
  return ALL_STEPS.filter((step) => {
    if (step === 'intro') return mode === 'switch'
    if (step === 'payments') return paymentsOffered !== false
    return true
  })
}

/** The first step a mode opens on. A resumed connection (second signer) goes straight to the bank's BankID. */
export function firstStep(mode: FlowMode): FlowStep {
  if (mode === 'switch') return 'intro'
  if (mode === 'resume') return 'bankid'
  return 'bank'
}

/**
 * "Steg n av N" for a step. Klart is the last counted step (5 of 5 with the
 * payments offer, 4 of 4 without) but shows no indicator of its own; the
 * intro is step 0 and counts nothing. Null for both.
 */
export function stepPosition(step: FlowStep, mode: FlowMode, paymentsOffered: boolean | null): { n: number; total: number } | null {
  if (step === 'intro' || step === 'done') return null
  const counted = stepsFor(mode, paymentsOffered).filter((s) => s !== 'intro')
  const index = counted.indexOf(step)
  if (index < 0) return null
  return { n: index + 1, total: counted.length }
}

/** The step after `step` in this mode, or null at the end. */
export function nextStep(step: FlowStep, mode: FlowMode, paymentsOffered: boolean | null): FlowStep | null {
  const steps = stepsFor(mode, paymentsOffered)
  const index = steps.indexOf(step)
  return index >= 0 && index + 1 < steps.length ? steps[index + 1] : null
}

export type DismissPolicy = 'free' | 'confirm'

/**
 * Whether Esc and a click outside close the dialog at once. The intro, the
 * bank list and the finished screen have nothing in flight. A BankID that is
 * running or a selection being activated asks first: closing there leaves a
 * half-made connection behind. A BankID the bank has refused (`consentRefused`)
 * has nothing running to interrupt, so it closes at once; its half-made
 * connection still goes (connect-flow-reducer.ts closeOutcome). The payments
 * offer closes freely: the connection is already live and the verification
 * can be done from the settings later.
 */
export function dismissPolicy(step: FlowStep, consentRefused = false): DismissPolicy {
  if (step === 'bankid') return consentRefused ? 'free' : 'confirm'
  return step === 'accounts' ? 'confirm' : 'free'
}

/**
 * Whether a refused BankID points on to bank file import from this entry
 * point. Onboarding does not: its own way on without a bank waits right
 * behind the dialog, and a link out would leave the journey. The signatory
 * page does not: its reader has no login to import with.
 */
export function offersFileImport(entryPoint: BankConnectReturnTarget | null): boolean {
  return entryPoint !== 'onboarding' && entryPoint !== BANK_CONNECT_SIGNATORY_TARGET
}
