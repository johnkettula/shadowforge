package com.example.vmintent.workflow;

/** One task queue for intent/orchestration work, one per cloud provider. */
public final class TaskQueues {
    public static final String INTENT = "intent-q";
    public static final String VSPHERE = "vsphere-q";
    public static final String AWS = "aws-q";
    public static final String AZURE = "azure-q";
    public static final String GCP = "gcp-q";

    private TaskQueues() {}

    public static String forProvider(String provider) {
        return provider + "-q";
    }
}
