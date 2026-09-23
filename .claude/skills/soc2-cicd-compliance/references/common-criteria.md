# Common Criteria CC1 through CC9

The mandatory Security category. Every SOC 2 report includes these. Each entry lists the criterion text, the deterministic repository check, the agentic reasoning hook (where applicable), and the out-of-repo limit.

Cite criterion identifiers exactly: `CC1.1`, `CC6.1`, etc.

## CC1: Control Environment

Organizational integrity, ethical values, board oversight, structural standards.

### CC1.1 - Tone at the top, integrity, ethical values

* **Deterministic**: presence of `.github/CODE_OF_CONDUCT.md`; presence of an employee handbook acknowledgment registry in the compliance directory.
* **Agentic**: parse the Code of Conduct to ensure it explicitly addresses contractor and vendor conduct (2022 points-of-focus update).
* **Out of repo**: actual ethical conduct in board meetings, day-to-day management behavior.

### CC1.2 - Board independence

* **Deterministic**: existence of a Board Charter document.
* **Out of repo**: financial independence of board members, actual oversight quality.

### CC1.3 to CC1.5 - Management structure, competence, accountability

Includes 2022 update on privacy reporting lines.

* **Deterministic**: organizational chart artifact (`org_chart.yaml`) and role definitions mapped to GitHub teams; CISO reporting line documented.
* **Agentic**: confirm the org chart explicitly defines a privacy and security reporting line.
* **Out of repo**: actual hiring rigor, real disciplinary actions, performance review quality.

## CC2: Communication and Information

The entity generates and uses relevant, quality information internally and externally.

### CC2.1 - Generates relevant information

* **Deterministic**: parse logging IaC (Datadog, Splunk, ELK, OpenSearch configurations) for declared aggregation pipelines and retention.

### CC2.2 - Internal communication

* **Deterministic**: CI/CD webhooks routing security alerts (Dependabot failures, SAST findings) to internal Slack or Teams channels.

### CC2.3 - External communication

* **Deterministic**: `.github/SECURITY.md` with responsible disclosure and (if applicable) bug bounty instructions.

## CC3: Risk Assessment

Specifies objectives, identifies risks, assesses fraud potential.

### CC3.1 - Suitable objectives

* **Deterministic**: presence and parseability of `risk_register.csv` or markdown threat models (STRIDE, LINDDUN outputs).

### CC3.2 - Identifies and analyzes risk (vulnerabilities)

* **Deterministic**: connect to Dependabot, Snyk, Trivy outputs; assess current dependency CVE severities.
* **Agentic**: compare active CVE severity distribution against the thresholds defined in the Risk Management Policy (e.g., "no unpatched critical for >7 days").

### CC3.3 - Fraud risk

* **Deterministic**: scan IaC for WAF deployment, rate limiting, anti-credential-stuffing controls.

### CC3.4 - Changes affecting internal control

* **Deterministic**: track update frequency of threat-model documentation following major architecture PR merges. Flag if an architecture-touching PR (changes to `terraform/network/`, `helm/`, etc.) merged without a corresponding threat-model update.

## CC4: Monitoring Activities

Ongoing evaluation of internal control effectiveness.

### CC4.1 - Ongoing and separate evaluations

* **Deterministic**: parse `.github/workflows/` or `.gitlab-ci.yml`. Verify SAST, DAST, SCA jobs are explicitly defined, mandatory (`if:` conditions do not allow skip), and execute on every commit or daily cron.
* **Type II requirement**: verify these jobs ran continuously over the observation window with no extended deactivation.

### CC4.2 - Evaluates and communicates deficiencies

* **Deterministic**: pipelines configured to *block* merges on security job failures. A "warn-only" SAST job fails this criterion. Branch protection must require the security check as a status check.

## CC5: Control Activities

Selects and develops control activities that mitigate risks to acceptable levels.

### CC5.1 - Selects control activities

* **Deterministic**: branch protection API state. `required_pull_request_reviews.required_approving_review_count >= 1` (typically `>= 2` for higher-assurance environments). `dismiss_stale_reviews = true`. `require_code_owner_reviews = true` for sensitive paths.

### CC5.2 - Technology general controls

* **Deterministic**: scan Terraform/CloudFormation for systematic baseline rules: no public IPs on databases, default-deny security groups, mandatory tagging.

### CC5.3 - Deploys through policies and procedures

* **Agentic**: map the technical branch-protection state from CC5.1 back to the prose in `Change_Management_SDLC.md`. The mapping is the proof of policy-to-implementation deployment.

## CC6: Logical and Physical Access Controls

Most technically dense category. Governs access restriction and boundary protection.

### CC6.1 - Logical access implementation

* **Deterministic**:
  * Git provider API: organization-wide MFA enforced.
  * IaC IAM password policy: minimum complexity and rotation.
  * Secret scanning (GitLeaks, GitHub Advanced Security) over full commit history. Any AWS key, GitHub PAT, Stripe key, or DB URI is a critical fail.
  * IaC: encryption-at-rest flags on all storage resources; KMS key declarations.
* **Agentic**: cross-reference the Information Security Policy's encryption mandate (e.g., "AES-256 with customer-managed keys") against the actual KMS configuration in IaC.

### CC6.2 - User registration and authorization, deprovisioning

* **Deterministic**: SSO/SAML integration configured for the Git provider and any other auditable identity-consuming SaaS (so that offboarding flows through one IdP).
* **Out of repo**: actual offboarding completion across non-Git SaaS unless those systems push audit logs into the IdP or SIEM.

### CC6.3 - Access modification, least privilege, segregation of duties

* **Deterministic**:
  * Parse `CODEOWNERS`. Sensitive paths (`.github/workflows/`, `terraform/`, `helm/charts/production/`) require approval from designated security or DevOps teams.
  * Scan AWS IAM policies, Kubernetes `Role`/`ClusterRole` manifests for wildcard permissions (`Action: "*"`, `Resource: "*"`, `verbs: ["*"]`). Any wildcard outside well-justified service accounts is a fail.

### CC6.4 and CC6.5 - Physical access and devices

* **Out of repo**: badge access, data center locks, MDM enforcement, privacy screens.
* **Deterministic floor**: `Physical_Security_Policy.md` exists and references current procedures.

### CC6.6 - Boundary protection

* **Deterministic**: scan IaC network definitions. Any AWS Security Group or Network ACL with ingress `0.0.0.0/0` on sensitive ports (22 SSH, 3389 RDP, 5432 Postgres, 3306 MySQL, 6379 Redis, 27017 MongoDB) is a critical immediate-block finding. WAF attached to all public endpoints.

### CC6.7 - Restricts transmission

* **Deterministic**: load balancers, API gateways, CDNs enforce TLS 1.2+ exclusively. Plaintext HTTP listeners on public-facing resources are a fail. Inspect ALB/NLB/Cloudfront listener protocols and ssl_policy fields.

### CC6.8 - Malicious software prevention

* **Deterministic**: container image scanning (Trivy, Grype) active in CI; mandatory pre-deploy scan with CVSS threshold gating.

## CC7: System Operations

Incident detection, performance monitoring, response capability.

### CC7.1 - Vulnerability detection

* **Deterministic**: continuous IaC scanning (Checkov, tfsec, Terrascan) active to detect drift and misconfiguration before `apply`.

### CC7.2 - Anomaly detection

* **Deterministic**:
  * IaC: AWS CloudTrail enabled (multi-region, log-file validation), GuardDuty enabled, VPC Flow Logs enabled.
  * Git provider audit logs streaming to external storage with at least 1-year retention (GitHub native retention is 90 days; Type II requires the export).

### CC7.3 to CC7.5 - Incident response, evaluation, recovery

* **Agentic**: parse `Incident_Response_Plan.md` for containment, eradication, recovery, and post-mortem procedures. Flag missing sections.
* **Out of repo**: actual incident response execution, tabletop exercise outcomes.

## CC8: Change Management

Controlled process for designing, developing, testing, deploying changes. Core CI/CD territory.

### CC8.1 - Authorized, tested, approved changes

* **Deterministic (Type I)**: branch protection state requires PR, requires N approving reviews, requires status checks, requires linear history (or rebase/squash merge), requires signed commits if mandated.
* **Deterministic (Type II)**: GraphQL query of all merged commits on the default branch over the window. Each must trace to a PR with `APPROVED` review state from an authorized reviewer pre-merge and passing required status checks. Force-pushes to protected branches are a CC8.1 exception. Orphaned commits are exceptions.
* **Agentic**: parse PR description bodies. Confirm developers document the *why* and *how* of changes, with linkage to ticket IDs (Jira, Linear, GitHub Issues) as required by the SDLC policy.

## CC9: Risk Mitigation

Business disruption and vendor risk.

### CC9.1 - Business disruption mitigation

* **Agentic**: parse Business Continuity Plan and Disaster Recovery documentation. Flag missing RTO/RPO declarations or stale test dates.

### CC9.2 - Vendor risk management

* **Deterministic**: SCA produces SBOM (CycloneDX or SPDX format) from dependency manifests.
* **Agentic**: read `Vendor_Management_Policy.md`. Compare against an in-repo directory of vendor SOC 2 reports (PDFs or text). Flag vendors used in critical paths whose reports are stale (>13 months) or absent.
