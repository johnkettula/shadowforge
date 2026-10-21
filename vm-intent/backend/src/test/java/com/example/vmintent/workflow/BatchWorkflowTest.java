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
    private FakeCloud cloud;
    private FakeRecords records;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new FakeCloud();
        records = new FakeRecords();

        Worker intent = env.newWorker(TaskQueues.INTENT);
        intent.registerWorkflowImplementationTypes(
                BatchProvisionWorkflowImpl.class, BatchShardWorkflowImpl.class, VmReconcileWorkflowImpl.class);
        intent.registerActivitiesImplementations(records);
        for (String p : TaskQueues.PROVIDERS) {
            env.newWorker(TaskQueues.forProvider(p)).registerActivitiesImplementations(cloud);
            env.newWorker(TaskQueues.readQueue(p)).registerActivitiesImplementations(cloud);
        }
        env.start();
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

    // ------------------------------------------------------------------ helpers and fakes

    private static BatchItem item(String name, int i) {
        String provider = TaskQueues.PROVIDERS[i % TaskQueues.PROVIDERS.length];
        String region = "vsphere".equals(provider) ? "dc1" : "us-east";
        VmSpec spec = new VmSpec(name, provider, region, 2, 4, "ubuntu", "24.04", 80, "ssd", "test", 1, false);
        return new BatchItem(spec, SpecCanonicalizer.hash(spec));
    }

    /** A cloud where every VM is running on the second status check, unless its name contains "fail". */
    static class FakeCloud implements ProviderActivities {
        final AtomicInteger created = new AtomicInteger();
        final AtomicInteger throttleFirstCreates = new AtomicInteger();
        final Map<String, String> vmIdByKey = new ConcurrentHashMap<>();
        final Map<String, String> nameById = new ConcurrentHashMap<>();
        final Map<String, AtomicInteger> checks = new ConcurrentHashMap<>();
        final Set<String> deleted = ConcurrentHashMap.newKeySet();

        @Override
        public ProviderPlan plan(VmSpec spec) {
            return ProviderCatalog.plan(spec);
        }

        @Override
        public String createVm(VmSpec spec, ProviderPlan plan, String key) {
            if (throttleFirstCreates.getAndDecrement() > 0) {
                throw ApplicationFailure.newFailure("Simulated throttling", "Throttled");
            }
            return vmIdByKey.computeIfAbsent(key, k -> {
                created.incrementAndGet();
                String id = "vm-" + k.substring(0, 8);
                nameById.put(id, spec.name());
                return id;
            });
        }

        @Override
        public VmStatus describeVm(String vmId) {
            int n = checks.computeIfAbsent(vmId, k -> new AtomicInteger()).incrementAndGet();
            if (n < 2) return new VmStatus("PENDING", null, "booting");
            if (nameById.get(vmId).contains("fail")) return new VmStatus("FAILED", null, "boot failed");
            return new VmStatus("RUNNING", "10.0.0." + n, "running");
        }

        @Override
        public void deleteVm(String vmId) {
            deleted.add(vmId);
        }
    }

    /** Remembers audit events instead of writing them to Postgres. */
    static class FakeRecords implements RecordActivities {
        final Map<String, Set<String>> hashesByEvent = new ConcurrentHashMap<>();

        @Override
        public void save(String specHash, VmSpec spec, String state, String detail, VmResult result) {}

        @Override
        public void audit(String requestId, String specHash, String event, String actor, String detail) {
            if (specHash != null) hashesByEvent.computeIfAbsent(event, e -> ConcurrentHashMap.newKeySet()).add(specHash);
        }

        int count(String event) {
            return hashesByEvent.getOrDefault(event, Set.of()).size();
        }
    }
}
