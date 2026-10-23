package com.example.vmintent.link;

import com.example.vmintent.workflow.Models.LinkOrder;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * A pretend domain 3, for trying the one-way link on one PC (vmintent.link.simulate-domain3=true).
 *
 * It does what the link software and domain 3 would do together: takes each order out of the
 * outbox (into outbox/carried/), "builds" for a few seconds and writes the answer into the inbox.
 * A VM whose name contains "fail" is refused, to show the rollback.
 *
 * In a real deployment this is switched off: the link carries the outbox to domain 3, and the
 * return link carries domain 3's answers into the inbox.
 */
@Component
public class Domain3Simulator implements SmartLifecycle {

    private static final Logger log = LoggerFactory.getLogger(Domain3Simulator.class);

    private final LinkProperties props;
    private final ObjectMapper json;
    private ScheduledExecutorService timer;

    public Domain3Simulator(LinkProperties props, ObjectMapper json) {
        this.props = props;
        this.json = json.copy().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    @Override
    public void start() {
        if (!props.enabled() || !props.simulateDomain3()) return;
        log.info("Simulating domain 3: answering orders from {} into {}", props.outboxDir(), props.inboxDir());
        timer = Executors.newScheduledThreadPool(2, r -> new Thread(r, "domain3-sim"));
        timer.scheduleWithFixedDelay(this::pollSafely, 1, 1, TimeUnit.SECONDS);
    }

    @Override
    public void stop() {
        if (timer != null) timer.shutdownNow();
        timer = null;
    }

    @Override
    public boolean isRunning() {
        return timer != null;
    }

    private void pollSafely() {
        try {
            Files.createDirectories(props.outboxDir());
            List<Path> files = new ArrayList<>();
            try (DirectoryStream<Path> ds = Files.newDirectoryStream(props.outboxDir(), "*.json")) {
                ds.forEach(files::add);
            }
            for (Path f : files) {
                Path carried = props.outboxDir().resolve("carried");
                Files.createDirectories(carried);
                Path moved;
                try {
                    moved = Files.move(f, carried.resolve(f.getFileName()), StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException e) {
                    continue;
                }
                LinkOrder order = json.readValue(moved.toFile(), LinkOrder.class);
                long delay = "CREATE".equals(order.type()) ? props.simulatedBuildSeconds() : 2;
                timer.schedule(() -> answer(order), delay, TimeUnit.SECONDS);
            }
        } catch (Exception e) {
            log.warn("Domain 3 simulator: {}", e.toString());
        }
    }

    private void answer(LinkOrder o) {
        String key = o.idempotencyKey() == null ? "x" : o.idempotencyKey();
        boolean fail = "CREATE".equals(o.type()) && o.spec() != null && o.spec().name() != null
                && o.spec().name().contains("fail");
        String vmId = o.vmId() != null ? o.vmId() : "d3-" + key.substring(0, Math.min(10, key.length()));
        String ip = "172.20." + Math.floorMod(key.hashCode() >> 8, 256) + "." + (Math.floorMod(key.hashCode(), 250) + 2);
        String detail = switch (o.type()) {
            case "SNAPSHOT" -> "snap-" + vmId + "-" + System.currentTimeMillis() % 100000;
            case "CREATE" -> fail ? "Simulated build failure in domain 3" : "built in domain 3";
            default -> o.type().toLowerCase() + " done in domain 3";
        };
        ReplyFile reply = new ReplyFile(o.orderId(), o.type(), o.replyTo(), o.idempotencyKey(), o.specHash(), !fail,
                fail ? null : vmId, fail || !"CREATE".equals(o.type()) ? null : ip, detail);
        try {
            Files.createDirectories(props.inboxDir());
            Path tmp = props.inboxDir().resolve(o.orderId() + ".json.part");
            json.writerWithDefaultPrettyPrinter().writeValue(tmp.toFile(), reply);
            Files.move(tmp, props.inboxDir().resolve(o.orderId() + ".json"), StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            log.warn("Domain 3 simulator could not answer {}: {}", o.orderId(), e.toString());
        }
    }
}
