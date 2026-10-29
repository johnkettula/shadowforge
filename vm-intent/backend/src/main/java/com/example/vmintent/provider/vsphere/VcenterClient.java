package com.example.vmintent.provider.vsphere;

import com.fasterxml.jackson.databind.JsonNode;
import io.temporal.failure.ApplicationFailure;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.example.vmintent.provider.vsphere.HttpJson.q;

/**
 * The parts of the vCenter 9 APIs vm-intent uses. Everything is the vSphere Automation REST API
 * (/api/...), except snapshots, which it only has in the VI JSON API (/sdk/vim25/...). Both accept the
 * same session.
 *
 *   sign in        POST /api/session (basic auth) -> session ID, sent as vmware-api-session-id
 *   find VMs       GET  /api/vcenter/vm?names=..&folders=..
 *   build          POST /api/vcenter/vm-template/library-items/{item}?action=deploy&vmw-task=true -> task ID
 *   task           GET  /api/cis/tasks/{task}
 *   power          GET/POST /api/vcenter/vm/{vm}/power[?action=start|stop]
 *   size           PATCH /api/vcenter/vm/{vm}/hardware/cpu, .../hardware/memory
 *   IP address     GET  /api/vcenter/vm/{vm}/guest/identity (needs VMware Tools)
 *   remove         DELETE /api/vcenter/vm/{vm}
 *   ownership tag  /api/cis/tagging/category, /tag, /tag-association/{tag}?action=attach|list-attached-objects
 *   snapshot       POST /sdk/vim25/{release}/VirtualMachine/{vm}/CreateSnapshot_Task
 *
 * Thread-safe: one session is shared, and replaced when vCenter says it has expired.
 */
public class VcenterClient {

    private final VsphereProperties.Vcenter cfg;
    private final HttpJson http;
    private volatile String session;
    private volatile String viRelease;

    public VcenterClient(VsphereProperties.Vcenter cfg) {
        this.cfg = cfg;
        this.http = new HttpJson("vCenter", cfg.url(), cfg.caFile(), cfg.timeoutSeconds());
    }

    // ------------------------------------------------------------------ session

    private synchronized String login() {
        String basic = Base64.getEncoder().encodeToString((cfg.username() + ":" + (cfg.password() == null ? "" : cfg.password()))
                .getBytes(StandardCharsets.UTF_8));
        HttpJson.Response r = http.check(http.send("POST", "/api/session", null, Map.of("Authorization", "Basic " + basic)),
                "POST", "/api/session");
        session = r.body().asText();
        return session;
    }

    /** One call with the session; signs in again once if vCenter says the session is gone. */
    JsonNode call(String method, String path, Object body) {
        String s = session != null ? session : login();
        HttpJson.Response r = http.send(method, path, body, Map.of("vmware-api-session-id", s));
        if (r.status() == 401) {
            synchronized (this) {
                if (s.equals(session)) login();
            }
            r = http.send(method, path, body, Map.of("vmware-api-session-id", session));
        }
        return http.check(r, method, path).body();
    }

    /** Like call(), but a 404 is an empty answer instead of a failure. */
    Optional<JsonNode> callOrMissing(String method, String path, Object body) {
        try {
            return Optional.of(call(method, path, body));
        } catch (ApplicationFailure e) {
            if ("NotFound".equals(e.getType())) return Optional.empty();
            throw e;
        }
    }

    // ------------------------------------------------------------------ inventory lookups

    public record VmSummary(String vm, String name, String powerState, int cpuCount, long memoryMiB) {}

    public Optional<VmSummary> findVm(String name, String folderId) {
        String path = "/api/vcenter/vm?names=" + q(name) + (folderId == null ? "" : "&folders=" + q(folderId));
        for (JsonNode n : call("GET", path, null)) {
            if (name.equals(n.path("name").asText())) return Optional.of(summary(n));
        }
        return Optional.empty();
    }

    public Optional<VmSummary> vm(String vmId) {
        return callOrMissing("GET", "/api/vcenter/vm/" + q(vmId), null).map(n -> new VmSummary(vmId, n.path("name").asText(),
                n.path("power_state").asText(), n.path("cpu").path("count").asInt(), n.path("memory").path("size_MiB").asLong()));
    }

    private static VmSummary summary(JsonNode n) {
        return new VmSummary(n.path("vm").asText(), n.path("name").asText(), n.path("power_state").asText(),
                n.path("cpu_count").asInt(), n.path("memory_size_MiB").asLong());
    }

    /** ID of the one inventory object of this kind with this name, e.g. ("cluster", "Cluster-A"). */
    public String idOf(String kind, String name, String extraQuery) {
        JsonNode list = call("GET", "/api/vcenter/" + kind + "?names=" + q(name) + (extraQuery == null ? "" : "&" + extraQuery), null);
        String field = switch (kind) {
            case "resource-pool" -> "resource_pool";
            default -> kind;
        };
        for (JsonNode n : list) if (name.equals(n.path("name").asText())) return n.path(field).asText();
        throw ApplicationFailure.newNonRetryableFailure("vCenter has no " + kind + " called '" + name + "'", "InvalidSpec");
    }

    /** The content library item ID of a template, by library name and item name. */
    public String libraryItem(String libraryName, String itemName) {
        JsonNode libs = call("POST", "/api/content/library?action=find", Map.of("name", libraryName));
        if (!libs.isArray() || libs.isEmpty()) {
            throw ApplicationFailure.newNonRetryableFailure("vCenter has no content library called '" + libraryName + "'", "InvalidSpec");
        }
        JsonNode items = call("POST", "/api/content/library/item?action=find", Map.of("name", itemName, "library_id", libs.get(0).asText()));
        if (!items.isArray() || items.isEmpty()) {
            throw ApplicationFailure.newNonRetryableFailure("Content library '" + libraryName + "' has no template called '" + itemName + "'", "InvalidSpec");
        }
        return items.get(0).asText();
    }

    public record LibraryItem(String id, String name, String type, String description) {}

    /** Every item in a content library (for the discovery API). */
    public List<LibraryItem> libraryItems(String libraryName) {
        JsonNode libs = call("POST", "/api/content/library?action=find", Map.of("name", libraryName));
        List<LibraryItem> out = new ArrayList<>();
        if (!libs.isArray() || libs.isEmpty()) return out;
        for (JsonNode id : call("GET", "/api/content/library/item?library_id=" + q(libs.get(0).asText()), null)) {
            JsonNode it = call("GET", "/api/content/library/item/" + q(id.asText()), null);
            out.add(new LibraryItem(id.asText(), it.path("name").asText(), it.path("type").asText(), it.path("description").asText("")));
        }
        return out;
    }

    // ------------------------------------------------------------------ build

    /** Starts deploying a VM from a VM template (vmw-task=true: returns a task ID at once). */
    public String deployFromTemplate(String libraryItemId, Map<String, Object> spec) {
        JsonNode r = call("POST", "/api/vcenter/vm-template/library-items/" + q(libraryItemId) + "?action=deploy&vmw-task=true", spec);
        return r.asText();
    }

    public record TaskInfo(String status, String error, String result) {
        public boolean failed() {
            return "FAILED".equals(status);
        }

        public boolean succeeded() {
            return "SUCCEEDED".equals(status);
        }
    }

    public Optional<TaskInfo> task(String taskId) {
        return callOrMissing("GET", "/api/cis/tasks/" + q(taskId), null).map(n -> {
            String err = n.has("error") ? HttpJson.errorText(n.get("error")) : null;
            return new TaskInfo(n.path("status").asText(), err, n.path("result").isMissingNode() ? null : n.path("result").asText(null));
        });
    }

    public void cancelTask(String taskId) {
        callOrMissing("POST", "/api/cis/tasks/" + q(taskId) + "?action=cancel", null);
    }

    // ------------------------------------------------------------------ day 2

    public String powerState(String vm) {
        return call("GET", "/api/vcenter/vm/" + q(vm) + "/power", null).path("state").asText();
    }

    public void power(String vm, boolean on) {
        call("POST", "/api/vcenter/vm/" + q(vm) + "/power?action=" + (on ? "start" : "stop"), null);
    }

    public void setCpu(String vm, int count) {
        call("PATCH", "/api/vcenter/vm/" + q(vm) + "/hardware/cpu", Map.of("count", count));
    }

    public void setMemoryMiB(String vm, long mib) {
        call("PATCH", "/api/vcenter/vm/" + q(vm) + "/hardware/memory", Map.of("size_MiB", mib));
    }

    /** The guest's IP address, once VMware Tools reports it. */
    public Optional<String> guestIp(String vm) {
        try {
            JsonNode n = call("GET", "/api/vcenter/vm/" + q(vm) + "/guest/identity", null);
            String ip = n.path("ip_address").asText("");
            return ip.isBlank() ? Optional.empty() : Optional.of(ip);
        } catch (ApplicationFailure e) {
            // 503 (Tools not running yet) or 404 / 400: no IP yet, not an error.
            if ("NotFound".equals(e.getType()) || "CloudBusy".equals(e.getType()) || "InvalidSpec".equals(e.getType())) return Optional.empty();
            throw e;
        }
    }

    public void delete(String vm) {
        callOrMissing("DELETE", "/api/vcenter/vm/" + q(vm), null);
    }

    /** Takes a snapshot through the VI JSON API; returns the task's ID. */
    public String snapshot(String vm, String name, String description) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("description", description);
        body.put("memory", false);
        body.put("quiesce", false);
        JsonNode r = call("POST", "/sdk/vim25/" + release() + "/VirtualMachine/" + q(vm) + "/CreateSnapshot_Task", body);
        return r.path("value").asText(r.asText());
    }

    private String release() {
        if (viRelease == null) viRelease = call("GET", "/sdk/vim25/release", null).asText();
        return viRelease;
    }

    // ------------------------------------------------------------------ the ownership tag

    private volatile String tagId;

    /** The {category}/{tag} vm-intent marks its VMs with; created on first use. */
    public synchronized String ownershipTag() {
        if (tagId != null) return tagId;
        String categoryId = null;
        for (JsonNode id : call("GET", "/api/cis/tagging/category", null)) {
            if (cfg.tagCategory().equals(call("GET", "/api/cis/tagging/category/" + q(id.asText()), null).path("name").asText())) {
                categoryId = id.asText();
                break;
            }
        }
        if (categoryId == null) {
            categoryId = call("POST", "/api/cis/tagging/category", Map.of("name", cfg.tagCategory(),
                    "description", "VMs built by vm-intent", "cardinality", "MULTIPLE",
                    "associable_types", List.of("VirtualMachine"))).asText();
        }
        for (JsonNode id : call("POST", "/api/cis/tagging/tag?action=list-tags-for-category", Map.of("category_id", categoryId))) {
            if (cfg.tag().equals(call("GET", "/api/cis/tagging/tag/" + q(id.asText()), null).path("name").asText())) {
                tagId = id.asText();
                return tagId;
            }
        }
        tagId = call("POST", "/api/cis/tagging/tag", Map.of("name", cfg.tag(), "description", "Built and looked after by vm-intent",
                "category_id", categoryId)).asText();
        return tagId;
    }

    public void tag(String vm) {
        call("POST", "/api/cis/tagging/tag-association/" + q(ownershipTag()) + "?action=attach",
                Map.of("object_id", Map.of("id", vm, "type", "VirtualMachine")));
    }

    public List<String> taggedVms() {
        List<String> out = new ArrayList<>();
        for (JsonNode o : call("POST", "/api/cis/tagging/tag-association/" + q(ownershipTag()) + "?action=list-attached-objects", null)) {
            if ("VirtualMachine".equals(o.path("type").asText())) out.add(o.path("id").asText());
        }
        return out;
    }

    public boolean isTagged(String vm) {
        return taggedVms().contains(vm);
    }
}
