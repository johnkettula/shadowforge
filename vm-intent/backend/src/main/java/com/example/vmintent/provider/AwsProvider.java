package com.example.vmintent.provider;

import com.example.vmintent.workflow.TaskQueues;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

/** AWS EC2 adapter (simulated). Polls "aws-q" (create/delete) and "aws-read-q" (plan/describe). */
@Component
@ActivityImpl(taskQueues = {TaskQueues.AWS, TaskQueues.AWS_READ})
public class AwsProvider extends SimulatedProvider {
    public AwsProvider(SimCloud cloud) {
        super(cloud);
    }

    @Override
    protected String providerName() {
        return "aws";
    }

    @Override
    protected String idPrefix() {
        return "i-";
    }
}
