package com.example.vmintent.workflow;

/**
 * Task queues. Workers poll these; to scale out, run more worker processes on the same queues.
 *
 * Each cloud has two queues so they can have different rate limits:
 *   aws-q       calls that change things (create, delete). Strict limit, like a real cloud API.
 *   aws-read-q  calls that only look (plan, describe). Looser limit.
 */
public final class TaskQueues {
    public static final String INTENT = "intent-q";

    public static final String VSPHERE = "vsphere-q";
    public static final String AWS = "aws-q";
    public static final String AZURE = "azure-q";
    public static final String GCP = "gcp-q";

    public static final String VSPHERE_READ = "vsphere-read-q";
    public static final String AWS_READ = "aws-read-q";
    public static final String AZURE_READ = "azure-read-q";
    public static final String GCP_READ = "gcp-read-q";

    public static final String[] PROVIDERS = {"vsphere", "aws", "azure", "gcp"};

    private TaskQueues() {}

    /** Queue for create and delete calls. */
    public static String forProvider(String provider) {
        return provider + "-q";
    }

    /** Queue for plan and status calls. */
    public static String readQueue(String provider) {
        return provider + "-read-q";
    }
}
