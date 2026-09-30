import { monthEndCloseSkill } from './month-end-close'
import { quarterlyVatReviewSkill } from './quarterly-vat-review'
import { yearEndCloseSkill } from './year-end-close'
import { invoicingRulesSkill } from './invoicing-rules'
import { payrollMonthlySkill } from './payroll-monthly'
import { bankReconciliationSkill } from './bank-reconciliation'
import { kreditfakturaProcessSkill } from './kreditfaktura-process'
import { customerOnboardingSkill } from './customer-onboarding'
import { reconcileMonthSkill } from './reconcile-month'
import { onboardingSkill } from './onboarding'
import { bookkeepSkill } from './bookkeep'
import { taxPlanningSkill } from './tax-planning'
import { createSkillSkill } from './create-skill'
import { analysisSkills } from '../analyses'
import type { Skill } from '../types'

export const workflowSkills: Skill[] = [
  bookkeepSkill, monthEndCloseSkill, quarterlyVatReviewSkill, yearEndCloseSkill,
  invoicingRulesSkill, payrollMonthlySkill, bankReconciliationSkill,
  kreditfakturaProcessSkill, customerOnboardingSkill, reconcileMonthSkill, onboardingSkill,
  taxPlanningSkill, createSkillSkill,
  // Accounted's own analyses (itemKind analysis): loadable like any skill, listed under Analyser.
  ...analysisSkills,
]
