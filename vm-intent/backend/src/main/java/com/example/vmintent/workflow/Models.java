package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.spec.VmSpec;

import java.util.List;

/** Small data records passed into and out of workflows and activities. */
public final class Models {
    private Models() {}

    public record IntentRequest(String text, String userId, String channel) {}

    /** requestId = the IntentWorkflow that asked for it, or null for the legacy JSON API. */
    public record ReconcileRequest(VmSpec spec, String specHash, String requestedBy, String requestId) {}

    /** How a provider translates the abstract spec into its own names. */
    public record ProviderPlan(String nativeRegion, String nativeSize, String nativeImage, String summary) {}

    public record VmResult(String vmId, String ipAddress, String provider,
                           String nativeRegion, String nativeSize, String nativeImage) {}

    public record RequestStatus(String requestId, String state, String message,
                                Interpretation interpretation, VmResult vm, List<String> history) {}

    public record VmRecord(String specHash, VmSpec spec, String state, String detail,
                           VmResult result, String updatedAt) {}
}
