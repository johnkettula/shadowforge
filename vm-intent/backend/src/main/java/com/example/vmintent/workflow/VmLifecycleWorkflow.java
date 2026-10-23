package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.LifecycleRequest;
import com.example.vmintent.workflow.Models.VmLifecycle;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.SignalMethod;
import io.temporal.workflow.UpdateMethod;
import io.temporal.workflow.UpdateValidatorMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * One running VM, from the end of its build until it is removed. Workflow ID = "life-" + spec hash.
 *
 * It sleeps until the VM is about to expire, warns the owner, and removes the VM when the time
 * is up unless someone renews it. Changes after the build ("day 2") are updates: each one is
 * checked first by its validator (a refusal comes straight back and leaves no trace in the
 * history), then carried out, and the caller gets the new state back when it's done.
 *
 * Every update takes "actor" first: who is asking, for the audit trail.
 */
@WorkflowInterface
public interface VmLifecycleWorkflow extends LinkReceiver {

    @WorkflowMethod
    void run(LifecycleRequest request);

    @QueryMethod
    VmLifecycle status();

    /** Push the expiry back by this many days (1-90; no more than 365 days from now in total). */
    @UpdateMethod
    VmLifecycle renew(String actor, int days);

    @UpdateValidatorMethod(updateName = "renew")
    void validateRenew(String actor, int days);

    /** Change vCPU and memory. */
    @UpdateMethod
    VmLifecycle resize(String actor, int vcpu, int memoryGiB);

    @UpdateValidatorMethod(updateName = "resize")
    void validateResize(String actor, int vcpu, int memoryGiB);

    /** Power on (true) or off (false). */
    @UpdateMethod
    VmLifecycle power(String actor, boolean on);

    @UpdateValidatorMethod(updateName = "power")
    void validatePower(String actor, boolean on);

    /** Take a snapshot. label: lowercase letters, digits and dashes, up to 40. */
    @UpdateMethod
    VmLifecycle snapshot(String actor, String label);

    @UpdateValidatorMethod(updateName = "snapshot")
    void validateSnapshot(String actor, String label);

    /** Remove the VM now. */
    @UpdateMethod
    VmLifecycle decommission(String actor, String reason);

    @UpdateValidatorMethod(updateName = "decommission")
    void validateDecommission(String actor, String reason);

    /** The inventory check found the VM gone from its cloud: stop looking after it. */
    @SignalMethod
    void markMissing(String detail);
}
