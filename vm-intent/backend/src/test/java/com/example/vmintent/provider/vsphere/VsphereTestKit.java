package com.example.vmintent.provider.vsphere;

import java.util.Map;

/** Mock vCenter (dc1) + mock VCF Automation (dc2), wired the way VsphereRoutes.Config would. For other test packages. */
public final class VsphereTestKit implements AutoCloseable {
    public final MockVcenter vcenter;
    public final MockVcfa vcfa;
    private final VsphereRoutes routes;

    public VsphereTestKit() throws Exception {
        MockVcenter vc = new MockVcenter();
        MockVcfa va = new MockVcfa();
        Map<String, VsphereProperties.Datacenter> dcs = Map.of(
                "dc1", VcenterBackendTest.props(vc.url()).datacenters().get("dc1"),
                "dc2", VcfaBackendTest.props(va.url(), null).datacenters().get("dc2"));
        VsphereProperties p = new VsphereProperties("simulated", VcenterBackendTest.props(vc.url()).vcenter(),
                VcfaBackendTest.props(va.url(), null).automation(), dcs);
        routes = new VsphereRoutes(p, new VcenterBackend(p, new VcenterClient(p.vcenter()), new DeployJournal.InMemory()),
                new VcfaBackend(p, new VcfAutomationClient(p.automation())));
        vcenter = vc;
        vcfa = va;
    }

    public VsphereRoutes routes() {
        return routes;
    }

    @Override
    public void close() {
        vcenter.close();
        vcfa.close();
    }
}
