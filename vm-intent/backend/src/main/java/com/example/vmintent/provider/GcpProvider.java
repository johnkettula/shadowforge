package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** Google Compute Engine adapter (simulated). Runs on its own task queue "gcp-q". */
@Component
@ActivityImpl(taskQueues = TaskQueues.GCP)
public class GcpProvider extends SimulatedProvider implements ProviderActivities {
    @Override
    protected String idPrefix() {
        return "gce-";
    }
}
