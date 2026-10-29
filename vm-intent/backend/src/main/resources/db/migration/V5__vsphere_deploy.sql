-- vCenter deploys vm-intent started (see provider/vsphere/DeployJournal.java).
-- vm_key = "<datacenter>:<vm name>"; vm = vCenter's VM ID (vm-123) once the VM exists.
CREATE TABLE IF NOT EXISTS vsphere_deploy (
    vm_key          text PRIMARY KEY,
    idempotency_key text,
    task_id         text,
    vm              text,
    tagged          boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
