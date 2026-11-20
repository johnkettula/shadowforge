package com.example.vmintent.provider;

import com.example.vmintent.provider.vsphere.VcenterBackend;
import com.example.vmintent.provider.vsphere.VcfaBackend;
import com.example.vmintent.provider.vsphere.VsphereProperties;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * VMware vSphere. Polls "vsphere-q" (create/delete) and "vsphere-read-q" (plan/describe).
 *
 * Each datacenter (dc1, dc2) has a route (vmintent.vsphere, see docs/VSPHERE.md):
 *   simulated       the pretend cloud (the default)
 *   vcenter         vCenter 9: deploy from a VM template in a content library  (VM IDs "vcenter:dc1:name")
 *   vcf-automation  VCF Automation 9: request a blueprint deployment            (VM IDs "vcfa:<deployment>")
 * The build is chosen by the spec's datacenter; later calls by the VM ID, so a VM keeps its route even
 * if the setting changes afterwards (RoutedProvider does the dispatch).
 */
@Component
@ActivityImpl(taskQueues = {TaskQueues.VSPHERE, TaskQueues.VSPHERE_READ})
public class VsphereProvider extends RoutedProvider {

    private final VsphereRoutes routes;
    private final List<Backend> backends;

    public VsphereProvider(SimCloud cloud, VsphereRoutes routes) {
        super(cloud);
        this.routes = routes;
        this.backends = List.of(
                new Backend(VcenterBackend::owns, routes::hasVcenter, routes::vcenter),
                new Backend(VcfaBackend::owns, routes::hasAutomation, routes::automation));
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
    protected CloudBackend backendForBuild(VmSpec spec) {
        return switch (route(spec)) {
            case VsphereProperties.VCENTER -> routes.vcenter();
            case VsphereProperties.VCF_AUTOMATION -> routes.automation();
            default -> null;
        };
    }

    @Override
    protected List<Backend> backends() {
        return backends;
    }
}
