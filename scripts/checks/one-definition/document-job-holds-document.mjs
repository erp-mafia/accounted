// The SQL repeats this rule: document_backfill_candidates (newest in
// supabase/migrations/20261126000300_document_backfill_candidates_index_only.sql) and
// document_retry_candidates (supabase/migrations/20261112152731_document_read_candidates_skip_open_jobs.sql) pick the read
// backfill's rows in the database, where a TypeScript function cannot reach, and this guard does
// not scan SQL. That copy is acceptable because it is the only other one, both name each other,
// and tests/pg/document-backfill-candidates.pg.test.ts pins it on the same cases that
// src/lib/documents/classify/__tests__/classify-backfill.test.ts pins this home on.
export default {
  rule: 'document-job-holds-document',
  says: "A backfill leaves a document's step to the job queue while the queue will still run it: the job is running, or queued or failed with attempts left, and the queue has acted on it within the hour.",
  home: 'src/lib/documents/jobs/hold.ts: queueHoldsDocument, jobHasAttemptsLeft',
  why: 'The classify and read backfills each wrote by hand which jobs held a document: neither held a failed job the worker would still retry, so a backfill and the worker read and typed the same document twice, and nothing ended a hold when the worker stopped.',
  match: [
    // A job with attempts left, written out.
    /\.attempts < \w+\.max_attempts/,
    // Queued or running, written out as a hold.
    /status === 'queued' \|\| \w+\.status === 'running'/,
  ],
  sanctioned: ['lib/documents/jobs/hold.ts'],
  allowed: {
    'app/api/documents/[id]/pipeline/route.ts': 'the upload view shows a failed step with attempts left as queued, as the worker sees it: a description of the job, not a hold, and with no hour bound.',
    'lib/documents/classify/stale.ts': 'the stale-verdict requeue decides whether to queue a classify job, not whether a backfill may do one: a failed job holds there until someone looks, so a document the model cannot type never costs a call every run.',
  },
}
