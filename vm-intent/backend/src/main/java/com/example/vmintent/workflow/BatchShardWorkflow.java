package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.ShardProgress;
import com.example.vmintent.workflow.Models.ShardRequest;
import io.temporal.workflow.QueryMethod;
import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;

/** Builds one shard of a batch: up to maxInFlight VMs at the same time. */
@WorkflowInterface
public interface BatchShardWorkflow {

    @WorkflowMethod
    ShardProgress run(ShardRequest request);

    @QueryMethod
    ShardProgress progress();
}
