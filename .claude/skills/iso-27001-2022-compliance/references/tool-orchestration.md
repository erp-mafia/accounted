# Tool Orchestration: Checkov, Trivy, Steampipe

The skill must not reimplement what mature open-source security tools already do. Wrap them. The three primary engines together cover the full repository-and-runtime surface for ISO 27001:2022.

| Tool | Domain | Typical input | Output |
|---|---|---|---|
| Checkov | IaC static analysis | Terraform, CloudFormation, Kubernetes, ARM, Helm, Dockerfile | JSON / SARIF / JUnit |
| Trivy | SCA, container, secret scanning | Filesystem, container images, dependency manifests | JSON / SARIF / table |
| Steampipe | Live runtime querying | Cloud APIs, IdP APIs, GitHub API | SQL result sets |

Checkov and Trivy answer "what does the code say?" Steampipe answers "what is actually deployed?" Both questions matter: IaC drift means the code may be compliant while production isn't.

---

## Checkov

### Why
Checkov has the deepest IaC coverage of any open-source scanner: ~1,000 built-in policies across AWS, Azure, GCP, Kubernetes, Docker, Helm, and more. It uses a graph-based engine that can evaluate cross-resource relationships (e.g., "this RDS is in a subnet whose route table allows 0.0.0.0/0").

### Mapping built-in policies to ISO 27001

Checkov's built-in policies are CIS-aligned. To wrap them for ISO 27001:2022 the skill needs a translation layer:

```yaml
# .checkov.yaml or via custom config
iso_27001_mapping:
  CKV_AWS_3:    # EBS volume encryption
    iso_controls: ["A.8.24"]
  CKV_AWS_16:   # RDS encryption
    iso_controls: ["A.8.24"]
  CKV_AWS_19:   # S3 server-side encryption
    iso_controls: ["A.8.24", "A.8.10"]
  CKV_AWS_24:   # SSH from 0.0.0.0/0
    iso_controls: ["A.8.20", "A.8.22"]
  CKV_AWS_46:   # IAM hardcoded AWS access keys
    iso_controls: ["A.8.24", "A.5.17"]
  CKV_AWS_53:   # S3 block public ACLs
    iso_controls: ["A.8.12", "A.8.3"]
  # ... and so on
```

The wrapper script:
1. Runs `checkov -d ./repo --output json --quiet`.
2. Parses the JSON output.
3. Joins each `check_id` against the mapping table.
4. Re-emits findings tagged with ISO 27001 control identifiers.
5. Filters out findings for controls excluded by the SoA.

### Custom policies for ISO-specific patterns

Checkov supports custom policies in YAML for simple attribute checks and Python for graph-based checks. Example custom policy for A.8.24, ensuring all EBS volumes are encrypted:

```yaml
metadata:
  name: "Ensure EBS volumes are encrypted (ISO 27001 A.8.24)"
  id: "CUSTOM_ISO_A824_EBS_ENCRYPTION"
  category: "ENCRYPTION"
definition:
  cond_type: "attribute"
  resource_types:
    - "aws_ebs_volume"
  attribute: "encrypted"
  operator: "equals"
  value: true
```

Place custom policies in `.checkov/custom_policies/` and run with `--external-checks-dir`.

### Suppression integration

Checkov inline suppressions (`# checkov:skip=<CHECK_ID>: <reason>`) must be parsed by the wrapper to extract Risk Register IDs. Recommended convention:

```hcl
# checkov:skip=CKV_AWS_19: Risk accepted by CISO 2026-05-01 (Risk-ID: SEC-102)
resource "aws_s3_bucket" "legacy_export" {
  # ...
}
```

The wrapper extracts `Risk-ID: SEC-102` and verifies SEC-102 exists in the canonical Risk Register before honoring the suppression.

---

## Trivy

### Why
Trivy is the de-facto standard for container and dependency scanning. It supports filesystem scans, container images, Git repos, Kubernetes clusters, AWS environments, and SBOM generation. Its `--compliance` flag enables custom compliance specs.

### Custom ISO 27001 compliance spec

Create `trivy-iso27001-2022.yaml`:

```yaml
spec:
  id: iso-27001-2022
  title: ISO/IEC 27001:2022
  description: Custom compliance spec mapping Trivy checks to ISO 27001:2022 Annex A
  relatedResources: []
  version: "1.0"
  controls:
    - id: A.8.8
      name: Management of technical vulnerabilities
      description: Information about technical vulnerabilities of information systems in use shall be obtained, the organization's exposure to such vulnerabilities shall be evaluated and appropriate measures shall be taken.
      checks:
        - id: AVD-DS-0001  # Trivy container vulnerability check
        - id: CVE-*        # All CVE detection
      severity: HIGH

    - id: A.8.24
      name: Use of cryptography
      description: Rules for the effective use of cryptography, including cryptographic key management, shall be defined and implemented.
      checks:
        - id: secret-*  # All secret detection rules
      severity: CRITICAL

    - id: A.5.17
      name: Authentication information
      description: Allocation and management of authentication information shall be controlled.
      checks:
        - id: secret-*
      severity: CRITICAL

    - id: A.8.30
      name: Outsourced development
      description: The organization shall direct, monitor and review the activities related to outsourced system development.
      checks:
        - id: AVD-DS-*  # Dependency CVEs
      severity: HIGH
```

Run:
```bash
trivy fs ./repo --compliance @trivy-iso27001-2022.yaml --format json
```

### What Trivy covers for ISO

| ISO Control | Trivy capability |
|---|---|
| A.8.8 (Vuln management) | OS package CVEs, language-specific CVEs (npm, pip, gem, etc.) |
| A.8.24 (Cryptography) | Secret detection (AWS keys, GitHub tokens, generic high-entropy strings) |
| A.5.17 (Authentication info) | Secret detection in source code |
| A.8.30 (Outsourced dev) | Third-party library CVEs |
| A.8.7 (Anti-malware) | Container image scanning for known malicious packages |
| A.8.21 (Network service security) | Misconfigurations in K8s services and Dockerfile exposed ports |

### SBOM generation for A.5.21

Trivy can generate CycloneDX or SPDX SBOMs:
```bash
trivy fs --format cyclonedx --output sbom.json ./repo
```
SBOM generation directly evidences A.5.21 (Managing information security in the ICT supply chain) and A.8.30.

---

## Steampipe

### Why
Checkov and Trivy operate on what's in the repo. Steampipe queries what's actually deployed. Drift between IaC and runtime is itself a Clause 8.1 (Operational planning) finding, and runtime queries are the only way to detect it.

Steampipe uses a Postgres-compatible SQL interface over plugins for AWS, Azure, GCP, GitHub, Microsoft Entra ID, Google Workspace, Okta, Slack, and dozens more.

### Key queries for ISO 27001 evidence

#### A.8.2: Privileged access rights
```sql
-- Find IAM users with admin policies attached
SELECT u.name, p.policy_name
FROM aws_iam_user u
JOIN aws_iam_user_policy_attachment a ON a.user_arn = u.arn
JOIN aws_iam_policy p ON p.arn = a.policy_arn
WHERE p.policy_name = 'AdministratorAccess';
```

#### A.5.18: Access rights review
```sql
-- Find IAM users who haven't logged in for 90+ days
SELECT name, password_last_used
FROM aws_iam_user
WHERE password_last_used < now() - interval '90 days'
   OR password_last_used IS NULL;
```

#### A.8.5: Secure authentication
```sql
-- Find IAM users without MFA
SELECT name, mfa_enabled
FROM aws_iam_user
WHERE mfa_enabled = false
  AND password_enabled = true;
```

#### A.5.15: Access control (Microsoft Entra ID)
```sql
-- Find guest users with privileged role assignments
SELECT u.display_name, r.role_definition_name
FROM azuread_user u
JOIN azuread_directory_role_assignment a ON a.principal_id = u.id
JOIN azuread_directory_role r ON r.id = a.role_definition_id
WHERE u.user_type = 'Guest';
```

#### A.8.4: Source code access
```sql
-- Find GitHub repos without branch protection on main
SELECT full_name, default_branch
FROM github_my_repository r
LEFT JOIN github_branch_protection b ON b.repository_full_name = r.full_name
  AND b.name = r.default_branch
WHERE b.repository_full_name IS NULL;
```

#### A.8.15: Logging
```sql
-- Find AWS regions where CloudTrail is not enabled
SELECT region
FROM aws_region
WHERE region NOT IN (
  SELECT home_region FROM aws_cloudtrail_trail WHERE is_multi_region_trail = true
);
```

### Continuous evidence generation

Steampipe queries can be wrapped in [Powerpipe](https://powerpipe.io/) dashboards/benchmarks for continuous compliance evidence. Schedule them daily or hourly to maintain "operational effectiveness" evidence required for SOC 2 Type II, which goes beyond ISO 27001's point-in-time stance but is often required in dual-audit scenarios.

---

## Unified output schema

The wrapper around all three tools should normalize findings into:

```json
{
  "scan_id": "uuid",
  "repository": "org/repo",
  "commit_sha": "abc123",
  "soa_version": "1.4",
  "scanned_at": "2026-05-07T10:00:00Z",
  "tools_used": ["checkov", "trivy", "steampipe"],
  "findings": [
    {
      "finding_id": "F-001",
      "tool": "checkov",
      "tool_check_id": "CKV_AWS_19",
      "severity": "high",
      "title": "S3 bucket without server-side encryption",
      "resource": "aws_s3_bucket.data",
      "file": "infrastructure/storage.tf",
      "line": 42,
      "iso_27001_2022_controls": ["A.8.24", "A.8.10"],
      "nist_800_53_r5_controls": ["SC-28"],
      "cis_v8_1_controls": ["3.11"],
      "soc_2_tsc": ["CC6.6"],
      "soa_status": "included_implemented",
      "suppression": null
    }
  ],
  "documentation_findings": [],
  "verification_scope": {
    "deterministic_in_repo": true,
    "agentic_policy_review": true,
    "out_of_repo_evidence_pointers": true,
    "runtime_state_via_steampipe": true,
    "behavioral_compliance": false,
    "physical_validation": false
  }
}
```

This is the artifact that gets attached to the PR for human review and that becomes audit evidence.

---

## Container packaging

Distribute the wrapper as a single container image with all three tools pre-installed. Example Dockerfile sketch:

```dockerfile
FROM python:3.12-slim
RUN pip install checkov
COPY --from=aquasec/trivy:latest /usr/local/bin/trivy /usr/local/bin/trivy
COPY --from=turbot/steampipe:latest /usr/local/bin/steampipe /usr/local/bin/steampipe
COPY wrapper/ /opt/iso27001-scanner/
ENTRYPOINT ["python", "/opt/iso27001-scanner/scan.py"]
```

The wrapper script orchestrates the three engines, normalizes outputs, applies SoA filtering, and produces the unified JSON report.
