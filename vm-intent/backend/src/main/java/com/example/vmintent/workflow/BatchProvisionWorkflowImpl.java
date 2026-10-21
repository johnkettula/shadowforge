package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.BatchInfo;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.BatchRequest;
import com.example.vmintent.workflow.Models.ShardProgress;
import com.example.vmintent.workflow.Models.ShardRequest;
import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.ParentClosePolicy;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Async;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Promise;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class BatchProvisionWorkflowImpl implements BatchProvisionWorkflow {

    private final RecordActivities records = Workflow.newActivityStub(
            RecordActivities.class,
            ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(10)).build());

    private String batchId;
    private int total;
    private final List<String> shardIds = new ArrayList<>();
    private int shardsDone;
    private long startedAt;
    private long finishedAt;
    private String state = "STARTING";

    /** Shard IDs are fixed by the batch ID, so the API can find them before the workflow has run. */
    public static String shardId(String batchId, int shardNo) {
        return batchId + "-shard-" + shardNo;
    }

    @Override
    public BatchInfo run(BatchRequest request) {
        batchId = Workflow.getInfo().getWorkflowId();
        total = request.items().size();
        startedAt = Workflow.currentTimeMillis();
        int shardSize = Math.max(1, request.shardSize());
        records.audit(batchId, null, "BATCH_STARTED", request.requestedBy(),
                total + " VMs in shards of " + shardSize);

        List<Promise<ShardProgress>> shards = new ArrayList<>();
        int shardNo = 0;
        for (int from = 0; from < total; from += shardSize) {
            List<BatchItem> slice = new ArrayList<>(request.items().subList(from, Math.min(total, from + shardSize)));
            String id = shardId(batchId, shardNo);
            shardIds.add(id);
            BatchShardWorkflow shard = Workflow.newChildWorkflowStub(
                    BatchShardWorkflow.class,
                    ChildWorkflowOptions.newBuilder()
                            .setWorkflowId(id)
                            .setTaskQueue(TaskQueues.INTENT)
                            // If the batch is stopped, its shards (and VMs) keep going.
                            .setParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON)
                            .build());
            int maxInFlight = Math.max(1, request.maxInFlightPerShard());
            shards.add(Async.function(shard::run,
                    new ShardRequest(batchId, shardNo, slice, maxInFlight, request.requestedBy())));
            shardNo++;
        }
        state = "RUNNING";

        int running = 0, failed = 0, duplicate = 0;
        for (Promise<ShardProgress> p : shards) {
            ShardProgress done = p.get();
            shardsDone++;
            running += done.running();
            failed += done.failed();
            duplicate += done.duplicate();
        }
        finishedAt = Workflow.currentTimeMillis();
        state = "COMPLETED";
        records.audit(batchId, null, "BATCH_COMPLETED", "system",
                running + " running, " + failed + " failed, " + duplicate + " duplicates in "
                        + (finishedAt - startedAt) / 1000 + " s");
        return info();
    }

    @Override
    public BatchInfo info() {
        return new BatchInfo(batchId, total, List.copyOf(shardIds), shardsDone, startedAt, finishedAt, state);
    }
}
