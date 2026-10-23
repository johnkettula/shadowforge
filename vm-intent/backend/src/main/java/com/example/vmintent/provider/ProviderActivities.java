package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.activity.ActivityInterface;

import java.util.List;

/**
 * The one interface every cloud adapter implements. Adding a fifth
 * provider = one new class + two task queues; no workflow changes.
 *
 * Every call is short. Nothing here waits for a VM to boot: the workflow
 * calls describeVm() now and then and sleeps in between. A sleeping workflow
 * holds no worker thread, which is what lets thousands of builds run at once.
 */
@ActivityInterface
public interface ProviderActivities {

    /** Translate abstract values (us-east, 4 vCPU/16 GiB) into provider names. */
    ProviderPlan plan(VmSpec spec);

    /**
     * Ask the cloud to start building the VM and return its ID straight away.
     * Must be idempotent: the same key never creates a second VM (real clouds
     * call this a client token or request ID).
     */
    String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey);

    /** One quick status check: PENDING, RUNNING (with IP) or FAILED. */
    VmStatus describeVm(String vmId);

    void deleteVm(String vmId);

    // ---- After the build ("day 2"). Each is one short call, like the others.

    /** Change the VM's size. Real clouds stop the VM, change its type and start it again. */
    void resizeVm(String vmId, int vcpu, int memoryGiB);

    /** Power the VM on (true) or off (false). */
    void setPower(String vmId, boolean on);

    /** Take a snapshot and return its ID. */
    String snapshotVm(String vmId, String label);

    /** IDs of every VM this cloud has that isn't deleted. Used by the nightly inventory check. */
    List<String> listVmIds();
}
