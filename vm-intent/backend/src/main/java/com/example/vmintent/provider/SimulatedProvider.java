package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;

/**
 * Shared code for the four simulated clouds (see SimCloud).
 * To go live, replace a subclass's methods with real SDK calls, e.g. for AWS:
 *   createVm   -> Ec2Client.runInstances(...) with clientToken = idempotencyKey
 *   describeVm -> Ec2Client.describeInstances(...) and map the instance state
 *   deleteVm   -> Ec2Client.terminateInstances(...)
 *   resizeVm   -> stopInstances, modifyInstanceAttribute(instanceType), startInstances
 *   setPower   -> startInstances / stopInstances
 *   snapshotVm -> createSnapshots(...) for the instance's volumes
 *   listVmIds  -> describeInstances(...) filtered on a "managed-by=vm-intent" tag
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

    @Override
    public void resizeVm(String vmId, int vcpu, int memoryGiB) {
        log.info("[{}] resize {} to {} vCPU / {} GiB", providerName(), vmId, vcpu, memoryGiB);
        cloud.resize(vmId, vcpu, memoryGiB);
    }

    @Override
    public void setPower(String vmId, boolean on) {
        log.info("[{}] power {} {}", providerName(), on ? "on" : "off", vmId);
        cloud.setPower(vmId, on);
    }

    @Override
    public String snapshotVm(String vmId, String label) {
        String id = cloud.snapshot(vmId, label);
        log.info("[{}] snapshot {} of {} ({})", providerName(), id, vmId, label);
        return id;
    }

    @Override
    public List<String> listVmIds() {
        return cloud.list(providerName());
    }
}
