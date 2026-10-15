[2026-10-15] A v1 dry run only looks its Idempotency-Key up and never claims it: it writes nothing, and a claim held by a preview would answer the commit that follows with key reuse.
