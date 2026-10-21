package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** Azure Compute adapter (simulated). Polls "azure-q" (create/delete) and "azure-read-q" (plan/describe). */
@Component
@ActivityImpl(taskQueues = {TaskQueues.AZURE, TaskQueues.AZURE_READ})
public class AzureProvider extends SimulatedProvider {
    public AzureProvider(SimCloud cloud) {
        super(cloud);
    }

    @Override
    protected String providerName() {
        return "azure";
    }

    @Override
    protected String idPrefix() {
        return "az-vm-";
    }
}
