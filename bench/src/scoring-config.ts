// Frozen scoring parameters, in their own module so that tools which need the
// constants (the freeze tripwire, tests) do not import aggregate.ts, whose
// top-level main() runs a full aggregation and rewrites leaderboard.json.

// The automation gate: a per-model confidence threshold fitted OUT OF SAMPLE
// to this precision target, across this many deterministic folds. See
// crossFittedGate in aggregate.ts for why in-sample fitting is not used.
export const GATE_TARGET = 0.95
export const GATE_FOLDS = 2

// A single pre-registered threshold, kept as a secondary figure. Chosen once,
// without reference to which model it favours, so it cannot be tuned.
export const FIXED_GATE_THRESHOLD = 0.9
