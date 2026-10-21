package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Shared code for the four simulated clouds (see SimCloud).
 * To go live, replace a subclass's methods with real SDK calls, e.g. for AWS:
 *   createVm   -> Ec2Client.runInstances(...) with clientToken = idempotencyKey
 *   describeVm -> Ec2Client.describeInstances(...) and map the instance state
 *   deleteVm   -> Ec2Client.terminateInstances(...)
 */
public abstract class SimulatedProvider implements ProviderActivities {

    private final Logger log = LoggerFactory.getLogger(getClass());
    private final SimCloud cloud;

    protected SimulatedProvider(SimCloud cloud) {
        this.cloud = cloud;
    }

    protected abstract String providerName();

    protected abstract String idPrefix();

    @Override
    public ProviderPlan plan(VmSpec spec) {
        return ProviderCatalog.plan(spec);
    }

    @Override
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        String vmId = cloud.create(providerName(), idPrefix(), spec.name(), idempotencyKey);
        log.debug("[{}] create {} -> {}", providerName(), spec.name(), vmId);
        return vmId;
    }

    @Override
    public VmStatus describeVm(String vmId) {
        return cloud.describe(vmId);
    }

    @Override
    public void deleteVm(String vmId) {
        log.info("[{}] delete {} (compensation)", providerName(), vmId);
        cloud.delete(vmId);
    }
}
