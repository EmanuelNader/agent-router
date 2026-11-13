# Deploy OpenCode on one Always Free VM

This is the owner runbook for the first real host. The commands below are the ones to run on a Mac after the provisioner user exists. Nothing in this repository has called a live tenancy.

## Design

The quota preview stays read-only. `previewOciDeployment` still returns `provisioningAllowed: false`. A launch needs a second decision, `OciFreeTierGate`, which accepts that preview only when every eligibility field is a known free value.

| Piece | Extends | Why this is the smallest change |
| --- | --- | --- |
| Free-tier gate | `packages/cloud-readiness` preview and report schema | Reuses the quota comparison instead of reimplementing limits. Refuses demo data, fixture evidence, trial accounts, known charges, and any unknown field. |
| Resource names, tags, dry run | New `OciResourcePlan` | One place decides the A1 profile, the tag, and the destroy filter. |
| Create and destroy | New `OciProvisioner` | Lists by tag before every create, stores an OCI retry token, and adopts the existing instance instead of launching a second one. |
| SDK calls | New `OciSdkGateway` | The readiness adapter exposes only read methods. Launch and delete do not belong there. |
| OpenCode install and health | `OpenCodeClient` plus `OpenCodeBootstrap` | Cloud-init starts pinned 2.2.7 on `127.0.0.1:4096`. Health calls `OpenCodeClient.listSessions` through an SSH local forward, so the client never sends the password over plain HTTP. |
| Commands | `deploy:oci` and `destroy:oci` | Same script style as `plan:oci`. `--dry-run` prints the resource set and does not open a client. |

`packages/cloud-oci` is the provider adapter the execution plan already assigned to lifecycle work. Putting launch and terminate next to the read-only inspector would let inspection code construct write clients. The agent package does not import the provider package. The CLI wires them together.

The first host is fixed: `VM.Standard.A1.Flex`, 1 OCPU, 4 GB, 50 GB boot volume, ephemeral public IP, internet gateway, and no NAT gateway, reserved public IP, extra volume, backup, or load balancer. Networking is created with freeform tag `agent-router-managed=opencode` and reused when that tagged VCN already exists. An untagged VCN with the same name is left alone.

Destroy deletes a resource only when its display name and that tag both match. An instance named `discord-bot` is outside the set even if it is in the same compartment.

## What you run

Use Node 24 and pnpm 11.25.0. Keep the config and keys outside the Git checkout. Do not paste them into chat.

1. Create compartment `AgentRouter` directly under the root compartment. Create group `AgentRouterProvisioners` in the Default identity domain and a user `agent-router-provisioner`. Put only that user in the group. Apply `infra/oci/provision-policy.txt` in the root compartment. Do not add these statements to the inspector user.
2. Prepare a second credential directory. Register its public key on the provisioner user, then write the config with the home region:

```sh
pnpm connect:oci prepare --directory /absolute/path/oci-provisioner
pnpm connect:oci configure --directory /absolute/path/oci-provisioner \
  --user USER_OCID --tenancy TENANCY_OCID --region HOME_REGION
```

3. Inspect and preview. The preview must print `QUOTA_FITS` for 1 OCPU, 4 GB, and 50 GB. A blocked preview cannot launch.

```sh
mkdir -p .work
pnpm inspect:oci --config /absolute/path/oci-provisioner/config > .work/oci-readiness.json
pnpm plan:oci --report .work/oci-readiness.json
```

4. Write `.work/oci-eligibility.json` only after checking each field in the console. `evidence` must be `RECORDED`. Any `UNKNOWN`, `TRIAL`, `EXCEEDS`, or `KNOWN_CHARGE` value makes the command refuse.

```json
{
  "schemaVersion": 1,
  "evidence": "RECORDED",
  "accountClass": "ALWAYS_FREE",
  "monthlyUsage": "WITHIN_ALLOTMENT",
  "imageCharge": "NONE",
  "networkCharge": "NONE",
  "storageCharge": "NONE",
  "capacity": "AVAILABLE",
  "compartmentQuota": "FITS"
}
```

`accountClass` may be `PAYG` only when this VM stays inside the current month's Always Free allotment (1,500 A1 OCPU-hours, 9,000 GB-hours, and 200 GB of boot and block storage). `capacity` means you accept an attempt of the free shape and will not approve a paid shape if Oracle returns out of host capacity. The command fails closed in that case.

5. Dry-run the real files. This still does not call Oracle. Replace the SSH CIDR with your current public address; `0.0.0.0/0` is rejected.

```sh
pnpm deploy:oci --dry-run \
  --report .work/oci-readiness.json \
  --eligibility .work/oci-eligibility.json \
  --compartment COMPARTMENT_OCID \
  --ssh-cidr PUBLIC_IP/32
pnpm destroy:oci --dry-run
```

The credential-free demo is `pnpm deploy:oci --dry-run --demo`. Demo output cannot be used for a live launch.

6. Launch. The private key must be mode `0600`. The command writes `.work/oci-deploy-state.json` mode `0600` and does not print the OpenCode password.

```sh
pnpm deploy:oci \
  --config /absolute/path/oci-provisioner/config \
  --report .work/oci-readiness.json \
  --eligibility .work/oci-eligibility.json \
  --compartment COMPARTMENT_OCID \
  --ssh-public-key "$HOME/.ssh/id_ed25519.pub" \
  --ssh-private-key "$HOME/.ssh/id_ed25519" \
  --ssh-cidr PUBLIC_IP/32
```

A successful receipt has `agentReady: true` and `publicIpAssignment: EPHEMERAL`. OpenCode listens on the VM at `127.0.0.1:4096`. The security list allows TCP 22 only from the CIDR you passed. To open a shell on the host:

```sh
ssh -i "$HOME/.ssh/id_ed25519" ubuntu@PUBLIC_IP
```

7. Destroy when you are finished. Run it again if it stops halfway; resources that are already gone are skipped. It will not terminate `discord-bot` or any other untagged instance.

```sh
pnpm destroy:oci \
  --config /absolute/path/oci-provisioner/config \
  --compartment COMPARTMENT_OCID \
  --region HOME_REGION
```

If destroy reports `NETWORK_IN_USE`, another instance still has a VNIC in the tagged subnet. The tagged instance is already terminated. The VCN is left in place until that VNIC is gone.

Exit codes: 0 means the dry run or the operation finished, 2 means the launch was refused or a tagged resource could not be removed safely, and 1 means the inputs or a request failed. Save command output under `.work/` and do not commit it.
