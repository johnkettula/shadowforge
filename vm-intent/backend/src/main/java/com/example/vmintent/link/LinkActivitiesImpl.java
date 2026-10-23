package com.example.vmintent.link;

import com.example.vmintent.provider.ProviderCatalog;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.LinkActivities;
import com.example.vmintent.workflow.Models.LinkOrder;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.Route;
import com.example.vmintent.workflow.TaskQueues;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/** Writes orders for domain 3 into the outbox. See LinkActivities. */
@Component
@ActivityImpl(taskQueues = TaskQueues.INTENT)
public class LinkActivitiesImpl implements LinkActivities {

    private final LinkProperties props;
    private final ObjectMapper json;

    public LinkActivitiesImpl(LinkProperties props, ObjectMapper json) {
        this.props = props;
        this.json = json;
    }

    @Override
    public Route route(String provider) {
        return props.isOneWay(provider) ? new Route(true, props.replyTimeoutMinutes()) : Route.DIRECT;
    }

    @Override
    public ProviderPlan planHere(VmSpec spec) {
        return ProviderCatalog.plan(spec);
    }

    @Override
    public void send(LinkOrder order) {
        try {
            Files.createDirectories(props.outboxDir());
            Path target = props.outboxDir().resolve(order.orderId() + ".json");
            // Write to a temporary name, then rename: the link software never picks up half a file.
            Path tmp = props.outboxDir().resolve(order.orderId() + ".json.part");
            json.writerWithDefaultPrettyPrinter().writeValue(tmp.toFile(), order);
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not write order " + order.orderId() + " to " + props.outboxDir(), e);
        }
    }
}
