package com.example.vmintent.workflow;

import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.intent.RuleBasedIntentExtractor;
import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.provider.ProviderCatalog;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.InventoryFinding;
import com.example.vmintent.workflow.Models.InventoryReport;
import com.example.vmintent.workflow.Models.LinkOrder;
import com.example.vmintent.workflow.Models.LinkReply;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.Route;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmResult;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.client.WorkflowClient;
import io.temporal.failure.ApplicationFailure;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Stand-ins for the clouds, the database and the one-way link, so the real workflows can run in
 * Temporal's in-memory test server. Timers are skipped there: a 30-day expiry takes milliseconds.
 */
public final class TestFakes {

    private TestFakes() {}

    /** Registers every workflow and these fakes on the right task queues, and starts the workers. */
    public static void startWorkers(TestWorkflowEnvironment env, FakeCloud cloud, FakeRecords records, LinkActivities link) {
        Worker intent = env.newWorker(TaskQueues.INTENT);
        intent.registerWorkflowImplementationTypes(IntentWorkflowImpl.class, VmReconcileWorkflowImpl.class,
                VmLifecycleWorkflowImpl.class, BatchProvisionWorkflowImpl.class, BatchShardWorkflowImpl.class,
                InventoryCheckWorkflowImpl.class);
        intent.registerActivitiesImplementations(records, link, new FakeIntent(records), new FakeInventory(records));
        for (String p : TaskQueues.PROVIDERS) {
            ProviderActivities view = cloud.view(p);
            env.newWorker(TaskQueues.forProvider(p)).registerActivitiesImplementations(view);
            env.newWorker(TaskQueues.readQueue(p)).registerActivitiesImplementations(view);
        }
        env.start();
    }

    public static VmSpec spec(String name, String provider, int ttlDays) {
        String region = "vsphere".equals(provider) ? "dc1" : "us-east";
        return new VmSpec(name, provider, region, 2, 4, "ubuntu", "24.04", 80, "ssd", "test", ttlDays, false);
    }

    static BatchItem item(String name, int i) {
        VmSpec spec = spec(name, TaskQueues.PROVIDERS[i % TaskQueues.PROVIDERS.length], 1);
        return new BatchItem(spec, SpecCanonicalizer.hash(spec));
    }

    /** A cloud where every VM is running on the second status check, unless its name contains "fail" or is in failNames. */
    public static class FakeCloud implements ProviderActivities {
        /** Names of VMs that fail to boot, so one VM of a request can fail while the others run. */
        final Set<String> failNames = ConcurrentHashMap.newKeySet();
        final AtomicInteger created = new AtomicInteger();
        final AtomicInteger throttleFirstCreates = new AtomicInteger();
        final Map<String, String> vmIdByKey = new ConcurrentHashMap<>();
        final Map<String, String> nameById = new ConcurrentHashMap<>();
        final Map<String, String> providerById = new ConcurrentHashMap<>();
        final Map<String, AtomicInteger> checks = new ConcurrentHashMap<>();
        final Set<String> deleted = ConcurrentHashMap.newKeySet();
        final List<String> calls = new CopyOnWriteArrayList<>();
        /** VMs that vanish from the cloud without us (for the inventory check). */
        final Set<String> vanished = ConcurrentHashMap.newKeySet();
        /** VMs someone made by hand in AWS (orphans). */
        final List<String> extra = new CopyOnWriteArrayList<>();
        volatile boolean refuseResize;

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
                // "vm-" + the start of the spec hash, + the build part of the key if there is one.
                String id = "vm-" + k.substring(0, 8) + (k.length() > 65 ? "-" + k.substring(65) : "");
                nameById.put(id, spec.name());
                providerById.put(id, spec.provider());
                return id;
            });
        }

        @Override
        public VmStatus describeVm(String vmId) {
            int n = checks.computeIfAbsent(vmId, k -> new AtomicInteger()).incrementAndGet();
            if (n < 2) return new VmStatus("PENDING", null, "booting");
            String name = nameById.get(vmId);
            if (name.contains("fail") || failNames.contains(name)) return new VmStatus("FAILED", null, "boot failed");
            return new VmStatus("RUNNING", "10.0.0." + n, "running");
        }

        @Override
        public void deleteVm(String vmId) {
            calls.add("delete " + vmId);
            deleted.add(vmId);
        }

        @Override
        public void resizeVm(String vmId, int vcpu, int memoryGiB) {
            if (refuseResize) throw ApplicationFailure.newNonRetryableFailure("No capacity for that size", "InvalidSpec");
            calls.add("resize " + vmId + " " + vcpu + "/" + memoryGiB);
        }

        @Override
        public void setPower(String vmId, boolean on) {
            calls.add("power " + vmId + " " + (on ? "on" : "off"));
        }

        @Override
        public String snapshotVm(String vmId, String label) {
            calls.add("snapshot " + vmId + " " + label);
            return "snap-" + label;
        }

        @Override
        public List<String> listVmIds() {
            throw new UnsupportedOperationException("use view(provider)");
        }

        List<String> listVmIds(String provider) {
            List<String> ids = new ArrayList<>();
            for (String id : nameById.keySet()) {
                if (provider.equals(providerById.get(id)) && !deleted.contains(id) && !vanished.contains(id)) ids.add(id);
            }
            if (provider.equals("aws")) ids.addAll(extra);
            Collections.sort(ids);
            return ids;
        }

        /** This cloud as one provider sees it: the same VMs, but listVmIds only shows that provider's. */
        ProviderActivities view(String provider) {
            FakeCloud all = this;
            return new ProviderActivities() {
                public ProviderPlan plan(VmSpec spec) { return all.plan(spec); }
                public String createVm(VmSpec spec, ProviderPlan plan, String key) { return all.createVm(spec, plan, key); }
                public VmStatus describeVm(String vmId) { return all.describeVm(vmId); }
                public void deleteVm(String vmId) { all.deleteVm(vmId); }
                public void resizeVm(String vmId, int vcpu, int mem) { all.resizeVm(vmId, vcpu, mem); }
                public void setPower(String vmId, boolean on) { all.setPower(vmId, on); }
                public String snapshotVm(String vmId, String label) { return all.snapshotVm(vmId, label); }
                public List<String> listVmIds() { return all.listVmIds(provider); }
            };
        }
    }

    /** Remembers what would go to Postgres. */
    public static class FakeRecords implements RecordActivities {
        final Map<String, Set<String>> hashesByEvent = new ConcurrentHashMap<>();
        final List<String> events = new CopyOnWriteArrayList<>();
        final Map<String, String> state = new ConcurrentHashMap<>();
        final Map<String, VmResult> results = new ConcurrentHashMap<>();
        final Map<String, VmLifecycle> lifecycles = new ConcurrentHashMap<>();

        @Override
        public void save(String specHash, VmSpec spec, String st, String detail, VmResult result) {
            state.put(specHash, st);
            if (result != null) results.put(specHash, result);
        }

        @Override
        public void audit(String requestId, String specHash, String event, String actor, String detail) {
            events.add(event + " " + actor + " " + detail);
            if (specHash != null) hashesByEvent.computeIfAbsent(event, e -> ConcurrentHashMap.newKeySet()).add(specHash);
        }

        @Override
        public void saveLifecycle(String specHash, String st, VmLifecycle lifecycle) {
            lifecycles.put(specHash, lifecycle);
            if (st != null) state.put(specHash, st);
        }

        int count(String event) {
            return hashesByEvent.getOrDefault(event, Set.of()).size();
        }

        boolean has(String eventPrefix) {
            return events.stream().anyMatch(e -> e.startsWith(eventPrefix));
        }
    }

    /** The real interpreter (rules only), and duplicates looked up in FakeRecords. */
    static class FakeIntent implements IntentActivities {
        private final IntentInterpreter interpreter = new IntentInterpreter(new RuleBasedIntentExtractor());
        private final FakeRecords records;

        FakeIntent(FakeRecords records) {
            this.records = records;
        }

        @Override
        public Interpretation interpret(String text) {
            return interpreter.interpret(text);
        }

        @Override
        public String findExistingVm(String specHash) {
            String st = records.state.get(specHash);
            if ("RUNNING".equals(st)) return records.results.get(specHash).vmId();
            if ("PROVISIONING".equals(st)) return "provisioning";
            return null;
        }

        @Override
        public List<BatchItem> expand(Interpretation it) {
            List<BatchItem> items = new ArrayList<>();
            for (int i = 1; i <= it.vmCount(); i++) {
                VmSpec s = it.spec().withName(String.format("%s-%02d", it.spec().name(), i));
                items.add(new BatchItem(s, SpecCanonicalizer.hash(s)));
            }
            return items;
        }
    }

    /** Compares FakeCloud with FakeRecords, like InventoryActivitiesImpl does with Postgres. */
    static class FakeInventory implements InventoryActivities {
        private final FakeRecords records;
        final List<InventoryReport> reports = new CopyOnWriteArrayList<>();

        FakeInventory(FakeRecords records) {
            this.records = records;
        }

        @Override
        public InventoryFinding compare(String provider, List<String> cloudVmIds) {
            Set<String> inCloud = new HashSet<>(cloudVmIds);
            Set<String> known = new HashSet<>();
            List<String> missing = new ArrayList<>();
            int running = 0;
            for (Map.Entry<String, VmResult> e : records.results.entrySet()) {
                if (!provider.equals(e.getValue().provider())) continue;
                known.add(e.getValue().vmId());
                if (!"RUNNING".equals(records.state.get(e.getKey()))) continue;
                running++;
                if (!inCloud.contains(e.getValue().vmId())) {
                    missing.add(e.getKey());
                    records.state.put(e.getKey(), "MISSING");
                }
            }
            List<String> orphans = cloudVmIds.stream().filter(id -> !known.contains(id)).toList();
            return new InventoryFinding(provider, "", running, cloudVmIds.size(), missing, orphans);
        }

        @Override
        public void saveReport(InventoryReport report) {
            reports.add(report);
        }
    }

    /**
     * The one-way link. route() says which clouds are behind it; send() records each order and, if
     * autoAnswer is on, answers it the way domain 3 would, through the linkReply signal.
     */
    public static class FakeLink implements LinkActivities {
        final Set<String> oneWay = ConcurrentHashMap.newKeySet();
        final List<LinkOrder> sent = new CopyOnWriteArrayList<>();
        volatile boolean autoAnswer = true;
        volatile WorkflowClient client;

        @Override
        public Route route(String provider) {
            return oneWay.contains(provider) ? new Route(true, 60) : Route.DIRECT;
        }

        @Override
        public ProviderPlan planHere(VmSpec spec) {
            return ProviderCatalog.plan(spec);
        }

        @Override
        public void send(LinkOrder order) {
            sent.add(order);
            if (!autoAnswer || client == null) return;
            boolean fail = order.spec() != null && order.spec().name().contains("fail");
            LinkReply reply = new LinkReply(order.orderId(), order.type(), !fail,
                    order.vmId() != null ? order.vmId() : "d3-" + order.idempotencyKey().substring(0, 6),
                    "172.20.0.9", fail ? "boot failed in domain 3" : "ok");
            // Answer straight away, while this activity still runs: the test server skips time whenever
            // nothing is running, so an answer that came "a moment later" would arrive after the timeout.
            answer(order.replyTo(), reply);
        }

        void answer(String workflowId, LinkReply reply) {
            client.newUntypedWorkflowStub(workflowId).signal("linkReply", reply);
        }

        long count(String type) {
            return sent.stream().filter(o -> o.type().equals(type)).count();
        }
    }
}
