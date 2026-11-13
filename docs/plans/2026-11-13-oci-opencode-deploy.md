# Deploy OpenCode on one Always Free VM

This is the owner runbook for the first real host. The commands below are the ones to run on a Mac after the provisioner user exists. Nothing in this repository has called a live tenancy.

## Design

The quota preview stays read-only. `previewOciDeployment` still returns `provisioningAllowed: false`. A launch needs a second decision, `OciFreeTierGate`, which accepts that preview only when every eligibility field is a known free value.

| Piece | Extends | Why this is the smallest change |
| --- | --- | --- |
| Free-tier gate | `packages/cloud-readiness` preview and report schema | Reuses the quota comparison instead of reimplementing limits. Refuses demo data, fixture evidence, trial accounts, Pay As You Go unless `--allow-payg` is set, known charges, and any unknown field. Live deploy runs `inspectOci` immediately before launch. |
| Resource names, tags, dry run | New `OciResourcePlan` | One place decides the A1 profile, the tag, and the destroy filter. |
| Create and destroy | New `OciProvisioner` | Lists by tag before every create, stores an OCI retry token, and adopts the existing instance instead of launching a second one. |
| SDK calls | New `OciSdkGateway` | The readiness adapter exposes only read methods. Launch and delete do not belong there. |
| OpenCode install and health | `OpenCodeClient` plus `OpenCodeBootstrap` | Cloud-init installs pinned 2.2.7 and does not contain the password. SSH writes it after boot. Health calls `OpenCodeClient.listSessions` through a local forward. |
| Commands | `deploy:oci` and `destroy:oci` | Same script style as `plan:oci`. `--dry-run` prints the resource set and does not open a client. |

`packages/cloud-oci` is the provider adapter the execution plan already assigned to lifecycle work. Putting launch and terminate next to the read-only inspector would let inspection code construct write clients. The agent package does not import the provider package. The CLI wires them together.

The first host is fixed: `VM.Standard.A1.Flex`, 1 OCPU, 4 GB, 50 GB boot volume, ephemeral public IP, internet gateway, and no NAT gateway, reserved public IP, extra volume, backup, or load balancer. Each deployment is tagged with its own id, which is saved with the region, compartment, and resource IDs. Networking is reused only when that same deployment id is already present. An untagged VCN with the same name is left alone.

Destroy without `--yes` lists the saved IDs and does not delete. `--yes` deletes those IDs. A resource that is not in the state file is left alone unless `--include-unrecorded` is set. An instance named `discord-bot` stays even if it carries the deployment tag or the same display name.

## What you run

Use Node 24 and pnpm 11.25.0. Keep the config and keys outside the Git checkout. Do not paste them into chat.

1. Create compartment `AgentRouter` directly under the root compartment. The compartment OCID is required later; the tenancy OCID is rejected. Create group `AgentRouterProvisioners` in the Default identity domain and a user `agent-router-provisioner`. Put only that user in the group. Apply `infra/oci/provision-policy.txt` in the root compartment. That policy includes `inspect tenancies` and `read resource-availability`, so this user can both inspect quota and launch. Do not add the manage statements to the inspector user.
2. Prepare a second credential directory. Register its public key on the provisioner user, then write the config with the home region:

```sh
pnpm connect:oci prepare --directory /absolute/path/oci-provisioner
pnpm connect:oci configure --directory /absolute/path/oci-provisioner \
  --user USER_OCID --tenancy TENANCY_OCID --region HOME_REGION
```

3. Inspect and preview with the provisioner config. The preview must print `QUOTA_FITS` for 1 OCPU, 4 GB, and 50 GB. If the tenancy has more than one availability domain, pass its exact name to `inspect:oci --availability-domain`. A blocked preview cannot launch. This preview is only a look at the account. The live deploy command inspects again immediately before create and does not read this file.

```sh
mkdir -p .work
pnpm inspect:oci --config /absolute/path/oci-provisioner/config > .work/oci-readiness.json
pnpm plan:oci --report .work/oci-readiness.json
```

4. Write `.work/oci-eligibility.json` only after checking each field in the console. `evidence` must be `RECORDED`. Any `UNKNOWN`, `TRIAL`, `EXCEEDS`, or `KNOWN_CHARGE` value makes the command refuse. `accountClass` must be `ALWAYS_FREE` unless you pass `--allow-payg`.

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

`accountClass` may be `PAYG` only together with `--allow-payg`, and only when this VM stays inside the current month's Always Free allotment (1,500 A1 OCPU-hours, 9,000 GB-hours, and 200 GB of boot and block storage). `capacity` means you accept an attempt of the free shape and will not approve a paid shape if Oracle returns out of host capacity. The command fails closed in that case.

5. Dry-run the real files. This still does not call Oracle. The SSH CIDR must be a single address (`/32`) or no wider than `/24`. `0.0.0.0/0`, `0.0.0.0/1`, and `/16` are rejected. The compartment value must be `ocid1.compartment.oc1..`.

```sh
pnpm deploy:oci --dry-run \
  --report .work/oci-readiness.json \
  --eligibility .work/oci-eligibility.json \
  --compartment COMPARTMENT_OCID \
  --ssh-cidr PUBLIC_IP/32
pnpm destroy:oci --dry-run
```

The credential-free demo is `pnpm deploy:oci --dry-run --demo`. Demo output cannot be used for a live launch.

6. Launch. The private key must be mode `0600`. Do not pass `--report`; the command inspects the home region immediately before it creates anything. It writes `.work/oci-deploy-state.json` mode `0600` with the deployment id, region, compartment, and resource IDs. It does not print the OpenCode password. Cloud-init installs OpenCode but does not receive the password. After SSH accepts connections, the command writes the password over SSH and then checks `OpenCodeClient.listSessions` through a local forward.

```sh
pnpm deploy:oci \
  --config /absolute/path/oci-provisioner/config \
  --eligibility .work/oci-eligibility.json \
  --compartment COMPARTMENT_OCID \
  --availability-domain 'FULL_AD_NAME' \
  --ssh-public-key "$HOME/.ssh/id_ed25519.pub" \
  --ssh-private-key "$HOME/.ssh/id_ed25519" \
  --ssh-cidr PUBLIC_IP/32
```

Omit `--availability-domain` when the home region has one availability domain. Add `--allow-payg` only for a Pay As You Go tenancy that is still inside the free allotment. A successful receipt has `agentReady: true` and `publicIpAssignment: EPHEMERAL`. OpenCode listens on the VM at `127.0.0.1:4096`. The security list allows TCP 22 only from the CIDR you passed. To open a shell on the host:

```sh
ssh -i "$HOME/.ssh/id_ed25519" ubuntu@PUBLIC_IP
```

7. List, then destroy. The first command reads Oracle and prints the resource IDs saved in the state file. It does not delete. Region and compartment come from that file. An instance named `discord-bot` is listed as preserved even if it carries this deployment's tag or the same display name. `--yes` deletes only the saved IDs. `--include-unrecorded` is required before a tagged resource that is missing from the state file can be deleted.

```sh
pnpm destroy:oci --config /absolute/path/oci-provisioner/config
pnpm destroy:oci --config /absolute/path/oci-provisioner/config --yes
```

If destroy reports `NETWORK_IN_USE`, another instance still has a VNIC in the saved subnet. The saved instance is already terminated. The VCN is left in place until that VNIC is gone.

Exit codes: 0 means the dry run or the operation finished, 2 means the launch was refused or a tagged resource could not be removed safely, and 1 means the inputs or a request failed. Save command output under `.work/` and do not commit it.
