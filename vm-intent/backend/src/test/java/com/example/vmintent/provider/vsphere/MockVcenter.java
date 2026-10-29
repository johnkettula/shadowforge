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
import java.util.Base64;
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
 * A small stand-in for vCenter 9's REST APIs: the endpoints vm-intent calls, with state, and with
 * vCenter's rules that matter (sign in first; power off before delete or a cold resize; IP only once
 * Tools reports one). Records every call so tests can check what was sent.
 */
public final class MockVcenter implements AutoCloseable {

    static final ObjectMapper JSON = new ObjectMapper();

    public static final class Vm {
        public String name;
        public String folder;
        public String power = "POWERED_ON";
        public int cpu;
        public long memMiB;
        public String ip;

        Vm(String name, String folder, int cpu, long memMiB) {
            this.name = name;
            this.folder = folder;
            this.cpu = cpu;
            this.memMiB = memMiB;
        }
    }

    record Task(String status, String error, String vmName, int cpu, long memMiB, String folder) {}

    public final Map<String, Vm> vms = new ConcurrentHashMap<>();
    public final Map<String, Task> tasks = new ConcurrentHashMap<>();
    public final Map<String, JsonNode> deployBodies = new ConcurrentHashMap<>();
    public final Set<String> tagged = ConcurrentHashMap.newKeySet();
    public final Map<String, String> categories = new ConcurrentHashMap<>();   // id -> name
    public final Map<String, String[]> tags = new ConcurrentHashMap<>();       // id -> {name, categoryId}
    public final List<String> calls = new CopyOnWriteArrayList<>();
    public final List<String> snapshots = new CopyOnWriteArrayList<>();
    public final Set<String> sessions = ConcurrentHashMap.newKeySet();
    final AtomicInteger ids = new AtomicInteger(100);
    public volatile int busyResponses;
    /** Clones finish, and Tools reports an IP, the next time anyone lists VMs (for workflow tests). */
    public volatile boolean autoBoot;
    public volatile String failNextDeploy;

    static final Map<String, Map<String, String>> INVENTORY = Map.of(
            "cluster", Map.of("Cluster-A", "domain-c8"),
            "folder", Map.of("vm-intent", "group-v3"),
            "datastore", Map.of("vsanDatastore", "datastore-11", "nfs-01", "datastore-12"),
            "datacenter", Map.of("Datacenter-1", "datacenter-2"),
            "resource-pool", Map.of("Pool-1", "resgroup-9"),
            "host", Map.of("esx-01", "host-12"));
    static final Map<String, String> ITEMS = Map.of("tpl-ubuntu-2404", "item-1", "tpl-rhel-9", "item-2");

    private final HttpServer server;

    public MockVcenter() throws IOException {
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

    /** A VM someone else built (not tagged as vm-intent's). */
    public String addForeignVm(String name) {
        String id = "vm-" + ids.incrementAndGet();
        vms.put(id, new Vm(name, "group-v3", 2, 4096));
        return id;
    }

    /** Every running deploy task finishes: its VM appears, powered on, without an IP yet. */
    public void finishDeploys() {
        tasks.forEach((id, t) -> {
            if ("RUNNING".equals(t.status())) {
                vms.put("vm-" + ids.incrementAndGet(), new Vm(t.vmName(), t.folder(), t.cpu(), t.memMiB()));
                tasks.put(id, new Task("SUCCEEDED", null, t.vmName(), t.cpu(), t.memMiB(), t.folder()));
            }
        });
    }

    public void giveIp(String name, String ip) {
        vms.values().stream().filter(v -> v.name.equals(name)).forEach(v -> v.ip = ip);
    }

    public Vm byName(String name) {
        return vms.values().stream().filter(v -> v.name.equals(name)).findFirst().orElse(null);
    }

    public String idByName(String name) {
        return vms.entrySet().stream().filter(e -> e.getValue().name.equals(name)).map(Map.Entry::getKey).findFirst().orElse(null);
    }

    public void expireSessions() {
        sessions.clear();
    }

    // ------------------------------------------------------------------ HTTP

    private record Reply(int status, Object body) {}

    private static Reply ok(Object body) {
        return new Reply(200, body);
    }

    private static Reply err(int status, String message) {
        return new Reply(status, Map.of("error_type", status == 404 ? "NOT_FOUND" : "INVALID_ARGUMENT",
                "messages", List.of(Map.of("default_message", message))));
    }

    private void handle(HttpExchange ex) throws IOException {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getRawPath();
        Map<String, String> query = query(ex.getRequestURI().getRawQuery());
        byte[] raw = ex.getRequestBody().readAllBytes();
        JsonNode body = raw.length == 0 ? null : JSON.readTree(raw);
        calls.add(method + " " + path + (ex.getRequestURI().getRawQuery() == null ? "" : "?" + ex.getRequestURI().getRawQuery()));
        Reply r;
        try {
            r = route(ex, method, path, query, body);
        } catch (RuntimeException e) {
            r = err(500, e.toString());
        }
        byte[] out = r.body() == null ? new byte[0] : JSON.writeValueAsBytes(r.body());
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(r.status(), out.length == 0 ? -1 : out.length);
        if (out.length > 0) ex.getResponseBody().write(out);
        ex.close();
    }

    private static Map<String, String> query(String q) {
        Map<String, String> m = new HashMap<>();
        if (q == null) return m;
        for (String p : q.split("&")) {
            int i = p.indexOf('=');
            m.put(URLDecoder.decode(i < 0 ? p : p.substring(0, i), StandardCharsets.UTF_8), i < 0 ? "" : URLDecoder.decode(p.substring(i + 1), StandardCharsets.UTF_8));
        }
        return m;
    }

    private Matcher m(String regex, String path) {
        Matcher m = Pattern.compile(regex).matcher(path);
        return m.matches() ? m : null;
    }

    private Reply route(HttpExchange ex, String method, String path, Map<String, String> q, JsonNode body) {
        if (path.equals("/api/session") && method.equals("POST")) {
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            if (auth == null || !new String(Base64.getDecoder().decode(auth.substring(6))).equals("svc@vsphere.local:secret")) {
                return err(401, "bad credentials");
            }
            String s = "session-" + ids.incrementAndGet();
            sessions.add(s);
            return ok(s);
        }
        if (!sessions.contains(String.valueOf(ex.getRequestHeaders().getFirst("vmware-api-session-id")))) return err(401, "not signed in");
        if (busyResponses > 0) {
            busyResponses--;
            return err(503, "service busy");
        }
        Matcher x;
        // inventory
        if (method.equals("GET") && (x = m("/api/vcenter/(cluster|folder|datastore|datacenter|resource-pool|host)", path)) != null) {
            String kind = x.group(1);
            String name = q.get("names");
            String id = INVENTORY.get(kind).get(name);
            String field = kind.equals("resource-pool") ? "resource_pool" : kind;
            return ok(id == null ? List.of() : List.of(Map.of(field, id, "name", name)));
        }
        if (method.equals("POST") && path.equals("/api/content/library") && "find".equals(q.get("action"))) {
            return ok("vm-intent-templates".equals(body.path("name").asText()) ? List.of("lib-1") : List.of());
        }
        if (method.equals("POST") && path.equals("/api/content/library/item") && "find".equals(q.get("action"))) {
            String id = ITEMS.get(body.path("name").asText());
            return ok(id == null ? List.of() : List.of(id));
        }
        if (method.equals("GET") && path.equals("/api/content/library/item")) return ok(List.copyOf(ITEMS.values()));
        if (method.equals("GET") && (x = m("/api/content/library/item/(.+)", path)) != null) {
            String id = x.group(1);
            String name = ITEMS.entrySet().stream().filter(e -> e.getValue().equals(id)).map(Map.Entry::getKey).findFirst().orElse("?");
            return ok(Map.of("id", id, "name", name, "type", "vm-template"));
        }
        // VMs
        if (method.equals("GET") && path.equals("/api/vcenter/vm")) {
            if (autoBoot) {
                finishDeploys();
                vms.values().forEach(v -> {
                    if (v.ip == null) v.ip = "10.10.0." + (vms.size() + 20);
                });
            }
            List<Object> out = new ArrayList<>();
            vms.forEach((id, v) -> {
                if (q.containsKey("names") && !q.get("names").equals(v.name)) return;
                if (q.containsKey("folders") && !q.get("folders").equals(v.folder)) return;
                out.add(Map.of("vm", id, "name", v.name, "power_state", v.power, "cpu_count", v.cpu, "memory_size_MiB", v.memMiB));
            });
            return ok(out);
        }
        if ((x = m("/api/vcenter/vm-template/library-items/(.+)", path)) != null && method.equals("POST")) {
            if (!"deploy".equals(q.get("action")) || !"true".equals(q.get("vmw-task"))) return err(400, "expected action=deploy&vmw-task=true");
            if (!ITEMS.containsValue(x.group(1))) return err(404, "no such item");
            String name = body.path("name").asText();
            if (byName(name) != null) return err(400, "A VM named " + name + " already exists");
            String task = "task-" + ids.incrementAndGet();
            deployBodies.put(name, body);
            if (failNextDeploy != null) {
                tasks.put(task, new Task("FAILED", failNextDeploy, name, 0, 0, null));
                failNextDeploy = null;
            } else {
                tasks.put(task, new Task("RUNNING", null, name, body.path("hardware_customization").path("cpu_update").path("num_cpus").asInt(2),
                        body.path("hardware_customization").path("memory_update").path("memory").asLong(4096), body.path("placement").path("folder").asText()));
            }
            return ok(task);
        }
        if ((x = m("/api/cis/tasks/(.+)", path)) != null) {
            Task t = tasks.get(x.group(1));
            if (t == null) return err(404, "no task");
            if (method.equals("POST") && "cancel".equals(q.get("action"))) {
                tasks.put(x.group(1), new Task("FAILED", "canceled", t.vmName(), 0, 0, null));
                return ok(null);
            }
            Map<String, Object> info = new LinkedHashMap<>();
            info.put("status", t.status());
            if (t.error() != null) info.put("error", Map.of("messages", List.of(Map.of("default_message", t.error()))));
            return ok(info);
        }
        if ((x = m("/api/vcenter/vm/([^/]+)(/.*)?", path)) != null) {
            String id = x.group(1);
            Vm v = vms.get(id);
            if (v == null) return err(404, "no VM " + id);
            String sub = x.group(2) == null ? "" : x.group(2);
            switch (sub) {
                case "" -> {
                    if (method.equals("DELETE")) {
                        if (v.power.equals("POWERED_ON")) return err(400, "The VM must be powered off");
                        vms.remove(id);
                        tagged.remove(id);
                        return ok(null);
                    }
                    return ok(Map.of("name", v.name, "power_state", v.power, "cpu", Map.of("count", v.cpu), "memory", Map.of("size_MiB", v.memMiB)));
                }
                case "/power" -> {
                    if (method.equals("GET")) return ok(Map.of("state", v.power));
                    String a = q.get("action");
                    if ("start".equals(a)) {
                        if (v.power.equals("POWERED_ON")) return err(400, "already powered on");
                        v.power = "POWERED_ON";
                    } else if ("stop".equals(a)) {
                        if (v.power.equals("POWERED_OFF")) return err(400, "already powered off");
                        v.power = "POWERED_OFF";
                    }
                    return ok(null);
                }
                case "/hardware/cpu" -> {
                    if (v.power.equals("POWERED_ON")) return err(400, "CPU hot add is off: power the VM off first");
                    v.cpu = body.path("count").asInt();
                    return ok(null);
                }
                case "/hardware/memory" -> {
                    if (v.power.equals("POWERED_ON")) return err(400, "Memory hot add is off: power the VM off first");
                    v.memMiB = body.path("size_MiB").asLong();
                    return ok(null);
                }
                case "/guest/identity" -> {
                    if (v.ip == null || !v.power.equals("POWERED_ON")) return err(503, "VMware Tools is not running");
                    return ok(Map.of("ip_address", v.ip, "host_name", v.name));
                }
                default -> {
                    return err(404, "no such path");
                }
            }
        }
        // tags
        if (path.equals("/api/cis/tagging/category")) {
            if (method.equals("GET")) return ok(List.copyOf(categories.keySet()));
            String id = "urn:vmomi:InventoryServiceCategory:" + ids.incrementAndGet();
            categories.put(id, body.path("name").asText());
            return ok(id);
        }
        if ((x = m("/api/cis/tagging/category/(.+)", path)) != null) return ok(Map.of("name", categories.get(URLDecoder.decode(x.group(1), StandardCharsets.UTF_8))));
        if (path.equals("/api/cis/tagging/tag")) {
            if ("list-tags-for-category".equals(q.get("action"))) {
                String cat = body.path("category_id").asText();
                return ok(tags.entrySet().stream().filter(e -> e.getValue()[1].equals(cat)).map(Map.Entry::getKey).toList());
            }
            String id = "urn:vmomi:InventoryServiceTag:" + ids.incrementAndGet();
            tags.put(id, new String[]{body.path("name").asText(), body.path("category_id").asText()});
            return ok(id);
        }
        if ((x = m("/api/cis/tagging/tag/(.+)", path)) != null) return ok(Map.of("name", tags.get(URLDecoder.decode(x.group(1), StandardCharsets.UTF_8))[0]));
        if ((x = m("/api/cis/tagging/tag-association/(.+)", path)) != null) {
            if ("attach".equals(q.get("action"))) {
                tagged.add(body.path("object_id").path("id").asText());
                return ok(null);
            }
            return ok(tagged.stream().map(id -> Map.of("id", id, "type", "VirtualMachine")).toList());
        }
        // VI JSON
        if (path.equals("/sdk/vim25/release")) return ok("9.0.0.0");
        if ((x = m("/sdk/vim25/9\\.0\\.0\\.0/VirtualMachine/([^/]+)/CreateSnapshot_Task", path)) != null) {
            if (!vms.containsKey(x.group(1))) return err(404, "no VM");
            snapshots.add(x.group(1) + ":" + body.path("name").asText());
            return ok(Map.of("_typeName", "ManagedObjectReference", "type", "Task", "value", "task-snap-" + ids.incrementAndGet()));
        }
        return err(404, "mock vCenter has no " + method + " " + path);
    }
}
