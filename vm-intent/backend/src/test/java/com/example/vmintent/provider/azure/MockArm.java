package com.example.vmintent.provider.azure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A small stand-in for Entra ID's token endpoint and Azure Resource Manager, on 127.0.0.1: VMs, NICs and public
 * IPs in one resource group, with state, and with ARM's rules that matter (a bearer token on every call; an
 * api-version on every call; PUT and DELETE finish later, through an Azure-AsyncOperation URL whose status goes
 * InProgress -> Succeeded; a location on every PUT). Records every call so tests can check what was sent.
 */
public final class MockArm implements AutoCloseable {

    static final ObjectMapper JSON = new ObjectMapper();
    public static final String TENANT = "tenant-1";
    public static final String CLIENT_ID = "client-1";
    public static final String CLIENT_SECRET = "test-only-not-a-secret";
    public static final String SUBSCRIPTION = "sub-1";
    public static final String RESOURCE_GROUP = "rg-vmintent";
    static final Set<String> TYPES = Set.of("Microsoft.Compute/virtualMachines", "Microsoft.Network/networkInterfaces",
            "Microsoft.Network/publicIPAddresses");

    /** One running PUT or DELETE. */
    static final class Operation {
        String resourceId, failure, status = "InProgress";
        boolean delete;
        int pollsLeft;
    }

    /** Resources by ID (lower case, as ARM compares them), stored as ARM returns them. */
    public final Map<String, ObjectNode> resources = new ConcurrentHashMap<>();
    public final Map<String, Operation> operations = new ConcurrentHashMap<>();
    public final List<String> calls = new CopyOnWriteArrayList<>();
    /** The form of every token request, in order. */
    public final List<Map<String, String>> tokenRequests = new CopyOnWriteArrayList<>();
    public final Set<String> tokens = ConcurrentHashMap.newKeySet();
    final AtomicInteger ids = new AtomicInteger(100);
    /** How many polls of an operation answer InProgress before it ends. */
    public volatile int pollsUntilDone = 1;
    /** The Retry-After header sent with 429s and operations (seconds); null = none. */
    public volatile String retryAfter = "0";
    /** How long every ARM answer (not sign-in) is held before it is sent; zero = at once. */
    public volatile Duration responseDelay = Duration.ZERO;
    private volatile int failCount;
    private volatile int failStatus;
    private volatile String failNextOperation;

    private final HttpServer server;
    // Each exchange on its own thread, so a held answer neither blocks the next request nor close().
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "mock-arm");
        t.setDaemon(true);
        return t;
    });

    public MockArm() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::handle);
        server.setExecutor(pool);
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Override
    public void close() {
        server.stop(0);
        pool.shutdownNow();
    }

    /** Settings for an ArmClient that talks to this mock (both sign-in and ARM). */
    public AzureProperties properties() {
        return new AzureProperties(TENANT, CLIENT_ID, CLIENT_SECRET, SUBSCRIPTION, RESOURCE_GROUP, "westeurope", url(), url(), 5);
    }

    /** The next n ARM calls (not sign-ins) are answered with this status. */
    public void failNext(int n, int status) {
        failStatus = status;
        failCount = n;
    }

    /** The next PUT or DELETE starts, then its operation ends Failed with this message. */
    public void failNextOperation(String message) {
        failNextOperation = message;
    }

    public ObjectNode resource(String type, String name) {
        return resources.get(id(type, name).toLowerCase());
    }

    static String id(String type, String name) {
        return "/subscriptions/" + SUBSCRIPTION + "/resourceGroups/" + RESOURCE_GROUP + "/providers/" + type + "/" + name;
    }

    // ------------------------------------------------------------------ HTTP

    private record Reply(int status, Object body, Map<String, String> headers) {
        Reply(int status, Object body) {
            this(status, body, Map.of());
        }
    }

    private static Reply err(int status, String code, String message) {
        return new Reply(status, Map.of("error", Map.of("code", code, "message", message)));
    }

    private void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getRawPath();
        String rawQuery = ex.getRequestURI().getRawQuery();
        String raw = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        calls.add(method + " " + path + (rawQuery == null ? "" : "?" + rawQuery));
        Reply r;
        try {
            r = route(ex, method, path, form(rawQuery), raw);
        } catch (RuntimeException e) {
            r = err(500, "InternalServerError", e.toString());
        }
        if (!responseDelay.isZero() && !path.endsWith("/oauth2/v2.0/token")) {
            try {
                Thread.sleep(responseDelay.toMillis());
            } catch (InterruptedException e) {
                ex.close();   // closed down
                return;
            }
        }
        byte[] out = r.body() == null ? new byte[0] : JSON.writeValueAsBytes(r.body());
        ex.getResponseHeaders().add("Content-Type", "application/json");
        r.headers().forEach((k, v) -> ex.getResponseHeaders().add(k, v));
        ex.sendResponseHeaders(r.status(), out.length == 0 ? -1 : out.length);
        if (out.length > 0) ex.getResponseBody().write(out);
        ex.close();
    }

    private static Map<String, String> form(String q) {
        Map<String, String> m = new HashMap<>();
        if (q == null || q.isEmpty()) return m;
        for (String p : q.split("&")) {
            int i = p.indexOf('=');
            m.put(URLDecoder.decode(i < 0 ? p : p.substring(0, i), StandardCharsets.UTF_8),
                    i < 0 ? "" : URLDecoder.decode(p.substring(i + 1), StandardCharsets.UTF_8));
        }
        return m;
    }

    private Reply route(HttpExchange ex, String method, String path, Map<String, String> q, String raw) throws IOException {
        if (method.equals("POST") && path.equals("/" + TENANT + "/oauth2/v2.0/token")) {
            Map<String, String> f = form(raw);
            tokenRequests.add(f);
            if (!"client_credentials".equals(f.get("grant_type")) || !"https://management.azure.com/.default".equals(f.get("scope"))) {
                return new Reply(400, Map.of("error", "invalid_request", "error_description", "AADSTS900144: bad grant or scope"));
            }
            if (!CLIENT_ID.equals(f.get("client_id")) || !CLIENT_SECRET.equals(f.get("client_secret"))) {
                return new Reply(401, Map.of("error", "invalid_client", "error_description", "AADSTS7000215: Invalid client secret provided."));
            }
            String t = "token-" + ids.incrementAndGet();
            tokens.add(t);
            return new Reply(200, Map.of("token_type", "Bearer", "expires_in", 3599, "access_token", t));
        }
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        if (auth == null || !auth.startsWith("Bearer ") || !tokens.contains(auth.substring(7))) {
            return err(401, "AuthenticationFailed", "Authentication failed. The 'Authorization' header is missing or invalid.");
        }
        if (failCount > 0) {
            failCount--;
            Map<String, String> h = failStatus == 429 && retryAfter != null ? Map.of("Retry-After", retryAfter) : Map.of();
            String code = failStatus == 429 ? "TooManyRequests" : failStatus == 409 ? "Conflict" : "InternalServerError";
            return new Reply(failStatus, Map.of("error", Map.of("code", code,
                    "message", "mock failure " + failStatus)), h);
        }
        if (!q.containsKey("api-version")) return err(400, "MissingApiVersionParameter", "The api-version query parameter is required.");
        Matcher x = Pattern.compile("/subscriptions/[^/]+/providers/Microsoft\\.\\w+/locations/[^/]+/operations/([^/]+)").matcher(path);
        if (method.equals("GET") && x.matches()) return poll(x.group(1));
        x = Pattern.compile("/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/(\\w+\\.\\w+/\\w+)/([^/]+)").matcher(path);
        if (!x.matches()) return err(404, "NotFound", "mock ARM has no " + method + " " + path);
        if (!x.group(1).equals(SUBSCRIPTION) || !x.group(2).equalsIgnoreCase(RESOURCE_GROUP)) {
            return err(404, "ResourceGroupNotFound", "Resource group '" + x.group(2) + "' could not be found.");
        }
        String type = x.group(3);
        if (!TYPES.contains(type)) return err(400, "InvalidResourceType", "The resource type '" + type + "' could not be found.");
        String id = id(type, x.group(4));
        // Reading a resource while its operation runs counts as a poll of it: time passes, as on real ARM.
        if (method.equals("GET")) {
            operations.forEach((op, o) -> {
                if (o.resourceId.equalsIgnoreCase(id) && o.status.equals("InProgress")) poll(op);
            });
        }
        ObjectNode existing = resources.get(id.toLowerCase());
        switch (method) {
            case "GET" -> {
                return existing == null ? err(404, "ResourceNotFound", "The Resource '" + type + "/" + x.group(4) + "' was not found.")
                        : new Reply(200, existing);
            }
            case "PUT" -> {
                JsonNode body = raw.isBlank() ? JSON.createObjectNode() : JSON.readTree(raw);
                if (!body.path("location").isTextual()) return err(400, "LocationRequired", "The location property is required for this definition.");
                ObjectNode res = JSON.createObjectNode();
                res.put("id", id).put("name", x.group(4)).put("type", type).put("location", body.path("location").asText());
                res.set("tags", body.path("tags").isObject() ? body.get("tags") : JSON.createObjectNode());
                ObjectNode props = body.path("properties").isObject() ? ((ObjectNode) body.get("properties")).deepCopy() : JSON.createObjectNode();
                props.put("provisioningState", existing == null ? "Creating" : "Updating");
                res.set("properties", props);
                resources.put(id.toLowerCase(), res);
                return started(id, false, existing == null ? 201 : 200, res);
            }
            case "DELETE" -> {
                if (existing == null) return new Reply(204, null);
                state(existing, "Deleting");
                return started(id, true, 202, null);
            }
            default -> { return err(405, "MethodNotAllowed", method + " is not supported"); }
        }
    }

    private Reply started(String id, boolean delete, int status, Object body) {
        String op = "op-" + ids.incrementAndGet();
        Operation o = new Operation();
        o.resourceId = id;
        o.delete = delete;
        o.pollsLeft = pollsUntilDone;
        o.failure = failNextOperation;
        failNextOperation = null;
        operations.put(op, o);
        String provider = id.contains("Microsoft.Compute") ? "Microsoft.Compute" : "Microsoft.Network";
        Map<String, String> h = new HashMap<>();
        h.put("Azure-AsyncOperation", url() + "/subscriptions/" + SUBSCRIPTION + "/providers/" + provider
                + "/locations/westeurope/operations/" + op + "?api-version=2024-07-01");
        if (retryAfter != null) h.put("Retry-After", retryAfter);
        return new Reply(status, body, h);
    }

    private Reply poll(String opId) {
        Operation op = operations.get(opId);
        if (op == null) return err(404, "NotFound", "no operation " + opId);
        if (op.status.equals("InProgress") && op.pollsLeft-- <= 0) {
            ObjectNode res = resources.get(op.resourceId.toLowerCase());
            if (op.failure != null) {
                op.status = "Failed";
                if (res != null) {
                    state(res, "Failed");   // with the message where a VM's instance view has it
                    ((ObjectNode) res.get("properties")).putObject("instanceView").putArray("statuses").addObject()
                            .put("code", "ProvisioningState/failed/OperationFailed").put("level", "Error").put("message", op.failure);
                }
            } else {
                op.status = "Succeeded";
                if (op.delete) resources.remove(op.resourceId.toLowerCase());
                else if (res != null) state(res, "Succeeded");
                if (res != null && !op.delete && op.resourceId.contains("/publicIPAddresses/")) {
                    ((ObjectNode) res.get("properties")).put("ipAddress", "20.50.0." + ids.incrementAndGet() % 250);
                }
            }
        }
        Map<String, Object> out = new HashMap<>(Map.of("name", opId, "status", op.status));
        if (op.status.equals("Failed")) out.put("error", Map.of("code", "OperationFailed", "message", op.failure));
        return new Reply(200, out, retryAfter == null ? Map.of() : Map.of("Retry-After", retryAfter));
    }

    private static void state(ObjectNode res, String provisioningState) {
        ((ObjectNode) res.get("properties")).put("provisioningState", provisioningState);
    }
}
