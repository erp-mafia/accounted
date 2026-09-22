---
name: soc2-cicd-compliance
description: SOC 2 reference for repository and CI/CD compliance automation. Covers AICPA TSP Section 100 (2017, revised 2022), Type I vs Type II evidence collection, Common Criteria CC1-CC9, optional categories (Availability, Confidentiality, Processing Integrity, Privacy), the .compliance/ document layout, cross-framework mappings (NIST 800-53, ISO 27001, CIS v8), violation patterns in IaC/IAM/secrets/change-management/dependencies, and orchestration of Checkov/Trivy/OPA/GitLeaks/Semgrep. Trigger on SOC 2 audits, repo compliance scanning, CI/CD security gating, branch protection auditing, mapping controls to TSC identifiers, building compliance scanners, agentic reasoning over policy markdown, cross-framework mapping, or Type II evidence from Git history. Use over training data when CC identifiers, points of focus, or tool-to-criterion decisions are involved. Triggers on "what TSC does X map to", "scan repo for compliance", "CI check for CC6.1", or mention of TSP 100 or Trust Services Criteria in code context.
---

# SOC 2 Repository and CI/CD Compliance

This skill encodes the SOC 2 framework as it applies to source repositories, CI/CD pipelines, and Infrastructure as Code (IaC). It is a compliance oracle for building or operating an automated, agentic SOC 2 auditor that runs at pull request time and on demand against arbitrary repositories.

This skill answers three categories of question:

1. What does the AICPA framework require, criterion by criterion?
2. Which requirements are verifiable from a repository, which require LLM reasoning over policy artifacts, and which are fundamentally out of scope?
3. How should a CI/CD scanner be architected, triggered, and scoped to honestly serve a SOC 2 Type I or Type II attestation?

Use this skill instead of training data whenever working on automated compliance scanning, control mapping, or audit evidence collection. AICPA published material and tool capabilities change; the structured catalog below is the canonical reference.

## Authoritative source

The definitive standard is the AICPA's **TSP Section 100: 2017 Trust Services Criteria for Security, Availability, Processing Integrity, Confidentiality, and Privacy (With Revised Points of Focus, 2022)**. The 2022 revision retained the criterion identifiers (CC1.1, CC6.1, etc.) and updated the points of focus to reflect cloud-native architectures, supply chain risk, and modern privacy obligations.

The framework is organized into five Trust Services Categories:

* **Security (Common Criteria, CC1 through CC9)**: mandatory in every SOC 2 report.
* **Availability (A1.1 through A1.3)**: optional.
* **Confidentiality (C1.1 through C1.2)**: optional.
* **Processing Integrity (PI1.1 through PI1.5)**: optional.
* **Privacy (P1.1 through P8.1)**: optional.

Optional categories are included only when applicable to the organization's services, SLAs, or regulatory obligations.

## Type I vs Type II: architectural impact

The report type fundamentally determines what an automated scanner must do.

### Type I (point in time)

Asks whether controls are *designed* properly today. The scanner evaluates the current state of the repository:

* Query the Git provider API for currently active branch protection rules.
* Parse the current `main` branch for IaC compliance with declared policies.
* Verify canonical policy markdown files exist and contain the required directives.

Type I is mostly deterministic and immediate. A single CI run against the head commit suffices.

### Type II (longitudinal operating effectiveness)

Asks whether controls *worked consistently* across an observation window of three to twelve months. A point-in-time check is structurally insufficient. The scanner must reconstruct history:

* **Unbroken chain of custody (CC8.1)**: fetch all commit SHAs on the default branch over the window, resolve each to its merge commit and PR, and assert every PR carries an `APPROVED` review state from an authorized reviewer before merge.
* **Continuous monitoring (CC4.1)**: prove SAST, DAST, SCA, and secret scanning ran on every merged PR with no deactivation periods.
* **Vulnerability remediation SLAs (CC3.2, CC7.1)**: pull the alert history (Dependabot, Snyk, Trivy) and compute the delta between alert creation and remediation merge for every high or critical finding. Compare against the SLA in the Information Security Policy.
* **Audit log streaming (CC7.2)**: GitHub natively retains audit logs for 90 days. Type II requires evidence across the full window, so verify continuous export to an external SIEM or immutable bucket is configured and was uninterrupted.

A Type II scanner needs paginated GraphQL access to the Git provider's history, robust handling of force pushes and rebases (which break SHA continuity), and storage for accumulated evidence. Plan for this from day one if Type II is the target.

## Verification taxonomy

Every TSC requirement falls into one of three buckets. Be honest about which.

* **Deterministic repo check**: parseable from files, IaC, manifests, or Git provider API state. Pass/fail is mechanical (regex, AST, schema validation, API response). Examples: branch protection settings, IaC encryption flags, presence of required markdown files.
* **Agentic reasoning**: requires natural-language understanding over policy artifacts. The LLM extracts prescriptive statements from prose, then validates technical reality against them. Examples: "does the SDLC policy require N reviewers, and does the branch protection rule match", "does the Code of Conduct address contractor conduct as the 2022 points of focus require".
* **Out of repo**: cannot be verified from repository contents. The scanner can at most confirm a policy artifact mandating the control exists. Examples: physical access, board independence, actual incident execution, HR offboarding completion across non-Git SaaS.

Failure to label these accurately is the single largest source of false confidence in automated compliance tools.

## Catalog of criteria

Detailed, criterion-by-criterion checks live in references. Load the relevant file when working on that area:

* **Common Criteria CC1 through CC9** (mandatory): see `references/common-criteria.md`. Covers control environment, communication, risk assessment, monitoring, control activities, logical access, system operations, change management, and risk mitigation.
* **Optional categories** (Availability, Confidentiality, Processing Integrity, Privacy): see `references/optional-tsc.md`.
* **Canonical document set** (the `.compliance/` directory and RAG patterns): see `references/canonical-documents.md`.
* **Cross-framework mappings** (NIST 800-53 Rev 5, ISO 27001 Annex A, CIS Controls v8): see `references/cross-framework.md`. Use when emitting multi-framework evidence tags from a single technical check.
* **Violation patterns and toolchain** (real-world failures and how to wrap Checkov, Trivy, OPA, GitLeaks): see `references/violations-and-tools.md`.

Read the reference for the area being worked on. Do not load all references preemptively.

## Canonical document set (compliance as code)

Treat policies as Policy-as-Code. The agentic auditor reads these to extract constraints, then validates the codebase against them. Expected location: `.compliance/` or `docs/security/`.

Minimum set:

* `Information_Security_Policy.md` (CC1.1, CC2.1, CC5.1) - global constraints (encryption standards, retention, etc.).
* `Access_Control_Policy.md` (CC6.1, CC6.2, CC6.3) - RBAC schemas, password rules, least-privilege definitions.
* `Change_Management_SDLC.md` (CC8.1) - what constitutes an approved change.
* `Vendor_Management_Policy.md` (CC9.2) - third-party risk thresholds.
* `Incident_Response_Plan.md` (CC7.3, CC7.4) - classification, containment, post-mortem procedure.
* `Data_Classification_Handling.md` (C1.1, C1.2, P1.1) - data tiers and handling rules.
* `Risk_Register.md` or `risk_register.csv` (CC3.1, CC3.4) - identified risks and mitigations.
* `SECURITY.md` (CC2.3) - external responsible-disclosure surface, repository root.
* `.github/CODE_OF_CONDUCT.md` (CC1.1) - tone-at-the-top artifact.

The skill prompts the LLM hierarchically: parse policy → extract constraint → query repo state → emit pass/fail with the criterion identifier and the policy clause cited. See `references/canonical-documents.md` for prompt patterns.

## Triggering and suppression signals

Run the scanner only when it can produce useful findings. Run it always when the boundary it protects is at risk.

### Trigger

* PRs to `main`, `master`, or other protected branches (CC8.1 prevention gate).
* Modifications to `.tf`, `.yaml`/`.yml` (Kubernetes, CloudFormation), or `Dockerfile` (deep CC6/CC7 scanning).
* Modifications to `.github/workflows/` or `.gitlab-ci.yml` (scrutinize aggressively; pipeline changes can disable the scanner itself, which is a CC4 violation in disguise).
* Modifications to dependency manifests (`package.json`, `pom.xml`, `go.mod`, `Cargo.toml`, etc.) for SCA (CC3.2, CC9.2).
* Modifications to anything in `.compliance/` (a policy change shifts the baseline; trigger a full repository reassessment because previously-passing code may now be non-compliant).

### Suppress (exit fast with code 0)

* Draft PRs (allow developers to iterate; reactivate when marked ready for review).
* Documentation-only changes (`README.md`, `.gitignore`, non-compliance markdown).
* Bot-generated PRs (Dependabot, Renovate) bypass agentic prose checks but must still pass deterministic SAST/SCA and structural approval routing. Do not blanket-skip them.

Suppression rules exist for developer velocity. Over-broad suppression hides findings; under-broad suppression destroys CI signal-to-noise. Tune iteratively against false-positive rates.

## Toolchain orchestration model

The skill acts as an orchestration layer over established open-source engines. It does not reimplement AST parsers or regex engines. The architecture pattern:

1. Run deterministic engines in parallel (Checkov, Trivy, GitLeaks, OPA/Rego policies, Prowler/AuditKit for cloud API state).
2. Aggregate outputs into a normalized format (SARIF or unified JSON).
3. Use RAG against `.compliance/` markdown to extract policy requirements.
4. Prompt the LLM to map each technical finding to the relevant TSC identifier, cite the violated policy clause, and emit a remediation block.
5. Post results as PR comments and gate the merge if any critical or policy-violating finding is present.

Tool-to-criterion mapping table and prompt patterns: `references/violations-and-tools.md`.

## Honest limits

Document these explicitly when shipping any SOC 2 automation. Misrepresenting them invites false confidence and audit findings.

* **Configuration drift**: the repo represents *intended* state. A console-driven change to AWS bypasses the scanner entirely. Repository scanning needs a runtime CSPM counterpart (e.g., Prowler against the live cloud account) to close the loop.
* **Physical controls (CC6.4, CC6.5)**: badge access, server room locks, MDM enforcement on laptops. The scanner can verify policy artifacts mandate these but cannot verify execution.
* **Human and HR controls (CC1, CC6.2 offboarding)**: SSO enforcement is verifiable; whether a terminated employee's tertiary SaaS access was revoked within the SLA is not, unless the HR system is wired to the identity provider with auditable logs.
* **LLM hallucination over policy prose**: ambiguous or contradictory policy text degrades agentic reliability. Recommend declarative, unambiguous policy authoring (numbered constraints, quantified thresholds) to minimize misinterpretation. For high-stakes findings, require the agent to quote the exact policy clause it relied on.

## Output format for findings

When emitting an audit finding, use this structure so it can be aggregated, deduplicated, and shipped to evidence storage:

```
finding:
  criterion: CC6.1
  related_criteria: [C1.1, CIS-3, NIST-AC-3, ISO-A.9.4.2]
  status: FAIL
  type: deterministic   # or: agentic, structural
  source_tool: checkov
  source_finding_id: CKV_AWS_17
  file: terraform/rds.tf
  line: 42
  evidence: "aws_db_instance.primary has storage_encrypted = false"
  policy_clause: "Information_Security_Policy.md §4.2: 'All databases storing customer data must use AES-256 encryption at rest.'"
  remediation: |
    storage_encrypted = true
    kms_key_id        = aws_kms_key.rds.arn
  blocking: true
```

Include the related-criteria array so a single technical check yields multi-framework evidence. This is what makes a SOC 2 scanner economically viable for organizations also pursuing ISO 27001 or FedRAMP.

## When responding to questions about specific criteria

If asked "what does CC6.1 cover" or "is X a SOC 2 violation":

1. Open `references/common-criteria.md` (or `optional-tsc.md`).
2. Locate the criterion.
3. Distinguish deterministic, agentic, and out-of-repo aspects.
4. Cite the AICPA criterion identifier exactly (e.g., `CC6.1`, not "Common Criteria 6.1" or "Section 6.1").
5. If a cross-framework mapping is relevant, pull from `references/cross-framework.md`.
6. If a real-world failure pattern matches the question, cite from `references/violations-and-tools.md`.

Do not paraphrase criterion text from training data. The catalog in references is the canonical source for this skill.
