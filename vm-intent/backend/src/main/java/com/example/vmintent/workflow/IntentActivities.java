package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.workflow.Models.BatchItem;
import io.temporal.activity.ActivityInterface;

import java.util.List;

/** Non-deterministic work for IntentWorkflow (LLM calls, lookups). */
@ActivityInterface
public interface IntentActivities {

    /**
     * owner = who the VM is for (see VmIdentity). Tasks scheduled before the owner was added have
     * no owner argument and read it as null = anonymous.
     */
    Interpretation interpret(String text, String owner);

    /** Returns the VM ID (or "provisioning") if this spec already exists, else null. */
    String findExistingVm(String specHash);

    /**
     * For a request for several VMs (count > 1): one spec per VM, named name-01, name-02, ...
     * Each has its own spec hash, so asking for the same set again finds them as duplicates.
     * owner as for interpret.
     */
    List<BatchItem> expand(Interpretation interpretation, String owner);
}
