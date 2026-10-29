package com.example.vmintent.workflow;

import com.example.vmintent.catalog.CatalogModels.ActionResult;
import com.example.vmintent.catalog.CatalogModels.Blueprint;
import com.example.vmintent.catalog.CatalogModels.PreparedVm;
import io.temporal.activity.ActivityInterface;

import java.util.List;
import java.util.Map;

/**
 * The work behind a catalog run's steps. Each method that changes something can be run again
 * safely: it looks at what is already there first (see each implementation), which is what lets a
 * failed run be resumed instead of started again.
 */
@ActivityInterface
public interface CatalogActivities {

    /** vm.create: the spec from the step's settings, checked against policy and the blueprints. */
    PreparedVm prepareVm(Map<String, Object> with, List<Blueprint> blueprints, String blueprint,
                         Map<String, Object> params, Map<String, Object> run);

    /** The VM with this spec hash if it's built or being built: state, vmId, ipAddress, ...; else null. */
    Map<String, Object> existingVm(String specHash);

    /** vm.resize, vm.power and vm.snapshot, through the VM's lifecycle workflow. */
    ActionResult changeVm(String action, Map<String, Object> with, String actor);

    /** tools.stage */
    ActionResult stageTools(Map<String, Object> with);

    /** files.copy */
    ActionResult copyFiles(Map<String, Object> with);

    /** config.apply */
    ActionResult applyConfig(Map<String, Object> with);

    /** check.until: what the VM looks like now (reachable, power, vcpu, memoryGiB, tools, files, config). */
    Map<String, Object> probe(String specHash);

    /** blueprint.deploy: asks VCF Automation for a deployment of a blueprint (or finds the one already asked for). */
    Map<String, Object> startBlueprint(Map<String, Object> with, String actor);

    /** blueprint.deploy: where that deployment is (state IN_PROGRESS, SUCCESSFUL or FAILED) and what it built. */
    Map<String, Object> blueprintStatus(String deploymentId);

    /** Undoes one step. output = what the step produced, or null if it failed part way. Returns a note. */
    String undo(String action, Map<String, Object> with, Map<String, Object> output, String actor);

    /** Records the run (catalog_run) so it's listed even after Temporal has removed it. */
    void saveRun(String workflowId, String runId, String definition, int version, String classification,
                 String requestedBy, String state, boolean finished);

    /** Logs an authorization decision made inside the run (an approval). */
    void logDecision(String actor, String action, String resource, boolean allowed, String policy, String reason,
                     String classification);
}
