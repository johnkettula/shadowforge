package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.sun.net.httpserver.HttpServer;
import io.temporal.failure.ApplicationFailure;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests the Proxmox provider against a fake Proxmox API on localhost. The responses are written
 * by hand from the Proxmox VE API documentation; no test calls a real Proxmox host.
 */
class ProxmoxProviderTest {

    private HttpServer server;
    /** "METHOD /path" -> the "data" JSON to answer with. */
    private final Map<String, String> answers = new ConcurrentHashMap<>();
    /** Requests seen, as "METHOD /path body". */
    private final List<String> seen = new ArrayList<>();

    @BeforeEach
    void startFakeProxmox() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String key = exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath()
                    .replaceFirst("^/api2/json", "");
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            synchronized (seen) {
                seen.add(key + " " + body);
            }
            String data = answers.get(key);
            int code = data == null ? 404 : 200;
            byte[] out = (data == null ? "{}" : "{\"data\":" + data + "}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(code, out.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(out);
            }
        });
        server.start();
    }

    @AfterEach
    void stopFakeProxmox() {
        server.stop(0);
    }

    private String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private ProxmoxProvider configured() {
        return new ProxmoxProvider(url(), "vmintent@pve!api=secret", "pve1", 9000);
    }

    private static VmSpec spec(String name) {
        // name, provider, region, vcpu, memoryGiB, os, osVersion, diskGiB, diskTier, env, ttlDays, publicIp
        return new VmSpec(name, "proxmox", "dc1", 2, 4, "ubuntu", "24.04", 50, "standard", "dev", 7, false);
    }

    @Test
    void notSetUpFailsBuildsWithAClearMessage() {
        ProxmoxProvider p = new ProxmoxProvider("", "", "", 0);
        ApplicationFailure e = assertThrows(ApplicationFailure.class, () -> p.createVm(spec("web-01"), p.plan(spec("web-01")), "k"));
        assertEquals(ProxmoxProvider.NOT_SET_UP, e.getType());
        assertTrue(e.getOriginalMessage().contains("VMINTENT_PROXMOX_URL"));
    }

    @Test
    void createClonesTheTemplateWithTheNextIdAndName() {
        answers.put("GET /cluster/nextid", "\"101\"");
        answers.put("GET /nodes/pve1/qemu", "[{\"vmid\":9000,\"name\":\"tpl-ubuntu\"}]");
        answers.put("POST /nodes/pve1/qemu/9000/clone", "\"UPID:pve1:0001\"");

        ProxmoxProvider p = configured();
        String vmId = p.createVm(spec("web-01"), p.plan(spec("web-01")), "k");

        assertEquals("101", vmId);
        assertTrue(seen.stream().anyMatch(s -> s.startsWith("POST /nodes/pve1/qemu/9000/clone")
                && s.contains("newid=101") && s.contains("name=web-01")));
    }

    @Test
    void createReturnsTheExistingVmWhenTheNameIsTaken() {
        answers.put("GET /nodes/pve1/qemu", "[{\"vmid\":105,\"name\":\"web-01\"}]");

        ProxmoxProvider p = configured();
        assertEquals("105", p.createVm(spec("web-01"), p.plan(spec("web-01")), "k"));
        assertTrue(seen.stream().noneMatch(s -> s.contains("/clone")));
    }

    @Test
    void describeReportsRunningWithAnIpFromTheGuestAgent() {
        answers.put("GET /nodes/pve1/qemu/101/status/current", "{\"status\":\"running\"}");
        answers.put("GET /nodes/pve1/qemu/101/agent/network-get-interfaces",
                "{\"result\":[{\"name\":\"lo\",\"ip-addresses\":[{\"ip-address-type\":\"ipv4\",\"ip-address\":\"127.0.0.1\"}]},"
                        + "{\"name\":\"eth0\",\"ip-addresses\":[{\"ip-address-type\":\"ipv4\",\"ip-address\":\"10.0.0.17\"}]}]}");

        var status = configured().describeVm("101");
        assertEquals("RUNNING", status.state());
        assertEquals("10.0.0.17", status.ipAddress());
    }

    @Test
    void describeWhileBusyIsPendingAndStoppedIsPending() {
        answers.put("GET /nodes/pve1/qemu/101/status/current", "{\"status\":\"stopped\",\"lock\":\"clone\"}");
        assertEquals("PENDING", configured().describeVm("101").state());

        answers.put("GET /nodes/pve1/qemu/101/status/current", "{\"status\":\"stopped\"}");
        var status = configured().describeVm("101");
        assertEquals("PENDING", status.state());
        assertNull(status.ipAddress());
    }

    @Test
    void listLeavesOutTheTemplate() {
        answers.put("GET /nodes/pve1/qemu", "[{\"vmid\":9000},{\"vmid\":101},{\"vmid\":102}]");
        assertEquals(List.of("101", "102"), configured().listVmIds());
    }

    @Test
    void snapshotNamesAreSanitisedForProxmox() {
        answers.put("POST /nodes/pve1/qemu/101/snapshot", "\"UPID:pve1:0002\"");
        assertEquals("before-upgrade", ProxmoxProvider.snapshotName("before upgrade!"));
        assertEquals("s1st", ProxmoxProvider.snapshotName("1st"));
        assertEquals("before-upgrade", configured().snapshotVm("101", "before upgrade!"));
    }
}
