package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import io.temporal.activity.ActivityInterface;

/**
 * The one interface every cloud adapter implements. Adding a fifth
 * provider = one new class + one task queue; no workflow changes.
 */
@ActivityInterface
public interface ProviderActivities {

    /** Translate abstract values (us-east, 4 vCPU/16 GiB) into provider names. */
    ProviderPlan plan(VmSpec spec);

    /** Must be idempotent: the same key never creates a second VM. */
    String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey);

    /** Waits for boot and returns the IP address. */
    String waitUntilReady(String vmId, String vmName);

    void deleteVm(String vmId);
}
