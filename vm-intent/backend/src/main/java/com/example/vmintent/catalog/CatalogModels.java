package com.example.vmintent.catalog;

import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;
import java.util.Map;

/**
 * Operator-written definitions (YAML, see docs/DEFINITIONS.md) and what a catalog run reports.
 * Everything here is plain data, so it can be passed into workflows and saved in their history:
 * a run keeps a copy of the exact definition it started with, even if the definition changes later.
 */
public final class CatalogModels {
    private CatalogModels() {}

    // ------------------------------------------------------------------ definitions

    @Schema(description = "A provisioning definition: the inputs it takes and the steps it runs, in order.")
    public record Definition(
            @Schema(example = "web-server") String name,
            @Schema(description = "Goes up by one each time it's published.", example = "3") int version,
            String description,
            @Schema(description = "Who looks after this definition (team or person).", example = "platform-team") String owner,
            @Schema(description = "Default data classification code for its runs.", example = "C3") String classification,
            @Schema(description = "Blueprint whose rules every VM it builds must pass, or empty.", example = "standard-vm")
            String blueprint,
            List<InputDef> inputs,
            List<StepDef> steps,
            @Schema(description = "Hours a failed run waits for Resume or Tear down before it tears itself down "
                    + "(1-720, i.e. up to 30 days; 720 when the definition doesn't say).", example = "720") int recoveryWaitHours,
            @Schema(description = "SHA-256 of the YAML it was read from.") String sourceSha256) {}

    @Schema(description = "One input a definition takes.")
    public record InputDef(
            @Schema(example = "size") String name,
            @Schema(allowableValues = {"string", "int", "bool", "list"}) String type,
            String description,
            boolean required,
            @Schema(description = "Used when the input isn't given.") Object defaultValue,
            @Schema(description = "If set, the value must be one of these.") List<Object> allowed) {}

    /**
     * One step. with = the action's settings; a value written ${ expr } is worked out with CEL when
     * the step runs. when = run the step only if this CEL condition is true. until = for check.until.
     */
    @Schema(description = "One step of a definition.")
    public record StepDef(
            @Schema(example = "create") String id,
            @Schema(example = "vm.create") String action,
            @Schema(description = "Shown in the run's step list.", example = "Build the VM") String title,
            @Schema(description = "CEL condition; the step is skipped when it's false.") String when,
            Map<String, Object> with,
            @Schema(description = "Tries before the run stops and waits for a decision (1-10).", example = "3") int attempts,
            @Schema(description = "Longest one try may take, in minutes.", example = "30") int timeoutMinutes) {}

    @Schema(description = "A blueprint: rules (CEL conditions) that a VM spec must pass before it's built.")
    public record Blueprint(
            @Schema(example = "standard-vm") String name,
            int version,
            String description,
            @Schema(description = "CEL condition: the blueprint also applies to every catalog VM for which this is true. "
                    + "Empty = only to definitions that name it.") String appliesWhen,
            List<BlueprintRule> rules,
            String sourceSha256) {}

    public record BlueprintRule(
            @Schema(example = "prod-needs-two-cpus") String name,
            @Schema(description = "CEL condition that must be true.", example = "spec.env != 'prod' || spec.vcpu >= 2")
            String check,
            @Schema(example = "Production VMs need at least 2 vCPU.") String message) {}

    // ------------------------------------------------------------------ data classification

    @Schema(description = "A data classification: a code with its text. The code decides how long the run, "
            + "its history and its access decisions are kept.")
    public record Classification(
            @Schema(example = "C3") String code,
            @Schema(example = "Confidential") String label,
            @Schema(description = "Years to keep histories and decision logs (1-5).", example = "3") int retentionYears) {}

    // ------------------------------------------------------------------ runs

    /**
     * Everything a run needs, fixed when it starts. owner = who its VMs are for, from sign-in on the
     * server (see VmIdentity); null (as in runs started before it existed) = anonymous. requestedBy is
     * only the name recorded in the audit trail.
     */
    public record RunRequest(Definition definition, List<Blueprint> blueprints, Map<String, Object> params,
                             String requestedBy, Classification classification, boolean searchAttributes,
                             String owner) {
        public RunRequest(Definition definition, List<Blueprint> blueprints, Map<String, Object> params,
                          String requestedBy, Classification classification, boolean searchAttributes) {
            this(definition, blueprints, params, requestedBy, classification, searchAttributes, null);
        }
    }

    @Schema(description = "Where one catalog run is.")
    public record RunStatus(
            @Schema(example = "run-web-server-3f2a9c41d07e5b18") String runId,
            String definition,
            int version,
            @Schema(allowableValues = {"RUNNING", "AWAITING_RECOVERY", "AWAITING_APPROVAL", "TEARING_DOWN",
                    "COMPLETED", "TORN_DOWN", "TEARDOWN_INCOMPLETE"}) String state,
            String message,
            String requestedBy,
            Classification classification,
            Map<String, Object> params,
            List<StepState> steps,
            @Schema(description = "The step that failed, while waiting for a decision.") String failedStep,
            @Schema(description = "When the run tears itself down if nobody decides (ISO-8601).") String recoveryDeadline,
            @Schema(description = "The approval being waited for, if any.") Approval approval,
            List<String> history) {}

    @Schema(description = "One step of a run.")
    public record StepState(
            String id,
            String action,
            String title,
            @Schema(allowableValues = {"PENDING", "RUNNING", "DONE", "SKIPPED", "FAILED", "UNDONE", "UNDO_FAILED"})
            String state,
            @Schema(description = "Tries so far, counting every resume.") int attempts,
            @Schema(description = "What the step produced; later steps read it as steps.<id>.") Map<String, Object> output,
            String error,
            String startedAt,
            String finishedAt) {}

    @Schema(description = "An approval step that is waiting.")
    public record Approval(String step, String message, List<String> approvers, String deadline) {}

    /**
     * A vm.create step's VM, worked out and checked. problems = blueprint or policy rules it fails.
     * cloudName = the VM's name in its cloud, from VmIdentity.of (null in histories recorded before
     * it existed = spec.name).
     */
    public record PreparedVm(com.example.vmintent.spec.VmSpec spec, String specHash, List<String> problems,
                             String cloudName) {
        public PreparedVm(com.example.vmintent.spec.VmSpec spec, String specHash, List<String> problems) {
            this(spec, specHash, problems, null);
        }
    }

    /** What an action did. output = what later steps can read; note = a line for the run's history. */
    public record ActionResult(Map<String, Object> output, String note) {}
}
