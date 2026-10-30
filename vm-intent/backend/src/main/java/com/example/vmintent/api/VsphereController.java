package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.ApiError;
import com.example.vmintent.provider.vsphere.VcenterClient;
import com.example.vmintent.provider.vsphere.VcfAutomationClient;
import com.example.vmintent.provider.vsphere.VsphereProperties;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
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
 * Read-only. OPERATOR role (see ApiAccessRules). 503 when the backend asked for isn't set up.
 */
@RestController
@ConditionalOnWebApplication
@RequestMapping("/api/v2/vsphere")
@Tag(name = "vSphere", description = "vCenter 9 and VCF Automation 9: routes, templates and blueprints")
public class VsphereController {

    private static final String NOT_SET_UP = "vSphere isn't set up on this server (vCenter for templates, VCF Automation for blueprints), or didn't answer";

    @Schema(description = "How each datacenter is routed, and whether vCenter and VCF Automation answer.")
    public record VsphereStatusResponse(
            @Schema(description = "The route for datacenters not listed: simulated, vcenter or vcf-automation.",
                    requiredMode = Schema.RequiredMode.REQUIRED, example = "simulated") String defaultRoute,
            @Schema(description = "Each configured datacenter and its route.", requiredMode = Schema.RequiredMode.REQUIRED)
            Map<String, String> datacenters,
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED) VsphereBackendStatus vcenter,
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED) VsphereBackendStatus automation) {}

    @Schema(description = "One vSphere backend. url, ok and detail are only there when it is configured.")
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record VsphereBackendStatus(
            @Schema(description = "Whether its address and credentials are set.", requiredMode = Schema.RequiredMode.REQUIRED)
            boolean configured,
            @Schema(description = "Its address.") String url,
            @Schema(description = "Whether signing in and the check worked.") Boolean ok,
            @Schema(description = "What the check found, or why it failed.") String detail) {}

    @Schema(description = "One VCF Automation blueprint, its released versions and the inputs it takes.")
    public record VsphereBlueprintResponse(
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED) VcfAutomationClient.Blueprint blueprint,
            @Schema(description = "The blueprint versions that are released and can be deployed.",
                    requiredMode = Schema.RequiredMode.REQUIRED) List<String> releasedVersions,
            @Schema(description = "The inputs it takes: the 'properties' object of its JSON Schema inputs schema, "
                    + "or the whole schema when that has no 'properties'. Free-form, as VCF Automation sends it.",
                    implementation = Map.class, additionalProperties = Schema.AdditionalPropertiesValue.TRUE,
                    requiredMode = Schema.RequiredMode.REQUIRED) JsonNode inputs) {}

    private final VsphereRoutes routes;

    public VsphereController(VsphereRoutes routes) {
        this.routes = routes;
    }

    @GetMapping("/status")
    @Operation(operationId = "getVsphereStatus", summary = "How each datacenter is routed, and whether vCenter and VCF Automation answer")
    @ApiResponse(responseCode = "200", description = "The routes and both backends")
    public VsphereStatusResponse status() {
        VsphereProperties p = routes.props();
        Map<String, String> dcs = new LinkedHashMap<>();
        p.datacenters().keySet().forEach(dc -> dcs.put(dc, p.routeFor(dc)));
        return new VsphereStatusResponse(p.route(), dcs,
                check(routes.hasVcenter(), p.vcenter().url(), () -> {
                    routes.vcenter().client().ownershipTag();
                    return "signed in; ownership tag " + p.vcenter().tagCategory() + "/" + p.vcenter().tag() + " ready";
                }),
                check(routes.hasAutomation(), p.automation().url(), () ->
                        "signed in; project " + routes.automation().client().projectId()));
    }

    private static VsphereBackendStatus check(boolean configured, String url, java.util.concurrent.Callable<String> probe) {
        if (!configured) return new VsphereBackendStatus(false, null, null, null);
        try {
            return new VsphereBackendStatus(true, url, true, probe.call());
        } catch (Exception e) {
            return new VsphereBackendStatus(true, url, false, e instanceof ApplicationFailure af ? af.getOriginalMessage() : e.getMessage());
        }
    }

    @GetMapping("/templates")
    @Operation(operationId = "listVsphereTemplates", summary = "The VM templates in vCenter's content library (vmintent.vsphere.vcenter.content-library)")
    @ApiResponse(responseCode = "200", description = "The templates")
    @ApiResponse(responseCode = "502", description = "vCenter refused the sign-in", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "503", description = NOT_SET_UP, content = @Content(schema = @Schema(implementation = ApiError.class)))
    public List<VcenterClient.LibraryItem> templates() {
        return guard(() -> routes.vcenter().client().libraryItems(routes.props().vcenter().contentLibrary()));
    }

    @GetMapping("/blueprints")
    @Operation(operationId = "listVsphereBlueprints", summary = "The blueprints (cloud templates) in the VCF Automation project")
    @ApiResponse(responseCode = "200", description = "The blueprints")
    @ApiResponse(responseCode = "502", description = "VCF Automation refused the sign-in", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "503", description = NOT_SET_UP, content = @Content(schema = @Schema(implementation = ApiError.class)))
    public List<VcfAutomationClient.Blueprint> blueprints() {
        return guard(() -> routes.automation().client().blueprints());
    }

    @GetMapping("/blueprints/{nameOrId}")
    @Operation(operationId = "getVsphereBlueprint", summary = "One blueprint: its released versions and the inputs it takes")
    @ApiResponse(responseCode = "200", description = "The blueprint")
    @ApiResponse(responseCode = "404", description = "The project has no blueprint with that name or ID", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "502", description = "VCF Automation refused the sign-in", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "503", description = NOT_SET_UP, content = @Content(schema = @Schema(implementation = ApiError.class)))
    public VsphereBlueprintResponse blueprint(@PathVariable String nameOrId) {
        return guard(() -> {
            VcfAutomationClient c = routes.automation().client();
            VcfAutomationClient.Blueprint b = c.blueprint(nameOrId);
            List<String> versions = c.releasedVersions(b.id());
            JsonNode schema = c.inputsSchema(b.id());
            return new VsphereBlueprintResponse(b, versions, schema.has("properties") ? schema.get("properties") : schema);
        });
    }

    private static <T> T guard(java.util.function.Supplier<T> call) {
        try {
            return call.get();
        } catch (ApplicationFailure e) {
            throw new ResponseStatusException(statusFor(e.getType()), e.getOriginalMessage());
        }
    }

    /** The HTTP status for a vSphere failure type: not set up, or anything unexpected, is 503. */
    static HttpStatus statusFor(String failureType) {
        if (failureType == null) return HttpStatus.SERVICE_UNAVAILABLE;
        return switch (failureType) {
            case VsphereRoutes.NOT_SET_UP -> HttpStatus.SERVICE_UNAVAILABLE;
            case "NotFound" -> HttpStatus.NOT_FOUND;
            case "CloudAuth" -> HttpStatus.BAD_GATEWAY;
            default -> HttpStatus.SERVICE_UNAVAILABLE;
        };
    }
}
