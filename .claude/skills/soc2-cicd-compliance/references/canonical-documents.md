# Canonical Document Set and RAG Patterns

The agentic auditor reasons over the repository's policy artifacts to extract constraints, then validates technical reality against them. This requires a stable, predictable document layout.

## Expected directory structure

```
.compliance/                              # or docs/security/
├── policies/
│   ├── Information_Security_Policy.md
│   ├── Access_Control_Policy.md
│   ├── Change_Management_SDLC.md
│   ├── Vendor_Management_Policy.md
│   ├── Incident_Response_Plan.md
│   ├── Data_Classification_Handling.md
│   ├── Business_Continuity_Plan.md
│   ├── Disaster_Recovery_Plan.md
│   ├── Physical_Security_Policy.md
│   └── Privacy_Policy.md
├── risk/
│   ├── risk_register.csv
│   └── threat_models/
│       └── *.md
├── vendors/
│   ├── vendor_inventory.csv
│   └── reports/
│       └── *.pdf                         # third-party SOC 2 reports
├── evidence/                             # generated; gitignored or LFS
│   ├── type_i/
│   └── type_ii/
└── mappings/
    └── tsc_to_controls.yaml              # criterion to internal control IDs
```

Repository community artifacts (CC2.3, CC1.1):

```
SECURITY.md                   # responsible disclosure
.github/CODE_OF_CONDUCT.md    # tone-at-the-top
```

## Document-to-criterion mapping

| Document | Primary criteria | Agentic reasoning intent |
|---|---|---|
| Information_Security_Policy.md | CC1.1, CC2.1, CC5.1, C1.1 | Global constraints (encryption mandates, retention, complexity rules). Source of truth for generating Rego/OPA policies. |
| Access_Control_Policy.md | CC6.1, CC6.2, CC6.3 | RBAC schemas, password rules. Cross-reference against IAM JSON and Kubernetes RoleBindings. |
| Change_Management_SDLC.md | CC8.1, CC4.1, CC4.2 | Approved-change definition. Defines required reviewers, mandatory checks, ticket-linkage requirements. |
| Vendor_Management_Policy.md | CC9.2 | Third-party risk thresholds. Drives SBOM evaluation and vendor SOC 2 freshness checks. |
| Incident_Response_Plan.md | CC7.3, CC7.4, CC7.5 | Containment, eradication, post-mortem procedures. Verify structural completeness. |
| Data_Classification_Handling.md | C1.1, C1.2, P1.1, P4.1 | Tier definitions. Drives encryption-tier matching and retention enforcement. |
| Business_Continuity_Plan.md | CC9.1, A1.2 | RTO, RPO, alternate-site procedures. |
| Disaster_Recovery_Plan.md | A1.2, A1.3 | Restore procedures and test cadence. |
| Physical_Security_Policy.md | CC6.4, CC6.5 | Existence-check only; substance is out-of-repo. |
| Privacy_Policy.md | P1 through P8 | Notice coverage, retention durations, third-party disclosure list. |
| risk_register.csv | CC3.1, CC3.4 | Identified risks and current mitigations. |
| threat_models/*.md | CC3.1, CC3.3 | STRIDE/LINDDUN outputs. Trigger updates after architecture-touching merges. |
| vendor_inventory.csv | CC9.2 | Vendor list with criticality and SOC 2 status. |
| tsc_to_controls.yaml | All | Internal control ID-to-criterion mapping. The ground-truth crosswalk. |

## RAG prompt patterns

The skill uses retrieval-augmented generation: pull the relevant policy section, attach the relevant technical evidence, ask the LLM to evaluate the match.

### Pattern 1: Policy-derived deterministic check

Used when the policy declares a quantified constraint that maps directly to a repo-state field.

```
Context:
  Policy clause (Information_Security_Policy.md §4.2):
    "All databases storing customer data must use AES-256 encryption at rest with customer-managed KMS keys."

  Repo state (terraform/rds.tf, parsed AST):
    aws_db_instance.primary:
      storage_encrypted: false
      kms_key_id: null

Task:
  Evaluate against SOC 2 CC6.1 and C1.1.
  Output: PASS or FAIL, with the policy clause cited and the exact code remediation block.
```

### Pattern 2: Structural completeness check on policy artifact

Used when the criterion requires a policy section to address specific topics.

```
Context:
  Document (Incident_Response_Plan.md): <full markdown body>

  SOC 2 CC7.3 to CC7.5 require the IR plan to define:
    - event classification scheme
    - containment procedure
    - eradication procedure
    - recovery procedure
    - post-mortem procedure
    - external communication template

Task:
  For each required section, output PRESENT/ABSENT and quote the heading or first sentence if present.
```

### Pattern 3: Cross-document consistency check

Used to detect drift between policy and implementation.

```
Context:
  Change_Management_SDLC.md §3:
    "Pull requests modifying production infrastructure require approval from at least two members of the Platform Security team."

  Branch protection state (GitHub API):
    required_approving_review_count: 1
    require_code_owner_reviews: true
    dismiss_stale_reviews: false

  CODEOWNERS for terraform/production/:
    @org/platform-security

Task:
  Evaluate against SOC 2 CC5.3 (deployment of policies and procedures).
  Identify any gap between policy text and technical state.
```

### Pattern 4: Hierarchical reasoning

Used when one criterion depends on a chain of policy and state.

```
Step 1: Parse Change_Management_SDLC.md.
Step 2: Extract the required number of reviewers and required status checks.
Step 3: Query the Git provider API for the branch protection rule on `main`.
Step 4: Compare. Emit PASS/FAIL against CC5.1, CC5.3, CC8.1.
```

## Policy authoring guidance for agentic reliability

The LLM's failure mode over policy prose is misinterpretation, not retrieval failure. Reduce risk by writing policies in a declarative style:

* Quantify thresholds. "Strong passwords" is ambiguous; "minimum 14 characters, plus complexity rules below" is parseable.
* Number constraints. Each requirement gets its own clause ID (`§4.2.1`, `§4.2.2`) so findings can cite a specific rule.
* Avoid contradictions across documents. If two policies disagree, the agent will pick one non-deterministically. Add a precedence statement to the Information Security Policy.
* Use a machine-readable shadow. For high-stakes constraints, accompany the prose with a YAML or Rego encoding under `mappings/`. The agent then has a deterministic source and the prose serves as human-readable documentation.

When you ask the agent to evaluate a constraint, require it to quote the exact clause it relied on. This makes findings auditable and surfaces hallucinations during review.
