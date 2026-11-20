/**
 * "Slå på Lön?": an employee is registered while the company has Lön
 * switched off.
 *
 * Wakes on employee.created (lib/salary/employee-commands.ts, every door).
 * With Lön off nothing else in the product registers employees, so in
 * practice this is the company's first one. Lön is off only where a profile
 * or the company left it off, which today means a byrå-profiled company:
 * every company without a stored profile has Standard (allt på), so it sees
 * nothing new.
 */
import { enablePackageProposal, packageIsOff, SUGGESTION_RANKS } from '../package-proposals'
import type { Detector } from '../types'

interface Subject {
  packageId: 'payroll'
}

export const firstEmployeeDetector: Detector<Subject> = {
  id: 'first-employee',
  trigger: { kind: 'event', eventTypes: ['employee.created'] },
  subjects: (_ctx, event) => (event?.type === 'employee.created' ? [{ packageId: 'payroll' }] : []),
  condition: (ctx, subject) => packageIsOff(ctx, subject.packageId),
  propose: (subject) =>
    enablePackageProposal(subject.packageId, {
      reason:
        'Du har registrerat en anställd. Med Lön gör du lönekörningar och arbetsgivardeklarationer och betalar ut lönen från banken.',
      rank: SUGGESTION_RANKS.enablePayroll,
    }),
}
