package com.example.vmintent.provider.vsphere;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A small stand-in for VCF Automation 9's Automation APIs (VM Apps org): sign-in with an API token,
 * projects, blueprints and versions, blueprint requests, deployments that finish after a few looks,
 * resources and day-2 actions. Records every call.
 */
public final class MockVcfa implements AutoCloseable {

    static final ObjectMapper JSON = new ObjectMapper();
    static final String API_TOKEN = "api-token-123";

    public static final class Dep {
        public final String id;
        public final String name;
        public final String blueprintId;
        public final JsonNode request;
        public String status = "CREATE_INPROGRESS";
        int looks;
        final List<Map<String, Object>> resources = new ArrayList<>();

        Dep(String id, String name, String blueprintId, JsonNode request) {
            this.id = id;
            this.name = name;
            this.blueprintId = blueprintId;
            this.request = request;
        }
    }

    public final Map<String, Dep> deployments = new ConcurrentHashMap<>();
    public final List<String> calls = new CopyOnWriteArrayList<>();
    public final List<JsonNode> actions = new CopyOnWriteArrayList<>();
    public final List<String> tokenGrants = new CopyOnWriteArrayList<>();
    public final Set<String> tokens = ConcurrentHashMap.newKeySet();
    public final Set<String> failNames = ConcurrentHashMap.newKeySet();
    final AtomicInteger ids = new AtomicInteger(1);
    /** A deployment is done after this many looks at it. */
    public volatile int looksToFinish = 2;
    public volatile boolean missingApiVersion;

    private final HttpServer server;

    public MockVcfa() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
        server.stop(0);
    }

    public Dep byName(String name) {
        return deployments.values().stream().filter(d -> d.name.equals(name)).findFirst().orElse(null);
    }

    private record Reply(int status, Object body) {}

    private void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getRawPath();
        String rawQuery = ex.getRequestURI().getRawQuery();
        Map<String, String> q = new HashMap<>();
        if (rawQuery != null) for (String p : rawQuery.split("&")) {
            int i = p.indexOf('=');
            q.put(URLDecoder.decode(i < 0 ? p : p.substring(0, i), StandardCharsets.UTF_8), i < 0 ? "" : URLDecoder.decode(p.substring(i + 1), StandardCharsets.UTF_8));
        }
        byte[] raw = ex.getRequestBody().readAllBytes();
        calls.add(method + " " + path + (rawQuery == null ? "" : "?" + rawQuery));
        Reply r;
        try {
            r = route(ex, method, path, q, raw);
        } catch (RuntimeException e) {
            r = new Reply(500, Map.of("message", e.toString()));
        }
        byte[] out = r.body() == null ? new byte[0] : JSON.writeValueAsBytes(r.body());
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(r.status(), out.length == 0 ? -1 : out.length);
        if (out.length > 0) ex.getResponseBody().write(out);
        ex.close();
    }

    private static Map<String, Object> page(List<?> items) {
        return Map.of("content", items, "totalPages", 1, "numberOfElements", items.size());
    }

    private static Matcher m(String regex, String path) {
        Matcher m = Pattern.compile(regex).matcher(path);
        return m.matches() ? m : null;
    }

    private Reply route(HttpExchange ex, String method, String path, Map<String, String> q, byte[] raw) throws IOException {
        Matcher x;
        if (method.equals("POST") && (x = m("/tm/oauth/tenant/([^/]+)/token", path)) != null) {
            String form = new String(raw, StandardCharsets.UTF_8);
            tokenGrants.add(x.group(1) + " " + form);
            if (!x.group(1).equals("vm-apps") || !form.contains("grant_type=refresh_token") || !form.contains("refresh_token=" + API_TOKEN)) {
                return new Reply(400, Map.of("error", "invalid_grant"));
            }
            String t = "access-" + ids.incrementAndGet();
            tokens.add(t);
            return new Reply(200, Map.of("access_token", t, "token_type", "Bearer", "expires_in", 3600));
        }
        if (method.equals("POST") && path.equals("/iaas/api/login")) {
            if (!API_TOKEN.equals(JSON.readTree(raw).path("refreshToken").asText())) return new Reply(400, Map.of("message", "bad token"));
            String t = "iaas-" + ids.incrementAndGet();
            tokens.add(t);
            return new Reply(200, Map.of("tokenType", "Bearer", "token", t));
        }
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        if (auth == null || !tokens.contains(auth.replace("Bearer ", ""))) return new Reply(401, Map.of("message", "Unauthorized"));
        if ((path.startsWith("/blueprint/") || path.startsWith("/deployment/")) && !q.containsKey("apiVersion")) missingApiVersion = true;

        if (method.equals("GET") && path.equals("/iaas/api/projects")) {
            return new Reply(200, page(List.of(Map.of("id", "proj-7", "name", "vm-intent"), Map.of("id", "proj-8", "name", "other"))));
        }
        if (method.equals("GET") && path.equals("/blueprint/api/blueprints")) {
            if (!"proj-7".equals(q.get("projects"))) return new Reply(200, page(List.of()));
            return new Reply(200, page(List.of(
                    Map.of("id", "bp-1", "name", "vm-intent-standard", "status", "RELEASED", "projectId", "proj-7", "description", "One VM"),
                    Map.of("id", "bp-2", "name", "three-tier", "status", "RELEASED", "projectId", "proj-7", "description", "Web, app, db"))));
        }
        if (method.equals("GET") && (x = m("/blueprint/api/blueprints/([^/]+)/versions", path)) != null) {
            return new Reply(200, page(List.of(
                    Map.of("id", x.group(1) + "-v1", "version", "1", "status", "RELEASED", "createdAt", "2026-01-10T00:00:00Z"),
                    Map.of("id", x.group(1) + "-v3", "version", "3", "status", "RELEASED", "createdAt", "2026-09-01T00:00:00Z"),
                    Map.of("id", x.group(1) + "-v4", "version", "4", "status", "VERSIONED", "createdAt", "2026-10-01T00:00:00Z"))));
        }
        if (method.equals("GET") && (x = m("/blueprint/api/blueprints/([^/]+)/inputs-schema", path)) != null) {
            return new Reply(200, Map.of("type", "object", "properties", Map.of("cpuCount", Map.of("type", "integer"),
                    "totalMemoryMB", Map.of("type", "integer"), "image", Map.of("type", "string"))));
        }
        if (method.equals("POST") && path.equals("/blueprint/api/blueprint-requests")) {
            JsonNode b = JSON.readTree(raw);
            String name = b.path("deploymentName").asText();
            if (byName(name) != null) return new Reply(400, Map.of("message", "Deployment name " + name + " already exists"));
            Dep d = new Dep("dep-" + ids.incrementAndGet(), name, b.path("blueprintId").asText(), b);
            deployments.put(d.id, d);
            return new Reply(202, Map.of("id", "req-" + ids.incrementAndGet(), "deploymentId", d.id, "status", "STARTED"));
        }
        if (method.equals("GET") && path.equals("/deployment/api/deployments")) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Dep d : deployments.values()) {
                if (q.containsKey("search") && !d.name.contains(q.get("search"))) continue;
                out.add(Map.of("id", d.id, "name", d.name, "status", d.status));
            }
            return new Reply(200, page(out));
        }
        if ((x = m("/deployment/api/deployments/([^/]+)", path)) != null) {
            Dep d = deployments.get(x.group(1));
            if (d == null) return new Reply(404, Map.of("message", "Deployment not found"));
            if (method.equals("DELETE")) {
                d.status = "DELETE_INPROGRESS";
                return new Reply(200, Map.of("id", "req-del-" + ids.incrementAndGet()));
            }
            if (d.status.equals("DELETE_INPROGRESS")) {
                deployments.remove(d.id);
                return new Reply(404, Map.of("message", "Deployment not found"));
            }
            if (d.status.equals("CREATE_INPROGRESS") && ++d.looks >= looksToFinish) finish(d);
            Map<String, Object> out = new LinkedHashMap<>(Map.of("id", d.id, "name", d.name, "status", d.status));
            if (d.status.equals("CREATE_FAILED")) out.put("lastRequest", Map.of("details", "Allocation failed: no placement for 64 vCPU"));
            return new Reply(200, out);
        }
        if (method.equals("GET") && (x = m("/deployment/api/deployments/([^/]+)/resources", path)) != null) {
            Dep d = deployments.get(x.group(1));
            return d == null ? new Reply(404, Map.of("message", "not found")) : new Reply(200, page(d.resources));
        }
        if (method.equals("POST") && (x = m("/deployment/api/resources/([^/]+)/requests", path)) != null) {
            JsonNode b = JSON.readTree(raw);
            actions.add(JSON.createObjectNode().put("resource", x.group(1)).put("actionId", b.path("actionId").asText()).set("inputs", b.path("inputs")));
            for (Dep d : deployments.values()) for (Map<String, Object> r : d.resources) {
                if (!r.get("id").equals(x.group(1))) continue;
                @SuppressWarnings("unchecked") Map<String, Object> p = (Map<String, Object>) r.get("properties");
                switch (b.path("actionId").asText()) {
                    case "Cloud.vSphere.Machine.PowerOff" -> p.put("powerState", "OFF");
                    case "Cloud.vSphere.Machine.PowerOn" -> p.put("powerState", "ON");
                    case "Cloud.vSphere.Machine.Resize" -> {
                        p.put("cpuCount", b.path("inputs").path("cpuCount").asInt());
                        p.put("totalMemoryMB", b.path("inputs").path("totalMemoryMB").asLong());
                    }
                    default -> {}
                }
            }
            return new Reply(200, Map.of("id", "act-" + ids.incrementAndGet()));
        }
        return new Reply(404, Map.of("message", "mock VCF Automation has no " + method + " " + path));
    }

    private void finish(Dep d) {
        if (failNames.contains(d.name)) {
            d.status = "CREATE_FAILED";
            return;
        }
        d.status = "CREATE_SUCCESSFUL";
        int machines = d.blueprintId.equals("bp-2") ? 3 : 1;
        for (int i = 0; i < machines; i++) {
            Map<String, Object> props = new ConcurrentHashMap<>(Map.of("address", "10.20.0." + (10 + i), "powerState", "ON",
                    "cpuCount", d.request.path("inputs").path("cpuCount").asInt(2), "totalMemoryMB", d.request.path("inputs").path("totalMemoryMB").asLong(4096)));
            d.resources.add(new LinkedHashMap<>(Map.of("id", d.id + "-res-" + i, "name", d.name + "-vm" + i, "type", "Cloud.vSphere.Machine", "properties", props)));
        }
        d.resources.add(new LinkedHashMap<>(Map.of("id", d.id + "-net", "name", "net", "type", "Cloud.vSphere.Network", "properties", Map.of())));
    }
}
