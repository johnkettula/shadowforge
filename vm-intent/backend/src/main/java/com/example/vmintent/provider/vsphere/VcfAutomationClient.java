package com.example.vmintent.provider.vsphere;

import com.fasterxml.jackson.databind.JsonNode;
import io.swagger.v3.oas.annotations.media.Schema;
import io.temporal.failure.ApplicationFailure;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.example.vmintent.provider.vsphere.HttpJson.q;

/**
 * The parts of the VCF Automation 9 APIs (the VM Apps organization's Automation APIs, the same shape as
 * Aria Automation 8.x) vm-intent uses.
 *
 *   sign in      VCF Automation 9: POST /tm/oauth/tenant/{org}/token   (grant_type=refresh_token, the API token)
 *                Aria Automation 8.x:  POST /iaas/api/login             ({"refreshToken": ...})
 *   projects     GET  /iaas/api/projects
 *   blueprints   GET  /blueprint/api/blueprints, /{id}/versions, /{id}/inputs-schema
 *   deploy       POST /blueprint/api/blueprint-requests                 -> request ID and deployment ID
 *   request      GET  /blueprint/api/blueprint-requests/{id}
 *   deployments  GET  /deployment/api/deployments[/{id}[/resources]], DELETE /deployment/api/deployments/{id}
 *   day 2        POST /deployment/api/resources/{resource}/requests     ({"actionId": ..., "inputs": ...})
 *
 * The access token lasts an hour; it's renewed a minute early, and once more if a call is refused with 401.
 */
public class VcfAutomationClient {

    private final VsphereProperties.Automation cfg;
    private final HttpJson http;
    private final java.util.function.LongSupplier clock;
    private volatile String token;
    private volatile long tokenExpiresAt;
    private volatile String projectId;

    public VcfAutomationClient(VsphereProperties.Automation cfg) {
        this(cfg, System::currentTimeMillis);
    }

    VcfAutomationClient(VsphereProperties.Automation cfg, java.util.function.LongSupplier clock) {
        this.cfg = cfg;
        this.clock = clock;
        this.http = new HttpJson("VCF Automation", cfg.url(), cfg.caFile(), cfg.timeoutSeconds());
    }

    // ------------------------------------------------------------------ sign-in

    private synchronized String signIn() {
        if ("iaas-login".equals(cfg.auth())) {
            JsonNode r = http.check(http.send("POST", "/iaas/api/login", Map.of("refreshToken", cfg.apiToken()), Map.of()),
                    "POST", "/iaas/api/login").body();
            token = r.path("token").asText();
            tokenExpiresAt = clock.getAsLong() + 25 * 60_000L;
        } else {
            String path = "/tm/oauth/tenant/" + q(cfg.org()) + "/token";
            Map<String, String> form = new LinkedHashMap<>();
            form.put("grant_type", "refresh_token");
            form.put("refresh_token", cfg.apiToken());
            JsonNode r = http.check(http.send("POST", path, new HttpJson.Form(form), Map.of()), "POST", path).body();
            token = r.path("access_token").asText();
            long seconds = r.path("expires_in").asLong(3600);
            tokenExpiresAt = clock.getAsLong() + Math.max(60, seconds - 60) * 1000L;
        }
        if (token == null || token.isBlank()) {
            throw ApplicationFailure.newNonRetryableFailure("VCF Automation sign-in returned no token", "CloudAuth");
        }
        return token;
    }

    private String bearer() {
        String t = token;
        return t != null && clock.getAsLong() < tokenExpiresAt ? t : signIn();
    }

    JsonNode call(String method, String path, Object body) {
        String p = withVersion(path);
        String t = bearer();
        HttpJson.Response r = http.send(method, p, body, Map.of("Authorization", "Bearer " + t));
        if (r.status() == 401) {
            synchronized (this) {
                if (t.equals(token)) signIn();
            }
            r = http.send(method, p, body, Map.of("Authorization", "Bearer " + token));
        }
        return http.check(r, method, p).body();
    }

    Optional<JsonNode> callOrMissing(String method, String path, Object body) {
        try {
            return Optional.of(call(method, path, body));
        } catch (ApplicationFailure e) {
            if ("NotFound".equals(e.getType())) return Optional.empty();
            throw e;
        }
    }

    private String withVersion(String path) {
        if (!(path.startsWith("/blueprint/") || path.startsWith("/deployment/") || path.startsWith("/iaas/api/projects"))) return path;
        return path + (path.contains("?") ? "&" : "?") + "apiVersion=" + q(cfg.apiVersion());
    }

    // ------------------------------------------------------------------ projects and blueprints

    /** The configured project's ID (the setting may be its name or its ID). */
    public String projectId() {
        if (projectId != null) return projectId;
        String p = cfg.project();
        if (p == null || p.isBlank()) throw ApplicationFailure.newNonRetryableFailure("vmintent.vsphere.automation.project isn't set", "InvalidSpec");
        for (JsonNode n : pages("/iaas/api/projects")) {
            if (p.equals(n.path("id").asText()) || p.equals(n.path("name").asText())) {
                projectId = n.path("id").asText();
                return projectId;
            }
        }
        throw ApplicationFailure.newNonRetryableFailure("VCF Automation has no project '" + p + "' that this token can see", "InvalidSpec");
    }

    /** Every item of a paged list ("content" + "totalPages" or "numberOfElements"). */
    List<JsonNode> pages(String path) {
        List<JsonNode> out = new ArrayList<>();
        for (int page = 0; page < 50; page++) {
            JsonNode r = call("GET", path + (path.contains("?") ? "&" : "?") + "page=" + page + "&size=200", null);
            JsonNode content = r.has("content") ? r.get("content") : r;
            content.forEach(out::add);
            int total = r.path("totalPages").asInt(1);
            if (!r.has("content") || page + 1 >= total || content.isEmpty()) break;
        }
        return out;
    }

    /** Named VsphereBlueprint in the OpenAPI document, so it isn't confused with the catalog's Blueprint. */
    @Schema(name = "VsphereBlueprint", description = "A VCF Automation blueprint (cloud template).")
    public record Blueprint(String id, String name, String description, String status, String projectId) {}

    public List<Blueprint> blueprints() {
        List<Blueprint> out = new ArrayList<>();
        for (JsonNode n : pages("/blueprint/api/blueprints?projects=" + q(projectId()))) {
            out.add(new Blueprint(n.path("id").asText(), n.path("name").asText(), n.path("description").asText(""),
                    n.path("status").asText(""), n.path("projectId").asText("")));
        }
        return out;
    }

    public Blueprint blueprint(String nameOrId) {
        for (Blueprint b : blueprints()) if (b.id().equals(nameOrId) || b.name().equals(nameOrId)) return b;
        throw ApplicationFailure.newNonRetryableFailure("Project '" + cfg.project() + "' has no blueprint '" + nameOrId + "'", "NotFound");
    }

    /** Released versions, newest first. */
    public List<String> releasedVersions(String blueprintId) {
        List<JsonNode> versions = new ArrayList<>(pages("/blueprint/api/blueprints/" + q(blueprintId) + "/versions?status=RELEASED"));
        versions.removeIf(v -> v.has("status") && !"RELEASED".equals(v.path("status").asText()));
        versions.sort((a, b) -> b.path("createdAt").asText("").compareTo(a.path("createdAt").asText("")));
        List<String> out = new ArrayList<>();
        for (JsonNode v : versions) out.add(v.path("version").asText(v.path("id").asText()));
        return out;
    }

    /** The blueprint's inputs (a JSON Schema "properties" object). */
    public JsonNode inputsSchema(String blueprintId) {
        return call("GET", "/blueprint/api/blueprints/" + q(blueprintId) + "/inputs-schema", null);
    }

    // ------------------------------------------------------------------ deployments

    public record Requested(String requestId, String deploymentId) {}

    public Requested requestDeployment(String blueprintId, String version, String deploymentName, Map<String, Object> inputs, String reason) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("blueprintId", blueprintId);
        if (version != null && !version.isBlank()) body.put("blueprintVersion", version);
        body.put("projectId", projectId());
        body.put("deploymentName", deploymentName);
        body.put("description", reason);
        body.put("reason", reason);
        body.put("inputs", inputs);
        JsonNode r = call("POST", "/blueprint/api/blueprint-requests", body);
        return new Requested(r.path("id").asText(), r.path("deploymentId").asText());
    }

    public record RequestInfo(String status, String failure) {}

    public Optional<RequestInfo> request(String requestId) {
        return callOrMissing("GET", "/blueprint/api/blueprint-requests/" + q(requestId), null)
                .map(n -> new RequestInfo(n.path("status").asText(), n.path("failureMessage").asText(null)));
    }

    public record Resource(String id, String name, String type, String address, String powerState, int cpuCount, long memoryMB) {}

    public record Deployment(String id, String name, String status, String failure, List<Resource> resources) {
        public boolean failed() {
            return status.endsWith("_FAILED");
        }

        public boolean inProgress() {
            return status.endsWith("_INPROGRESS") || status.isBlank();
        }

        public Optional<Resource> machine() {
            return resources.stream().filter(r -> r.type().endsWith(".Machine")).findFirst();
        }
    }

    public Optional<Deployment> deployment(String id) {
        Optional<JsonNode> d = callOrMissing("GET", "/deployment/api/deployments/" + q(id), null);
        if (d.isEmpty()) return Optional.empty();
        List<Resource> resources = new ArrayList<>();
        for (JsonNode r : pages("/deployment/api/deployments/" + q(id) + "/resources")) {
            JsonNode p = r.path("properties");
            resources.add(new Resource(r.path("id").asText(), r.path("name").asText(), r.path("type").asText(""),
                    p.path("address").asText(""), p.path("powerState").asText(""), p.path("cpuCount").asInt(),
                    p.path("totalMemoryMB").asLong()));
        }
        JsonNode n = d.get();
        String failure = n.path("lastRequest").path("details").asText(null);
        return Optional.of(new Deployment(n.path("id").asText(), n.path("name").asText(), n.path("status").asText(""), failure, resources));
    }

    /** The project's deployment with exactly this name, if any (not counting deleted ones). */
    public Optional<String> findDeployment(String name) {
        for (JsonNode n : pages("/deployment/api/deployments?projects=" + q(projectId()) + "&search=" + q(name))) {
            if (name.equals(n.path("name").asText()) && !"DELETE_SUCCESSFUL".equals(n.path("status").asText())) {
                return Optional.of(n.path("id").asText());
            }
        }
        return Optional.empty();
    }

    public List<String> deploymentIds() {
        List<String> out = new ArrayList<>();
        for (JsonNode n : pages("/deployment/api/deployments?projects=" + q(projectId()))) {
            if (!"DELETE_SUCCESSFUL".equals(n.path("status").asText())) out.add(n.path("id").asText());
        }
        return out;
    }

    /** Asks for the deployment to be removed (and everything in it). Already gone = nothing to do. */
    public void deleteDeployment(String id) {
        callOrMissing("DELETE", "/deployment/api/deployments/" + q(id), null);
    }

    /** A day-2 action on one resource, e.g. Cloud.vSphere.Machine.PowerOff. Returns the request ID. */
    public String resourceAction(String resourceId, String actionId, Map<String, Object> inputs, String reason) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("actionId", actionId);
        body.put("inputs", inputs);
        body.put("reason", reason);
        return call("POST", "/deployment/api/resources/" + q(resourceId) + "/requests", body).path("id").asText();
    }
}
