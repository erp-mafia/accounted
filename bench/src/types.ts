// Shared types for the Accounted Ledger-Bench harness.
//
// Design rule: every task is a coupled artifact (prompt inputs, gold labels,
// scoring config) and every run record is append-only JSONL so results can be
// re-aggregated without re-running models.

export type SuiteId = 'booking' | 'reasoning' | 'extraction' | 'ledger-agent'

// Where the task data came from. 'public' tasks are synthetic, committed to
// the repo, and may be sent to any inference provider. 'prod-derived' tasks
// contain real customer data: they are NEVER committed and the runner refuses
// to send them to any provider whose residency is not 'eu-bedrock'.
export type DataClass = 'public' | 'prod-derived'

export type Difficulty = 'core' | 'hard' | 'expert'

export interface TaskBase {
  id: string
  suite: SuiteId
  data_class: DataClass
  difficulty: Difficulty
  // One-line human description of what the task probes.
  probe: string
  // Why the gold answer is what it is, with a legal reference where relevant.
  rationale: string
  law_ref?: string
}

// ---------------------------------------------------------------------------
// Booking suite: pick the BAS account + VAT treatment for a bank transaction.
// ---------------------------------------------------------------------------

export type VatTreatment =
  | 'domestic_25'
  | 'domestic_12'
  | 'domestic_6'
  | 'no_vat'
  | 'reverse_charge_services'
  | 'reverse_charge_goods'
  | 'reverse_charge_construction'
  | 'import'
  | 'representation_capped'
  | 'domestic_25_half_deduction'

export const VAT_TREATMENTS: VatTreatment[] = [
  'domestic_25',
  'domestic_12',
  'domestic_6',
  'no_vat',
  'reverse_charge_services',
  'reverse_charge_goods',
  'reverse_charge_construction',
  'import',
  'representation_capped',
  'domestic_25_half_deduction',
]

export interface BookingTask extends TaskBase {
  suite: 'booking'
  input: {
    company: {
      entity_type: 'aktiebolag' | 'enskild_firma'
      vat_registered: boolean
      accounting_method: 'invoice' | 'cash'
      business: string
    }
    transaction: {
      date: string
      // Signed: negative = money out.
      amount: number
      currency: 'SEK'
      counterpart: string
      description: string
      // Extra evidence, e.g. text visible on the underlying invoice.
      underlag?: string
    }
  }
  gold: {
    account: string
    // Alternative accounts a Swedish accountant would also accept.
    acceptable_accounts?: string[]
    vat_treatment: VatTreatment
  }
}

// ---------------------------------------------------------------------------
// Reasoning suite: Swedish VAT / bookkeeping-law questions with one
// deterministic answer.
// ---------------------------------------------------------------------------

export type ReasoningAnswer =
  | { type: 'number'; value: number; tolerance?: number }
  | { type: 'string'; value: string; acceptable?: string[] }
  | { type: 'choice'; options: string[]; value: string }

export interface ReasoningTask extends TaskBase {
  suite: 'reasoning'
  input: { question: string }
  gold: ReasoningAnswer
}

// ---------------------------------------------------------------------------
// Extraction suite: structured fields out of a rendered document.
// ---------------------------------------------------------------------------

export interface ExtractionGold {
  documentKind?: string
  supplierName?: string
  orgNumber?: string | null
  vatNumber?: string | null
  bankgiro?: string | null
  plusgiro?: string | null
  invoiceNumber?: string | null
  invoiceDate?: string | null
  dueDate?: string | null
  paymentReference?: string | null
  currency?: string
  subtotal?: number | null
  vatAmount?: number | null
  total?: number | null
  roundingAmount?: number | null
  servicePeriodStart?: string | null
  servicePeriodEnd?: string | null
  vatBreakdown?: { rate: number; base: number; amount: number }[]
}

export interface ExtractionTask extends TaskBase {
  suite: 'extraction'
  input: {
    // Path relative to bench/tasks/extraction/documents/
    document: string
  }
  gold: ExtractionGold
}

// ---------------------------------------------------------------------------
// Ledger-agent suite: multi-turn tool use against a real seeded Postgres.
// ---------------------------------------------------------------------------

export interface LedgerAgentTask extends TaskBase {
  suite: 'ledger-agent'
  input: {
    // The user-style instruction handed to the agent.
    instruction: string
    // Named seed program executed by the environment before the trial.
    seed: string
    max_turns: number
  }
  // Named assertion program evaluated against the database after the trial.
  gold: { assertions: string }
}

export type Task = BookingTask | ReasoningTask | ExtractionTask | LedgerAgentTask

// ---------------------------------------------------------------------------
// Run records.
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number
  outputTokens: number
  // Cost in USD. Computed from the registry price table, or taken from the
  // provider when it reports spend directly (OpenRouter).
  costUsd: number
}

export interface RunRecord {
  benchVersion: string
  suite: SuiteId
  taskId: string
  model: string
  provider: string
  startedAt: string
  durationMs: number
  turns: number
  usage: Usage
  // Suite-specific score payload; `pass` is the headline binary.
  pass: boolean
  score: Record<string, unknown>
  // Raw parsed model answer, for audits.
  answer?: unknown
  error?: string
}
