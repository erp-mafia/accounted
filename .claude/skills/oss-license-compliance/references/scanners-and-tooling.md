# Scanners and Tooling: ScanCode, ORT, SCANOSS, FossID

Building a scanner from scratch is the wrong default. Mature OSS scanners have invested years in license matching corpora, regression test suites, and ecosystem-specific package manager integration. The skill author's job is orchestration, policy, and reporting, not reimplementing matching.

## ScanCode Toolkit

Reference implementation for license, copyright, and dependency metadata extraction. Maintained by AboutCode (Nexus B) under Apache 2.0.

### Why it is the baseline

* Full license-text diff matching, not approximate string matching. Detects licenses even when copyright placeholders, formatting, or whitespace differ.
* Tested with 30,000+ regression cases against the real-world distribution of license-text variants.
* Wide ecosystem coverage: Maven, npm, PyPI, Go modules, RubyGems, Cargo, Composer, NuGet, package-lock files, OS package metadata, archive contents.
* Outputs structured JSON suitable for downstream programmatic policy evaluation.

### Container-based CI integration

The official Docker image (`ghcr.io/aboutcode-org/scancode.io:latest`) is the most reliable invocation path; it pins the matcher version and avoids host Python environment drift.

```bash
docker run --rm \
  -v "$(pwd)":/codedrop \
  ghcr.io/aboutcode-org/scancode.io:latest \
  run scan_codebase /codedrop \
  > scancode_results.json
```

Cache the Docker layer in CI (`actions/cache`, GitLab `cache:`, etc.): the image is large and uncached pulls add minutes per run.

### Output structure

ScanCode JSON contains `files[]` with per-file `licenses[]`, `copyrights[]`, and `package_data[]`. The downstream scanner consumes this as input: it should not re-derive license findings from raw source.

For SBOM generation, prefer `scancode-toolkit`'s `--spdx-tv` or `--spdx-rdf` outputs for SPDX, or chain through `cyclonedx-cli` for CycloneDX.

## OSS Review Toolkit (ORT)

ORT is the orchestration layer the skill should build on. It composes multiple scanners (ScanCode, Fossology, others) and adds policy evaluation, reporting, and SBOM generation.

### Pipeline architecture

ORT decomposes the workflow into discrete tools, each consuming the previous tool's JSON output:

1. **Analyzer**: resolves dependency trees from package manifests. Ecosystem-aware (Maven, npm, Cargo, etc.). Produces an `analyzer-result.json`.
2. **Scanner**: fetches sources and runs configured per-package scanners (ScanCode, Fossology). Produces `scan-result.yml`.
3. **Advisor** (optional): queries security advisory databases for known vulnerabilities.
4. **Evaluator**: applies user-defined policy rules in Kotlin script (`rules.kts`) against the combined analyzer + scanner data.
5. **Reporter**: produces SBOMs (SPDX, CycloneDX), notice files, HTML reports, and developer-friendly summaries.

This decomposition lets the CI pipeline cache intermediate outputs, rerun only the policy layer when `rules.kts` changes, and ship the same reports to multiple downstream audiences.

### `.ort.yml` repository configuration

Per-repository configuration sits in `.ort.yml` at the repository root. Key sections:

* **`excludes.paths`**: path globs to exclude from analysis (vendored examples, generated code). Each exclude has a `reason` field; never silently exclude.
* **`excludes.scopes`**: exclude scopes like `test`, `devDependencies`. Use carefully; license obligations may apply to artifacts produced from devDependency tooling.
* **`curations`**: corrections to upstream metadata (a known-bad declared license overridden with the actual license).
* **`license_choices`**: for dual-licensed dependencies, record the choice made (e.g., for `MIT OR Apache-2.0`, the project chose `Apache-2.0`).
* **`resolutions`**: triaged decisions on findings the scanner produced; mark a snippet match as "false positive, boilerplate" with reason.

`.ort.yml` is the durable artifact of compliance triage. Treat it as code: review changes, require justification, never delete entries silently.

### `rules.kts` policy

ORT evaluates compliance via Kotlin script. Skill authors should ship a baseline `rules.kts` covering:

* Banned licenses (deny list, e.g., AGPL in proprietary distribution context).
* Required license choices (every dual-licensed dep must have a `license_choices` entry).
* Required attribution (every Apache 2.0 dep must have a NOTICE entry).
* Allowed license combinations against outbound license.
* Severity grading: `ERROR` blocks merge, `WARNING` produces PR comment.

Kotlin script is more powerful than YAML rules for this purpose: it can compose conditions, traverse the dependency graph, and emit structured violation objects. Resist the urge to reinvent it in a less expressive language.

### CLI invocation

```bash
ort analyze -i . -o ort/analyzer
ort scan -i ort/analyzer/analyzer-result.yml -o ort/scanner
ort evaluate \
  -i ort/scanner/scan-result.yml \
  --rules-file rules.kts \
  --license-classifications-file license-classifications.yml \
  --package-curations-file curations.yml \
  -o ort/evaluator
ort report \
  -i ort/evaluator/evaluation-result.yml \
  -f WebApp,SpdxDocument,CycloneDx,NoticeTemplate \
  -o ort/reporter
```

Pipeline steps cache cleanly: re-evaluating policy on a stable scan result is seconds; re-scanning is minutes.

## Snippet detection: SCANOSS, FossID

Manifest scanning misses copy-pasted code. Snippet detection compares source fingerprints against a corpus of known OSS files.

### SCANOSS

Open-source SCA engine with snippet matching. Fingerprint database covers hundreds of millions of files.

* Detection threshold: configurable, typically 6-line minimum match window.
* Resilient to reformatting, variable renaming, comment changes; sensitive to logic alteration.
* Correlates fingerprints to licenses, copyright holders, and (for vulnerable code) specific CVEs.
* Persists triage decisions via ORT integration: `.ort.yml` `snippet_choices` entries record "snippet match X is boilerplate, ignore" with audit-trail reason.

SCANOSS can be run as a self-hosted service or against the public API. Self-hosting eliminates source-code-leaving-premises concerns for proprietary repositories.

### FossID

Commercial SCA with snippet matching, broader corpus, and enterprise workflow integration. Use when:

* Snippet-detection corpus needs to exceed SCANOSS coverage.
* Compliance program requires a vendor SLA on detection accuracy.
* Integration with enterprise GRC platforms is required.

The skill remains the same; only the scanner selection changes. The orchestration / policy / reporting layers built on ORT can consume SCANOSS or FossID output equivalently if the integration layer normalizes findings.

## False positives and alert fatigue

Snippet scanners flag boilerplate, autogenerated stubs, and standard algorithms as matches. Without management, developer trust in the scanner collapses within weeks.

### Mitigation patterns

1. **Confidence thresholds**: most scanners expose a confidence score; require ≥ 80% match before raising a finding to a blocking severity.
2. **Persisted triage**: `.ort.yml` `snippet_choices` (or equivalent) records every triaged decision. The scanner respects the decision on subsequent runs.
3. **Boilerplate corpus**: maintain an internal allow list of known-boilerplate snippet hashes (autogenerated API stubs, common algorithm implementations, vendor SDKs).
4. **PR-comment severity tiering**: block on hard violations only; surface soft findings as informational PR comments without failing the build.
5. **Periodic full audits**: rerun the scanner with low thresholds quarterly, off the critical path. Triage findings into `.ort.yml` rather than at PR time.

The goal is not zero alerts. The goal is that every alert that reaches a developer represents a decision worth making.

## Honest limits of automated detection

State these in PR comments and audit-package documentation:

* **Dynamic linking**: runtime-linked libraries (system libraries, OS-provided runtimes) are invisible to source-level scanning. If the deployment payload includes an OS image, the OS layer must be scanned separately.
* **Obfuscation**: Java code processed by ProGuard or R8 strips function signatures, dead code, and class names. Snippet matching against obfuscated artifacts is unreliable. Scan pre-obfuscation source.
* **Reachability ≠ legal obligation**: runtime SCA tools can suppress findings on unreachable code paths. From a legal perspective, distribution of the code triggers obligations regardless of reachability. Do not allow a security-oriented reachability filter to suppress license findings.
* **Native binaries without symbols**: stripped C/C++/Rust binaries are largely opaque. Scan source, not stripped artifacts.
* **Licensed-by-reference**: a `README.md` "this is MIT" with no license text is detectable but not actionable; the scanner should flag for human resolution.
* **License changes mid-version-range**: a dependency that flipped licenses across versions requires lockfile-pinned version-aware scanning. Bare manifest scans can miss this.

## When to run which scanner

| Stage | Scanner | Cost | Catches |
|-------|---------|------|---------|
| Pre-commit / IDE | `reuse` linter | Negligible | Missing SPDX headers in new files. |
| PR-time fast | ORT analyzer + curated `rules.kts` | Seconds to low minutes | Manifest-level new dependencies, banned licenses. |
| PR-time deep | ORT analyzer + ScanCode scanner + evaluator | Minutes | License findings in actual fetched source, NOTICE compliance, attribution gaps. |
| Periodic / nightly | ORT + SCANOSS snippet | Tens of minutes | Copy-pasted snippets, transitive shifts. |
| Pre-release | Full ORT + SCANOSS + manual triage | Hours | Final SBOM, attribution bundle, audit packet. |

Tier the scanner so PR-time stays fast; reserve expensive analysis for nightly and release gates. The PR-time scanner that takes 20 minutes will be turned off; the one that takes 90 seconds becomes infrastructure.
