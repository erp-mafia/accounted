## Verification

This skill is generated (`npm run apiskill:generate` in the Accounted repo)
from the same endpoint registry that serves the live API, its OpenAPI spec
(`https://app.gnubok.se/api/v1/openapi.json`), and its runtime request
validators, so schema drift between this text and the server cannot occur for
a matching `api_version`. CI regenerates and diffs it on every change.

Before first use in a new environment, smoke-test:

```bash
curl -s https://app.gnubok.se/api/v1/health
curl -s https://app.gnubok.se/api/v1/companies -H "Authorization: Bearer $ACCOUNTED_API_KEY"
```

If `meta.api_version` in responses is newer than the version in this skill's
index header, refetch the skill (or read the changelog at
https://app.gnubok.se/docs/api/changelog) before relying on endpoint details.
