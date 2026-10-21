package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import io.temporal.activity.Activity;
import io.temporal.failure.ApplicationFailure;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A pretend cloud, so the whole flow runs on your PC with no cloud account.
 * Replace a subclass's methods with real SDK calls to go live, e.g.
 * AWS SDK for Java v2 Ec2Client.runInstances(...) with a clientToken.
 *
 * Tip: name a VM with "fail" in it ("called fail-test") to watch the saga
 * roll back a half-built VM.
 */
public abstract class SimulatedProvider implements ProviderActivities {

    private final Logger log = LoggerFactory.getLogger(getClass());

    /** idempotencyKey -> vmId, so a retried create never makes two VMs. */
    private final Map<String, String> createdByKey = new ConcurrentHashMap<>();

    protected abstract String idPrefix();

    @Override
    public ProviderPlan plan(VmSpec spec) {
        ProviderPlan plan = ProviderCatalog.plan(spec);
        log.info("[{}] plan: {}", spec.provider(), plan.summary());
        return plan;
    }

    @Override
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        String vmId = createdByKey.computeIfAbsent(idempotencyKey,
                k -> idPrefix() + UUID.randomUUID().toString().substring(0, 8));
        log.info("[{}] create {} -> {}", spec.provider(), spec.name(), vmId);
        sleep(1500);
        return vmId;
    }

    @Override
    public String waitUntilReady(String vmId, String vmName) {
        for (int i = 1; i <= 3; i++) {
            sleep(1000);
            Activity.getExecutionContext().heartbeat(i);   // "still alive" ping to Temporal
        }
        if (vmName != null && vmName.contains("fail")) {
            throw ApplicationFailure.newNonRetryableFailure(
                    "Simulated boot failure for " + vmId, "SimulatedBootFailure");
        }
        int last = Math.abs(vmId.hashCode() % 250) + 2;
        return "10.20.0." + last;
    }

    @Override
    public void deleteVm(String vmId) {
        log.info("[{}] delete {} (compensation)", idPrefix(), vmId);
        createdByKey.values().remove(vmId);
        sleep(500);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
