package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** Google Compute Engine adapter (simulated). Polls "gcp-q" (create/delete) and "gcp-read-q" (plan/describe). */
@Component
@ActivityImpl(taskQueues = {TaskQueues.GCP, TaskQueues.GCP_READ})
public class GcpProvider extends SimulatedProvider {
    public GcpProvider(SimCloud cloud) {
        super(cloud);
    }

    @Override
    protected String providerName() {
        return "gcp";
    }

    @Override
    protected String idPrefix() {
        return "gce-";
    }
}
