package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** AWS EC2 adapter (simulated). Runs on its own task queue "aws-q". */
@Component
@ActivityImpl(taskQueues = TaskQueues.AWS)
public class AwsProvider extends SimulatedProvider implements ProviderActivities {
    @Override
    protected String idPrefix() {
        return "i-";
    }
}
