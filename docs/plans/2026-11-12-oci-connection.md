# Oracle account connection

This continues the existing Oracle readiness milestone. The standard local OCI config is absent. The connected Console shows no API keys on the current user and membership in Administrators. A dedicated inspection identity separates the current quota checker from any future provisioning authority.

## Approved Oracle setup

- Identity domain: Default.
- User: `agent-router-inspector`, with first name `Agent Router` and last name `Inspector`. The form requires an email. The account owner approved using their existing Oracle email.
- Group: `AgentRouterInspectors`; only the dedicated inspector is added.
- Root policy: `AgentRouterInspection`, exactly the statements in `infra/oci/inspection-policy.txt`.
- Scope: inspect tenancy/region and compartment metadata and read resource-limit/availability data. No compute, networking, disk, IAM mutation, secret, or model-account permissions are granted to this identity.
- A separately generated public signing key will be registered by the user. The matching private key and configuration stay outside the Git repository and all agent workspaces.

The account owner approved the exact user, group, membership, and policy. The first submission failed on the required email field. Browser access became unavailable before the updated form could be submitted. Key registration is a credential-entry handoff.

## Local implementation

- `connect:oci prepare` creates an RSA signing key in a new owner-only directory outside Git and prints the public key path and fingerprint.
- `connect:oci configure` accepts the inspector OCID, tenancy OCID, and home region, then writes an owner-only SDK config. It reads the fingerprint from the local key and preserves an existing config.
- Local tests verify key type, fingerprint, file modes, config injection rejection, no-overwrite behavior, symlink rejection, and loading the config through the pinned SDK.
- After user registration, run the read-only collector, save its sanitized report under ignored `.work/`, and run the preview. Live API data or permission failures must be recorded honestly.
- Provisioning authority and actual VM creation remain a separate scoped action after live eligibility, capacity, image, and cost checks.

## Resume in the console

1. Open **Identity & Security → Domains → Default → User management**. Create `AgentRouterInspectors` and the approved user, then verify group membership.
2. Open **Identity & Security → Policies** in the root compartment and apply `infra/oci/inspection-policy.txt` as `AgentRouterInspection`.
3. Open the inspector user's **Tokens and keys → Add API key**, choose **Public Key File**, and register the prepared public PEM. Match its fingerprint against the local helper's output.
4. Configure and run `inspect:oci` with the dedicated profile. Save the sanitized report and use `plan:oci --report` to compare current quota against one test VM.

Sources: [IAM operation permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/policyreference/iampolicyreference.htm), [Limits permissions](https://docs.oracle.com/en-us/iaas/Content/General/service-limits/overview.htm), and [identity-domain group syntax](https://docs.oracle.com/en-us/iaas/Content/Identity/policymgmt/managingpolicies_topic-Using_the_Policy_Builder.htm). ListRegionSubscriptions needs TENANCY_INSPECT; ListAvailabilityDomains needs COMPARTMENT_INSPECT. Limits listing requires INSPECT and usage reads require READ on resource-availability.
