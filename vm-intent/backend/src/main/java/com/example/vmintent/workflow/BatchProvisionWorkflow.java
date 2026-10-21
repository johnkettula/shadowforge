package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.BatchInfo;
import com.example.vmintent.workflow.Models.BatchRequest;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/**
 * Builds many VMs at once (for example 2,000). Workflow ID = "batch-...".
 *
 * It splits the list into shards of a few hundred and starts one BatchShardWorkflow
 * per shard. Each shard starts one VmReconcileWorkflow per VM. Splitting keeps every
 * workflow's history small and stays well under Temporal's limit on how many child
 * workflows one workflow may have open at once (2,000 by default).
 */
@WorkflowInterface
public interface BatchProvisionWorkflow {

    @WorkflowMethod
    BatchInfo run(BatchRequest request);

    /** Shard IDs and overall state. The API asks each shard for its own counts. */
    @QueryMethod
    BatchInfo info();
}
