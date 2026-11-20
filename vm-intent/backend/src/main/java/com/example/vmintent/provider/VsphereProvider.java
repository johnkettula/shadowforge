package com.example.vmintent.provider;

import com.example.vmintent.provider.vsphere.VcenterBackend;
import com.example.vmintent.provider.vsphere.VcfaBackend;
import com.example.vmintent.provider.vsphere.VsphereProperties;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * VMware vSphere. Polls "vsphere-q" (create/delete) and "vsphere-read-q" (plan/describe).
 *
 * Each datacenter (dc1, dc2) has a route (vmintent.vsphere, see docs/VSPHERE.md):
 *   simulated       the pretend cloud (the default)
 *   vcenter         vCenter 9: deploy from a VM template in a content library  (VM IDs "vcenter:dc1:name")
 *   vcf-automation  VCF Automation 9: request a blueprint deployment            (VM IDs "vcfa:<deployment>")
 * The build is chosen by the spec's datacenter; later calls by the VM ID, so a VM keeps its route even
 * if the setting changes afterwards.
 */
@Component
@ActivityImpl(taskQueues = {TaskQueues.VSPHERE, TaskQueues.VSPHERE_READ})
public class VsphereProvider extends SimulatedProvider {

    private final VsphereRoutes routes;

    public VsphereProvider(SimCloud cloud, VsphereRoutes routes) {
        super(cloud);
        this.routes = routes;
    }

    @Override
    protected String providerName() {
        return "vsphere";
    }

    @Override
    protected String idPrefix() {
        return "vm-";
    }

    private String route(VmSpec spec) {
        return routes.routeFor(spec.region());
    }

    @Override
    public ProviderPlan plan(VmSpec spec) {
        return switch (route(spec)) {
            case VsphereProperties.VCENTER -> routes.vcenter().plan(spec);
            case VsphereProperties.VCF_AUTOMATION -> routes.automation().plan(spec);
            default -> super.plan(spec);
        };
    }

    @Override
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        return switch (route(spec)) {
            case VsphereProperties.VCENTER -> routes.vcenter().createVm(spec, idempotencyKey);
            case VsphereProperties.VCF_AUTOMATION -> routes.automation().createVm(spec, idempotencyKey);
            default -> super.createVm(spec, plan, idempotencyKey);
        };
    }

    @Override
    public VmStatus describeVm(String vmId) {
        if (VcenterBackend.owns(vmId)) return routes.vcenter().describeVm(vmId);
        if (VcfaBackend.owns(vmId)) return routes.automation().describeVm(vmId);
        return super.describeVm(vmId);
    }

    @Override
    public void deleteVm(String vmId) {
        if (VcenterBackend.owns(vmId)) routes.vcenter().deleteVm(vmId);
        else if (VcfaBackend.owns(vmId)) routes.automation().deleteVm(vmId);
        else super.deleteVm(vmId);
    }

    @Override
    public void resizeVm(String vmId, int vcpu, int memoryGiB) {
        if (VcenterBackend.owns(vmId)) routes.vcenter().resizeVm(vmId, vcpu, memoryGiB);
        else if (VcfaBackend.owns(vmId)) routes.automation().resizeVm(vmId, vcpu, memoryGiB);
        else super.resizeVm(vmId, vcpu, memoryGiB);
    }

    @Override
    public void setPower(String vmId, boolean on) {
        if (VcenterBackend.owns(vmId)) routes.vcenter().setPower(vmId, on);
        else if (VcfaBackend.owns(vmId)) routes.automation().setPower(vmId, on);
        else super.setPower(vmId, on);
    }

    @Override
    public String snapshotVm(String vmId, String label) {
        if (VcenterBackend.owns(vmId)) return routes.vcenter().snapshotVm(vmId, label);
        if (VcfaBackend.owns(vmId)) return routes.automation().snapshotVm(vmId, label);
        return super.snapshotVm(vmId, label);
    }

    @Override
    public List<String> listVmIds() {
        List<String> ids = new ArrayList<>(super.listVmIds());
        if (routes.hasVcenter()) ids.addAll(routes.vcenter().listVmIds());
        if (routes.hasAutomation()) ids.addAll(routes.automation().listVmIds());
        return ids;
    }
}
