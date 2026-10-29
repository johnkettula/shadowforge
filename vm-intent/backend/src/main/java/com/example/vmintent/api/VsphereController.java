package com.example.vmintent.api;

import com.example.vmintent.provider.vsphere.VcenterClient;
import com.example.vmintent.provider.vsphere.VcfAutomationClient;
import com.example.vmintent.provider.vsphere.VsphereProperties;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.temporal.failure.ApplicationFailure;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What vm-intent can reach in vSphere: is vCenter / VCF Automation set up and answering, which VM
 * templates the content library holds, which blueprints the project has and what inputs they take.
 * Read-only. OPERATOR role (see ApiAccessRules).
 */
@RestController
@ConditionalOnWebApplication
@RequestMapping("/api/v2/vsphere")
@Tag(name = "vSphere", description = "vCenter 9 and VCF Automation 9: routes, templates and blueprints")
public class VsphereController {

    private final VsphereRoutes routes;

    public VsphereController(VsphereRoutes routes) {
        this.routes = routes;
    }

    @GetMapping("/status")
    @Operation(summary = "How each datacenter is routed, and whether vCenter and VCF Automation answer")
    public Map<String, Object> status() {
        VsphereProperties p = routes.props();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("defaultRoute", p.route());
        Map<String, String> dcs = new LinkedHashMap<>();
        p.datacenters().keySet().forEach(dc -> dcs.put(dc, p.routeFor(dc)));
        out.put("datacenters", dcs);
        out.put("vcenter", check(routes.hasVcenter(), p.vcenter().url(), () -> {
            routes.vcenter().client().ownershipTag();
            return "signed in; ownership tag " + p.vcenter().tagCategory() + "/" + p.vcenter().tag() + " ready";
        }));
        out.put("automation", check(routes.hasAutomation(), p.automation().url(), () ->
                "signed in; project " + routes.automation().client().projectId()));
        return out;
    }

    private static Map<String, Object> check(boolean configured, String url, java.util.concurrent.Callable<String> probe) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("configured", configured);
        if (configured) {
            m.put("url", url);
            try {
                m.put("ok", true);
                m.put("detail", probe.call());
            } catch (Exception e) {
                m.put("ok", false);
                m.put("detail", e instanceof ApplicationFailure af ? af.getOriginalMessage() : e.getMessage());
            }
        }
        return m;
    }

    @GetMapping("/templates")
    @Operation(summary = "The VM templates in vCenter's content library (vmintent.vsphere.vcenter.content-library)")
    public List<VcenterClient.LibraryItem> templates() {
        return guard(() -> routes.vcenter().client().libraryItems(routes.props().vcenter().contentLibrary()));
    }

    @GetMapping("/blueprints")
    @Operation(summary = "The blueprints (cloud templates) in the VCF Automation project")
    public List<VcfAutomationClient.Blueprint> blueprints() {
        return guard(() -> routes.automation().client().blueprints());
    }

    @GetMapping("/blueprints/{nameOrId}")
    @Operation(summary = "One blueprint: its released versions and the inputs it takes")
    public Map<String, Object> blueprint(@PathVariable String nameOrId) {
        return guard(() -> {
            VcfAutomationClient c = routes.automation().client();
            VcfAutomationClient.Blueprint b = c.blueprint(nameOrId);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("blueprint", b);
            out.put("releasedVersions", c.releasedVersions(b.id()));
            JsonNode schema = c.inputsSchema(b.id());
            out.put("inputs", schema.has("properties") ? schema.get("properties") : schema);
            return out;
        });
    }

    private static <T> T guard(java.util.function.Supplier<T> call) {
        try {
            return call.get();
        } catch (ApplicationFailure e) {
            HttpStatus s = switch (e.getType()) {
                case "NotFound" -> HttpStatus.NOT_FOUND;
                case "InvalidSpec" -> HttpStatus.NOT_FOUND;
                case "CloudAuth" -> HttpStatus.BAD_GATEWAY;
                default -> HttpStatus.SERVICE_UNAVAILABLE;
            };
            throw new ResponseStatusException(s, e.getOriginalMessage());
        }
    }
}
