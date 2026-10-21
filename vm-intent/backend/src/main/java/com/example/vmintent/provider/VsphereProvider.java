package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** VMware vSphere adapter (simulated). Polls "vsphere-q" (create/delete) and "vsphere-read-q" (plan/describe). */
@Component
@ActivityImpl(taskQueues = {TaskQueues.VSPHERE, TaskQueues.VSPHERE_READ})
public class VsphereProvider extends SimulatedProvider {
    public VsphereProvider(SimCloud cloud) {
        super(cloud);
    }

    @Override
    protected String providerName() {
        return "vsphere";
    }

    @Override
    protected String idPrefix() {
        return "vm-";
    }
}
