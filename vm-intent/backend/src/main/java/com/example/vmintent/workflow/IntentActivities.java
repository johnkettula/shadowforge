package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.workflow.Models.BatchItem;
import io.temporal.activity.ActivityInterface;

import java.util.List;

/** Non-deterministic work for IntentWorkflow (LLM calls, lookups). */
@ActivityInterface
public interface IntentActivities {

    Interpretation interpret(String text);

    /** Returns the VM ID (or "provisioning") if this spec already exists, else null. */
    String findExistingVm(String specHash);

    /**
     * For a request for several VMs (count > 1): one spec per VM, named name-01, name-02, ...
     * Each has its own spec hash, so asking for the same set again finds them as duplicates.
     */
    List<BatchItem> expand(Interpretation interpretation);
}
