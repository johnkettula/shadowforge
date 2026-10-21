package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import io.temporal.activity.ActivityInterface;

/** Non-deterministic work for IntentWorkflow (LLM calls, lookups). */
@ActivityInterface
public interface IntentActivities {

    Interpretation interpret(String text);

    /** Returns the VM ID (or "provisioning") if this spec already exists, else null. */
    String findExistingVm(String specHash);
}
