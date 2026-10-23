package com.example.vmintent.workflow;

import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.provider.ProviderCatalog;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.BatchInfo;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.BatchRequest;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.ShardProgress;
import com.example.vmintent.workflow.Models.ShardRequest;
import com.example.vmintent.workflow.Models.VmResult;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.client.WorkflowOptions;
import io.temporal.failure.ApplicationFailure;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Runs the real batch, shard and VM workflows in Temporal's in-memory test server.
 * Timers are skipped, so minutes of "boot time" take milliseconds. The cloud and the
 * database are small fakes.
 */
class BatchWorkflowTest {

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
        TestFakes.startWorkers(env, cloud, records, new TestFakes.FakeLink());
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void batchBuildsEveryVmAndRollsBackFailures() {
        List<BatchItem> items = new ArrayList<>();
        for (int i = 0; i < 12; i++) items.add(item((i < 2 ? "fail-" : "ok-") + i, i));

        BatchProvisionWorkflow batch = env.getWorkflowClient().newWorkflowStub(BatchProvisionWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("batch-test").build());
        BatchInfo info = batch.run(new BatchRequest("batch-test", items, 5, 3, "test"));

        assertEquals("COMPLETED", info.state());
        assertEquals(3, info.shardIds().size(), "12 VMs in shards of 5 = 3 shards");
        int running = 0, failed = 0, peak = 0;
        for (String id : info.shardIds()) {
            ShardProgress p = env.getWorkflowClient().newWorkflowStub(BatchShardWorkflow.class, id).progress();
            running += p.running();
            failed += p.failed();
            peak = Math.max(peak, p.peakInFlight());
        }
        assertEquals(10, running);
        assertEquals(2, failed);
        assertTrue(peak <= 3, "a shard never builds more than maxInFlight at once");
        assertEquals(12, cloud.created.get(), "one VM per item");
        assertEquals(2, cloud.deleted.size(), "both failed VMs were rolled back");
        assertEquals(12, records.count("PROVISIONING"));
        assertEquals(10, records.count("RUNNING"));
        assertEquals(2, records.count("ROLLED_BACK"));
    }

    @Test
    void identicalSpecIsBuiltOnceAndCountedAsDuplicate() {
        BatchItem same = item("twin", 0);
        BatchShardWorkflow shard = env.getWorkflowClient().newWorkflowStub(BatchShardWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("shard-dup").build());
        ShardProgress p = shard.run(new ShardRequest("batch-dup", 0, List.of(same, same), 2, "test"));

        assertEquals(1, p.running());
        assertEquals(1, p.duplicate());
        assertEquals(0, p.failed());
        assertEquals(1, cloud.created.get());
        assertEquals(1, records.count("DUPLICATE"));
    }

    @Test
    void throttledCloudCallsAreRetried() {
        cloud.throttleFirstCreates.set(3);   // the first three create calls get "HTTP 429"
        BatchShardWorkflow shard = env.getWorkflowClient().newWorkflowStub(BatchShardWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("shard-throttle").build());
        ShardProgress p = shard.run(new ShardRequest("batch-throttle", 0,
                List.of(item("a", 1), item("b", 2)), 2, "test"));

        assertEquals(2, p.running());
        assertEquals(0, p.failed());
    }

    private static BatchItem item(String name, int i) {
        return TestFakes.item(name, i);
    }
}
