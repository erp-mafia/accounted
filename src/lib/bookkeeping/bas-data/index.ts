import { CLASS_1_ACCOUNTS } from './class-1-assets'
import { CLASS_2_ACCOUNTS } from './class-2-equity-liabilities'
import { CLASS_3_ACCOUNTS } from './class-3-revenue'
import { CLASS_4_ACCOUNTS } from './class-4-purchases'
import { CLASS_5_ACCOUNTS } from './class-5-external-expenses'
import { CLASS_6_ACCOUNTS } from './class-6-other-external'
import { CLASS_7_ACCOUNTS } from './class-7-personnel'
import { CLASS_8_ACCOUNTS } from './class-8-financial'

import type { BASReferenceAccount } from '../bas-reference'

export const BAS_REFERENCE: BASReferenceAccount[] = [
  ...CLASS_1_ACCOUNTS,
  ...CLASS_2_ACCOUNTS,
  ...CLASS_3_ACCOUNTS,
  ...CLASS_4_ACCOUNTS,
  ...CLASS_5_ACCOUNTS,
  ...CLASS_6_ACCOUNTS,
  ...CLASS_7_ACCOUNTS,
  ...CLASS_8_ACCOUNTS,
]
