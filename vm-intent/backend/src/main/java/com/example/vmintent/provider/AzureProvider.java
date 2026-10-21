package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** Azure Compute adapter (simulated). Runs on its own task queue "azure-q". */
@Component
@ActivityImpl(taskQueues = TaskQueues.AZURE)
public class AzureProvider extends SimulatedProvider implements ProviderActivities {
    @Override
    protected String idPrefix() {
        return "az-vm-";
    }
}
