# vSphere: vCenter 9 and VCF Automation 9 blueprints

Last updated 2026-11-09.

A vSphere request (`provider: vsphere`, region `dc1` or `dc2`) can be built three ways. Each
datacenter has its own **route**:

| Route | What vm-intent does | VM IDs look like |
|---|---|---|
| `simulated` (default) | The built-in pretend cloud. Nothing real is touched. | `vm-3f2a9c41d07e` |
| `vcenter` | Calls **vCenter 9** directly: deploys a VM template from a content library, places it, sizes it, customizes the guest, powers it on and tags it | `vcenter:dc1:app-db-01` |
| `vcf-automation` | Requests a **VCF Automation 9 blueprint** (cloud template) deployment with inputs from the spec, and tracks it | `vcfa:<deployment ID>` |

The build workflow, rollback, lifecycle (expiry, renewals, resize, power, snapshots,
decommissioning) and the nightly inventory check work the same way on every route. A VM keeps the
route it was built with: later calls go by its ID, even if you change the setting.

There is also a catalog step, **`blueprint.deploy`**, for any blueprint, including ones that build
several machines (see below).

## Turn it on

All settings are under `vmintent.vsphere` in `application.yml`. The secrets go in environment
variables, never in the file:

```yaml
vmintent:
  vsphere:
    route: simulated                       # the default for datacenters without their own route
    vcenter:
      url: https://vcenter.example.com      # VMINTENT_VCENTER_URL
      username: svc-vmintent@vsphere.local  # VMINTENT_VCENTER_USER
      password: ...                         # VMINTENT_VCENTER_PASSWORD
      ca-file: /etc/vm-intent/vcenter-ca.pem   # VMINTENT_VCENTER_CA_FILE; empty = the JVM's trusted CAs
      content-library: vm-intent-templates
    automation:
      url: https://vcfa.example.com         # VMINTENT_VCFA_URL
      org: vm-apps                          # VMINTENT_VCFA_ORG: the VM Apps organization (tenant)
      api-token: ...                        # VMINTENT_VCFA_API_TOKEN
      project: vm-intent                    # VMINTENT_VCFA_PROJECT: name or ID
    datacenters:
      dc1:
        route: vcenter
        datacenter: Datacenter-1
        cluster: Cluster-A                  # or resource-pool: Pool-1, or host: esx-01
        folder: vm-intent
        datastores: { ssd: vsanDatastore, standard: nfs-datastore-01 }
        templates: { ubuntu-24.04: tpl-ubuntu-2404, rhel-9: tpl-rhel-9, windows-2022: tpl-win2022 }
        customization-specs: { ubuntu: linux-dhcp, rhel: linux-dhcp, windows: windows-dhcp }
      dc2:
        route: vcf-automation
        blueprint: vm-intent-standard        # or per OS: blueprints: { windows: win-server }
        blueprint-version: ""                # empty = the newest released version
        blueprint-inputs:
          cpuCount: "{vcpu}"
          totalMemoryMB: "{memoryMiB}"
          image: "{os}-{osVersion}"
          diskGB: "{diskGiB}"
          env: "{env}"
```

Then check it: `GET /api/v2/vsphere/status` signs in to both and reports what it found (OPERATOR
role).

```json
{"defaultRoute":"simulated","datacenters":{"dc1":"vcenter","dc2":"vcf-automation"},
 "vcenter":{"configured":true,"ok":true,"detail":"signed in; ownership tag vm-intent/managed ready"},
 "automation":{"configured":true,"ok":true,"detail":"signed in; project proj-7"}}
```

A datacenter routed to something that isn't set up fails its builds straight away with a message
saying which setting is missing. It never quietly falls back to the simulation.

## vCenter 9

### How a build goes

| Step | API call |
|---|---|
| Sign in | `POST /api/session` (basic auth); the session is reused and renewed when it expires |
| Find the template | `POST /api/content/library?action=find`, `POST /api/content/library/item?action=find` |
| Find the placement | `GET /api/vcenter/folder`, `/cluster` (or `/resource-pool`, `/host`), `/datastore`, filtered to the datacenter |
| Deploy | `POST /api/vcenter/vm-template/library-items/{item}?action=deploy&vmw-task=true` with the name, placement, datastore, `hardware_customization` (vCPU, memory), `guest_customization` and `powered_on: true`. It returns a task at once. |
| Wait | The build workflow checks every few seconds (a Temporal timer, so no thread waits): `GET /api/vcenter/vm?names=&folders=`, then the task (`GET /api/cis/tasks/{task}`) while the VM isn't there yet |
| Running | Once the VM is on and VMware Tools reports an address (`GET /api/vcenter/vm/{vm}/guest/identity`) |
| Mark it as ours | Tag `vm-intent/managed` (created on first use): `/api/cis/tagging/...` |

Day 2:
- **Resize:** `PATCH .../hardware/cpu` and `.../hardware/memory`. The VM is powered off first and back on afterwards.
- **Power:** `POST .../power?action=start|stop`.
- **Snapshot:** the VI JSON API, `POST /sdk/vim25/{release}/VirtualMachine/{vm}/CreateSnapshot_Task`, which accepts the same session.
- **Remove:** power off, then `DELETE /api/vcenter/vm/{vm}`.
- **Inventory check:** lists every VM with the tag.

### What makes it safe

- **Idempotent by name.** vCenter has no client token, so a VM's name in the folder is its identity.
  A retried create finds the deploy it already started (kept in the `vsphere_deploy` table, so every
  worker and a restart see it). A VM with that name and vm-intent's tag is the one it built.
- **Never touches what it didn't build.** A VM with the same name *without* the tag stops the build ("choose another name"), and vm-intent won't remove it.
- **Failures come back with vCenter's reason**, for example "Insufficient resources in cluster…", and the build rolls back. A removal while the clone is still running cancels the clone.
- **Busy or unreachable vCenter** (429, 502–504, timeouts) is retried with backoff for up to 30 minutes, like a throttled cloud. Bad settings and refused permissions are not retried.

### Templates, datastores, customization

- `templates` picks a content-library **VM template** by `os-version`, then `os-major`, then `os`.
  For example, RHEL 9.4 tries `rhel-9.4`, then `rhel-9`, then `rhel`.
- `datastores` maps the spec's disk tier (`ssd`, `standard`) to a datastore.
- `customization-specs` (optional) names a guest customization spec per OS (hostname, network).
- The disk size and the network come from the template. `diskGiB` is not applied to vCenter builds
  yet.

### The service account's permissions

Make a role with these privileges and give it to the account on the datacenter (propagated):

- **Content library:** Deploy templates, Read storage
- **Virtual machine:** Inventory (create from existing, remove), Configuration (change CPU count, change memory), Interaction (power on, power off), Snapshot management (create), Provisioning (customize guest, deploy template, read customization specifications)
- **Datastore:** Allocate space
- **Resource:** Assign virtual machine to resource pool
- **Network:** Assign network
- **vSphere Tagging:** Assign or unassign vSphere tag, create vSphere tag, create vSphere tag category. Alternatively, create `vm-intent/managed` yourself and leave out the two "create" privileges.

## VCF Automation 9 blueprints

### Sign-in

1. Sign in to the **VM Apps organization** as the service user (it needs at least the *user* service role in the project).
2. Open **My Account > API Tokens > New** and copy the token. It is shown only once and lasts 90 days by default.
3. vm-intent exchanges it for an access token: `POST /tm/oauth/tenant/{org}/token` (`grant_type=refresh_token`). The access token lasts an hour and is renewed before it runs out.

For **Aria Automation 8.x**, set `auth: iaas-login`. vm-intent then signs in with `POST /iaas/api/login`, and the rest is the same.

### How a build goes

| Step | API call |
|---|---|
| Find the project and blueprint | `GET /iaas/api/projects`, `GET /blueprint/api/blueprints?projects=` |
| Pick the version | `blueprint-version`, or the newest **released** one (`GET /blueprint/api/blueprints/{id}/versions`) |
| Deploy | `POST /blueprint/api/blueprint-requests` with `deploymentName` = the VM's name and the inputs from `blueprint-inputs` |
| Wait | `GET /deployment/api/deployments/{id}` and `/resources`, until `CREATE_SUCCESSFUL` and the machine has an address |

- **Inputs:** `blueprint-inputs` values are templates filled from the spec: `{vcpu}`, `{memoryGiB}`, `{memoryMiB}` (or `{memoryMB}`), `{diskGiB}`, `{diskTier}`, `{os}`, `{osVersion}`, `{env}`, `{name}`, `{ttlDays}`. A value that comes out as a whole number, or `true`/`false`, is sent as that type. Name each input the way your blueprint's input schema does: `GET /api/v2/vsphere/blueprints/{name}` lists them.
- **Day 2** uses the machine resource's actions (`POST /deployment/api/resources/{id}/requests`): `Cloud.vSphere.Machine.PowerOn`, `.PowerOff`, `.Resize` (`cpuCount`, `totalMemoryMB`), `.Snapshot.Create`.
- **Remove:** `DELETE /deployment/api/deployments/{id}`.
- **Inventory check:** lists the project's deployments.
- **Idempotent** by deployment name in the project: a retried create finds the deployment it already asked for.
- **API versions:** blueprint and deployment calls send `apiVersion=2019-09-12` (setting `automation.api-version`).

### The `blueprint.deploy` catalog step

For blueprints that are more than one VM (an app stack, a VM with its network and load balancer),
use the step directly in a definition:

```yaml
steps:
  - id: stack
    action: blueprint.deploy
    with:
      blueprint: three-tier                  # name or ID
      version: "3"                           # optional; default = newest released
      name: "${ params.app + '-' + params.env }"   # the deployment's name (its identity)
      inputs: { size: "${ params.size }", owner: "${ run.requestedBy }" }
      timeoutMinutes: 90                     # optional (5-1440, default 90)
      everySeconds: 30                       # optional, how often to look (10-600)
```

- **Output** (for later steps): `deploymentId`, `name`, `status`, `blueprint`, `version`,
  `resources` (`id`, `name`, `type`, `address`) and `addresses`.
- **Tear down** removes the deployment and waits until it's gone.
- **Partial work:** a deployment with that name that is running or done is used, not asked for twice. A failed one is removed first, then asked for again.

The machines a blueprint builds belong to VCF Automation. vm-intent doesn't add them to its own
inventory or lifecycle, so `files.copy` and the other VM steps can't be pointed at them.

## Finding what's there

| | |
|---|---|
| `GET /api/v2/vsphere/status` | routes, and whether vCenter and VCF Automation answer |
| `GET /api/v2/vsphere/templates` | the VM templates in the content library |
| `GET /api/v2/vsphere/blueprints` | the project's blueprints |
| `GET /api/v2/vsphere/blueprints/{name}` | one blueprint's released versions and inputs |

All need the OPERATOR role. Templates answer 503 when vCenter isn't set up, blueprints 503 when VCF
Automation isn't (the `error` says which settings are missing); a sign-in the backend refuses is 502, and
an unknown blueprint 404.

## How it's tested

`provider/vsphere/MockVcenter` and `MockVcfa` (in the tests) are small in-process HTTP servers. Each
holds state: VMs, tasks, tags and sessions, or tokens, projects, blueprints, versions, deployments
and resources. They follow the rules that matter: sign in first, power off before a cold resize or
removal, and an IP only once Tools reports one. Everything runs against them, through the real
build and catalog workflows:

- `VcenterBackendTest`, `VcfaBackendTest`: every call and rule above.
- `VsphereRoutesWorkflowTest`: a dc1 build through vCenter and a dc2 build through a blueprint, each with a failed build rolled back, and a catalog run with `blueprint.deploy` torn down.
- `VsphereControllerTest`: the status codes of the endpoints above: 503 when vCenter or VCF
  Automation isn't set up, 404 for an unknown blueprint, 502 for a sign-in the backend refuses, and a
  status response that leaves out empty fields.

They have not been run against a real vCenter 9 or VCF Automation 9. For the first real try, use a
test folder, then:
1. Call `GET /api/v2/vsphere/status`.
2. Build one small VM.
3. Resize it, power it off and on, snapshot it, then decommission it.
