package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** VMware vSphere adapter (simulated). Runs on its own task queue "vsphere-q". */
@Component
@ActivityImpl(taskQueues = TaskQueues.VSPHERE)
public class VsphereProvider extends SimulatedProvider implements ProviderActivities {
    @Override
    protected String idPrefix() {
        return "vm-";
    }
}
