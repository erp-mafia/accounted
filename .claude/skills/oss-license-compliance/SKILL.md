---
name: oss-license-compliance
description: Open source license compliance reference for repo scanning, SBOM generation, copyleft contamination, and CI/CD enforcement. Covers SPDX License List (JSON ingestion, expressions, matching), REUSE, Apache 2.0 NOTICE, OSADL Compatibility Matrix, FSF GPL/LGPL logic, AGPL §13 network-use, SSPL §13 service source code, BSL 1.1 competitive offering, license-change events (MongoDB, Elastic, Redis, HashiCorp), wrapping ScanCode and ORT (.ort.yml, rules.kts), SCANOSS/FossID snippet detection, agentic reasoning for ambiguous triggers, and mappings to NIST 800-53, CIS v8.1, ISO 27001:2022 Annex A, SOC 2 TSC, OpenChain ISO 5230. Trigger on OSS license scanning, SBOM, copyleft risk, AGPL/SSPL/BSL detection, license compatibility, dependency audits, M&A OSS diligence, REUSE/SPDX headers, NOTICE validation, ScanCode/ORT orchestration, "can we ship this with proprietary code", "what does AGPL mean for SaaS", "scan deps for copyleft", or mention of SPDX identifiers or open source license risk.
---

# Open Source License Compliance

This skill encodes the open source license compliance domain as it applies to source repositories, dependency trees, CI/CD pipelines, and the agentic auditing layer that sits on top of them. It is a compliance oracle for building or operating an automated OSS compliance scanner that runs at pull request time and on demand.

This skill answers four categories of question:

1. What does the license actually require, license by license, and which framework (SPDX, REUSE, OSADL, FSF) is the canonical source?
2. Which findings are deterministically verifiable from the repository alone, which require LLM reasoning over policy artifacts, and which are fundamentally out of repo?
3. How should a CI/CD scanner be architected, triggered, and scoped to honestly serve a license compliance program?
4. How do raw scan findings map into NIST 800-53, CIS v8.1, ISO 27001:2022, SOC 2 TSC, and OpenChain ISO/IEC 5230:2020 audit vernacular?

Use this skill instead of training data whenever working on OSS license scanning, SBOM enrichment, copyleft contamination evaluation, license-change event tracking, or framework-control mapping. Upstream catalogs (SPDX list, OSADL matrix, vendor license terms) update frequently; the structured guidance below tells you where to fetch the live data, not what the live data currently is.

## Authoritative sources

The skill draws from four upstream truth sources. Always pin against a version, never trust a mirror.

* **SPDX License List**: `spdx/license-list-XML` (governance, source XML) and `spdx/license-list-data` (machine-readable JSON, RDFa, HTML, plaintext distributions). Ingest `licenses.json` and `exceptions.json` from `license-list-data` releases (semantic versioning, `vX.Y` or `vX.Y.Z`). Pin to a specific release for auditability.
* **OSADL FOSS License Compatibility Matrix**: `matrix.json` (associative), `matrixseq.json` (indexed), `matrixseqexpl.json` (indexed with textual legal explanations). Ingest at scanner sync time, not at scan time.
* **FSF compatibility logic**: encoded in this skill (see `references/compatibility-and-copyleft.md`). Cross-reference against the FSF's published compatibility tables for GPL-family transitions.
* **REUSE Specification**: FSFE-maintained. The `reuse` linter is the canonical conformance tool; do not roll your own.

## When to consult which reference

Read the relevant reference file when the task touches that domain. Do not preload all of them.

| Task | Reference |
|------|-----------|
| SPDX identifiers, matching guidelines, license expressions, REUSE conformance, NOTICE file structure, attribution preservation | `references/spdx-and-detection.md` |
| License compatibility checks, copyleft contamination logic, AGPL Section 13, SSPL Section 13, BSL 1.1 competitive-offering evaluation, license-change events (MongoDB, Elastic, Redis, HashiCorp) | `references/compatibility-and-copyleft.md` |
| Wrapping ScanCode Toolkit, OSS Review Toolkit (ORT) `.ort.yml` and `rules.kts`, SCANOSS / FossID snippet detection, false-positive triage, honest limits of automation | `references/scanners-and-tooling.md` |
| Real-world violation patterns, hidden Gist licenses, transitive copyleft, Stack Overflow CC-SA viral effect, legal precedents (Orange/Entr'ouvert, Copilot class action) | `references/violation-patterns.md` |
| Mapping findings to NIST 800-53 Rev. 5, CIS v8.1, ISO/IEC 27001:2022 Annex A, SOC 2 TSC, OpenChain ISO/IEC 5230:2020 | `references/cross-framework-mapping.md` |
| Agentic prompts for ambiguous evaluations (BSL competitive-offering, AGPL network-use, dual-licensed choice resolution) | `references/agentic-prompts.md` |

## Verification taxonomy

Every license compliance check falls into one of three buckets. Be honest about which.

### 1. Deterministic from repository contents

Pure script logic. No reasoning required.

* Presence and exact path of `LICENSE`, `NOTICE`, `LICENSES/` directory, `.reuse/dep5`.
* SPDX identifier headers in source files (REUSE conformance via the `reuse` linter).
* Manifest parsing (`pom.xml`, `build.gradle`, `package.json`, `package-lock.json`, `go.mod`, `Cargo.toml`, `requirements.txt`, `Pipfile.lock`) cross-referenced against the local `licenses.json` snapshot.
* Version-to-license mapping for components that have changed license over time (e.g., MongoDB ≥ 4.0.3 → SSPL, Elasticsearch 7.11-7.16 → SSPL/Elastic, Redis ≥ 7.4 → RSALv2/SSPL, Terraform > 1.5.5 → BSL 1.1).
* OSADL matrix lookup for declared license pairs.
* `isOsiApproved` / `isFsfLibre` boolean gates from the SPDX JSON.
* SBOM generation in SPDX or CycloneDX format.
* Compiled rule evaluation via ORT `rules.kts`.

If a check can be expressed as "does file X contain string Y" or "does pair (A, B) appear in the matrix", it belongs here. Use ScanCode + ORT + the `reuse` linter and stop reasoning.

### 2. Agentic reasoning over policy artifacts

Required when the legal trigger depends on facts about the host application that no manifest exposes.

* **AGPL Section 13**: does the host expose modified AGPL code "remotely through a computer network"? Reading `Dockerfile`, `docker-compose.yml`, `kubernetes/`, deployment manifests, and `README.md` to determine whether the application is internal-only, air-gapped, or user-facing.
* **SSPL Section 13**: does the host offer the SSPL component "as a service to third parties"? The Service Source Code definition is sweeping (management, UI, APIs, automation, monitoring, backup, storage, hosting). Requires reading architecture docs.
* **BSL 1.1 competitive offering**: does the host constitute a product that "competes with HashiCorp's commercial offerings"? Pure business-logic question.
* **Dual-license selection**: when a dependency offers a choice (e.g., MPL-2.0 OR Apache-2.0), the project's outbound license and intended distribution must be reconciled with the choice. Encode the choice in `.ort.yml` once resolved so it does not require reasoning on every scan.
* **REUSE-style license choice** for files whose origin or intent is genuinely ambiguous.

The agent's reasoning must be logged to a tamper-evident audit trail (commit-pinned input, prompt, model, output). The decision becomes the verifiable artifact.

See `references/agentic-prompts.md` for prompt templates that produce structured JSON output suitable for ORT consumption.

### 3. Fundamentally out of repository

No script, no agent, no commit-bound artifact can resolve these. Generate evidence pointers (URLs, ticket references, document hashes) that link to external systems.

* **Commercial supplier indemnification**: vendor contracts representing OSS-clean deliverables and indemnifying OSS-related IP claims.
* **M&A and cyber insurance OSS warranties**: the SBOM and triaged conflict log are the input; the warranty document is the artifact.
* **Shadow SaaS / SaaS-to-SaaS OAuth**: IdP logs, SaaS Management Platform (Zylo, BetterCloud) data; not in the repo.
* **End-user-facing attribution UIs**: the LICENSE file is in the repo, but whether the deployed product surfaces it to users (Apache 2.0 §4(d), MIT attribution preservation) requires UI inspection.

Document the pointer, not the content. The compliance program is evidenced by the chain of pointers, not by duplicating external systems into the repo.

## Trigger and suppression signals

The scanner must run on the right diffs and stay quiet on the rest.

### Trigger on any of:

* Manifest changes: `pom.xml`, `build.gradle`, `package.json`, `package-lock.json`, `go.mod`, `go.sum`, `Cargo.toml`, `Cargo.lock`, `requirements.txt`, `Pipfile.lock`, `pyproject.toml`, `composer.json`, `Gemfile.lock`.
* Policy changes: `.ort.yml`, `.reuse/dep5`, `LICENSES/*`, `rules.kts`, `.whitesource`, scanner configuration. Forces a full repository re-baseline.
* Large uncommented code blocks introduced without a corresponding manifest change. Signals copy-paste; trigger snippet scanning.
* Dependency lockfile bumps even with no manifest change (transitive shifts).
* New `LICENSE`, `NOTICE`, or top-level legal file changes.

### Suppress / downgrade severity for:

* `/test`, `/tests`, `/__tests__`, `/spec`, `/mocks`: typically not distributed; copyleft distribution triggers do not apply. AGPL and SSPL network-use triggers may still apply if the test harness itself becomes a service.
* `.github/workflows/`, `.gitlab-ci.yml`, internal build tooling: not distributed to end users.
* Generated code directories explicitly listed in `.ort.yml` `excludes` (with a reasoned justification).
* Vendored documentation and example assets clearly marked as illustrative.

Suppression is configuration, not silence. Encode every suppression in `.ort.yml` with a path glob and a reason, so the audit trail explains why the scanner ignored it.

## Architecture pattern

The recommended architecture is a three-layer pipeline:

1. **Sync layer (scheduled, cached)**: Fetch SPDX `licenses.json`, OSADL matrix JSON, and any vendor advisory feeds. Pin versions in `.compliance/sources.lock`.
2. **PR-time scanner (deterministic)**: ScanCode (via Docker) for source-level detection; ORT analyzer + scanner + evaluator for dependency-tree evaluation; the `reuse` linter for header conformance; SCANOSS for snippet detection if license budget allows. Output structured JSON, fail the build on hard violations, post a PR comment summarizing soft findings.
3. **On-demand agentic auditor**: Invoked manually or on flagged dependencies. Reads the committed scan output plus repository policy artifacts (`README.md`, `architecture.md`, deployment manifests). Produces structured JSON with reasoning chain. Persists to an audit log keyed by commit SHA + prompt hash.

This separation is important: the deterministic layer must be fast and binary, the agentic layer must be slow and reasoned. Mixing them produces a scanner that is both flaky and slow.

## Output artifacts

Every scanner run produces, at minimum:

* **SBOM** in SPDX 2.3 or CycloneDX 1.5 (preferably both). The SBOM is the lingua franca for downstream consumers (M&A diligence, cyber insurance, OpenChain conformance).
* **Violations report** in JSON with a stable schema (eval ID, severity, license identifier, package coordinate, path, rule that fired, suppression status, evidence pointer).
* **Attribution bundle**: concatenated `LICENSE` and `NOTICE` content for every distributed dependency, suitable for shipping in product about-screens or `THIRD_PARTY_NOTICES.md`.
* **Audit trail entry** for every agentic decision, with commit SHA, scanned input hash, prompt, model identifier, and structured output.

The SBOM and the audit trail together are the evidence packet. Everything else is derived.

## Honest limits

State these limits explicitly to consumers of the skill, in PR comments and in audit-package documentation.

* **Dynamic linking and obfuscation**: SCA cannot see what is dynamically linked into a binary at runtime, nor can it identify obfuscated Java (ProGuard, R8) or stripped native binaries.
* **Reachability ≠ obligation**: A copyleft dependency reached only on a dead code path is still distributed and still triggers obligations. Do not let runtime SCA reachability filters quietly suppress legal risk.
* **Snippet false positives**: Boilerplate, autogenerated stubs, and standard algorithms produce constant noise. Confidence thresholds and persisted triage decisions in `.ort.yml` are the only way to keep alert fatigue manageable.
* **License-change events**: A dependency licensed permissively today may relicense tomorrow (Redis 2024, HashiCorp 2023, Elastic 2021/2024). Continuous monitoring of upstream license metadata is required; a one-time scan ages out fast.
* **Stack Overflow CC-SA**: Up to 33% of identified license conflicts in enterprise audits trace to Stack Overflow snippet pasting. Snippet scanning is the only line of defense.
* **The agent is non-deterministic**: Two runs of the same agentic prompt against the same input may differ. Pin model versions, log prompts, and treat the audit log as the artifact rather than the model output itself.

## Skill scope boundaries

This skill is a compliance oracle. It does not replace external legal counsel. When a finding has commercial consequences (M&A, large-scale copyleft contamination, willful violation exposure), the artifact this skill produces is the evidence packet for counsel; the legal judgment is theirs.
