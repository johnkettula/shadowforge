package com.example.vmintent.workflow;

import com.example.vmintent.db.AuditLog;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Activities are normal Spring beans, so they can use injected services. */
@Component
@ActivityImpl(taskQueues = TaskQueues.INTENT)
public class WorkflowActivitiesImpl implements IntentActivities, RecordActivities {

    private final IntentInterpreter interpreter;
    private final VmRegistry registry;
    private final AuditLog auditLog;

    public WorkflowActivitiesImpl(IntentInterpreter interpreter, VmRegistry registry, AuditLog auditLog) {
        this.interpreter = interpreter;
        this.registry = registry;
        this.auditLog = auditLog;
    }

    @Override
    public Interpretation interpret(String text, String owner) {
        return interpreter.interpret(text, owner);
    }

    @Override
    public String findExistingVm(String specHash) {
        VmRecord r = registry.get(specHash);
        if (r == null) return null;
        if ("RUNNING".equals(r.state()) && r.result() != null) return r.result().vmId();
        if ("PROVISIONING".equals(r.state())) return "provisioning";
        return null;   // FAILED or DELETED: OK to build again
    }

    @Override
    public List<BatchItem> expand(Interpretation it, String owner) {
        int n = it.vmCount();
        List<BatchItem> items = new ArrayList<>(n);
        for (int i = 1; i <= n; i++) {
            VmSpec spec = it.spec().withName(String.format("%s-%02d", it.spec().name(), i));
            VmIdentity.Id id = VmIdentity.of(spec, owner);
            items.add(new BatchItem(spec, id.hash(), id.cloudName()));
        }
        return items;
    }

    @Override
    public void saveLifecycle(String specHash, String state, VmLifecycle lifecycle) {
        registry.putLifecycle(specHash, state, lifecycle);
    }

    @Override
    public void save(String specHash, VmSpec spec, String state, String detail, VmResult result) {
        registry.put(new VmRecord(specHash, spec, state, detail, result, Instant.now().toString()));
    }

    @Override
    public void audit(String requestId, String specHash, String event, String actor, String detail) {
        auditLog.record(requestId, specHash, event, actor, detail);
    }
}
