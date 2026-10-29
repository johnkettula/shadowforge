package com.example.vmintent.provider.vsphere;

import io.temporal.failure.ApplicationFailure;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Which vSphere backends are set up: vCenter, VCF Automation, both or neither. A datacenter routed
 * to a backend that isn't set up fails its builds with a clear message instead of silently simulating.
 */
public class VsphereRoutes {

    private final VsphereProperties props;
    private final VcenterBackend vcenter;
    private final VcfaBackend automation;

    public VsphereRoutes(VsphereProperties props, VcenterBackend vcenter, VcfaBackend automation) {
        this.props = props;
        this.vcenter = vcenter;
        this.automation = automation;
    }

    public VsphereProperties props() {
        return props;
    }

    public String routeFor(String dc) {
        return props.routeFor(dc);
    }

    public VcenterBackend vcenter() {
        if (vcenter == null) {
            throw ApplicationFailure.newNonRetryableFailure("vCenter isn't set up: set vmintent.vsphere.vcenter.url, username and password "
                    + "(VMINTENT_VCENTER_URL, VMINTENT_VCENTER_USER, VMINTENT_VCENTER_PASSWORD)", "InvalidSpec");
        }
        return vcenter;
    }

    public VcfaBackend automation() {
        if (automation == null) {
            throw ApplicationFailure.newNonRetryableFailure("VCF Automation isn't set up: set vmintent.vsphere.automation.url, org, api-token "
                    + "and project (VMINTENT_VCFA_URL, VMINTENT_VCFA_ORG, VMINTENT_VCFA_API_TOKEN, VMINTENT_VCFA_PROJECT)", "InvalidSpec");
        }
        return automation;
    }

    public boolean hasVcenter() {
        return vcenter != null;
    }

    public boolean hasAutomation() {
        return automation != null;
    }

    @Configuration
    @EnableConfigurationProperties(VsphereProperties.class)
    public static class Config {
        private static final Logger log = LoggerFactory.getLogger(VsphereRoutes.class);

        @Bean
        public VsphereRoutes vsphereRoutes(VsphereProperties props, JdbcClient jdbc) {
            VcenterBackend vc = null;
            VcfaBackend vcfa = null;
            if (props.vcenter().configured()) {
                vc = new VcenterBackend(props, new VcenterClient(props.vcenter()), new DeployJournal.Jdbc(jdbc));
                log.info("vSphere: vCenter at {} (content library {})", props.vcenter().url(), props.vcenter().contentLibrary());
            }
            if (props.automation().configured()) {
                vcfa = new VcfaBackend(props, new VcfAutomationClient(props.automation()));
                log.info("vSphere: VCF Automation at {} (org {}, project {})", props.automation().url(), props.automation().org(),
                        props.automation().project());
            }
            log.info("vSphere route: {} by default{}", props.route(), props.datacenters().isEmpty() ? "" : ", per datacenter "
                    + props.datacenters().keySet().stream().map(dc -> dc + "=" + props.routeFor(dc)).toList());
            return new VsphereRoutes(props, vc, vcfa);
        }
    }
}
