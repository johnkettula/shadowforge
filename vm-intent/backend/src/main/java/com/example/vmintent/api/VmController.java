package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.ApiError;
import com.example.vmintent.api.ApiModels.CheckStarted;
import com.example.vmintent.api.ApiModels.DecommissionBody;
import com.example.vmintent.api.ApiModels.PowerBody;
import com.example.vmintent.api.ApiModels.RenewBody;
import com.example.vmintent.api.ApiModels.ResizeBody;
import com.example.vmintent.api.ApiModels.SnapshotBody;
import com.example.vmintent.db.InventoryActivitiesImpl;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.security.ApiAccessRules;
import com.example.vmintent.security.Caller;
import com.example.vmintent.workflow.InventoryCheckWorkflow;
import com.example.vmintent.workflow.Models.InventoryReport;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.VmLifecycleWorkflow;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowOptions;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.function.Function;

/**
 * A VM's life after its build ("day 2"): expiry and renewal, resize, power, snapshots and removal.
 * Each change is a Temporal update to the VM's lifecycle workflow ("life-" + spec hash): it is
 * checked first, and the answer comes back once the change is done (or why it was refused: 409).
 *
 * Also the inventory check (drift and orphans), which runs nightly on a Temporal Schedule.
 */
@RestController
@RequestMapping("/api/v2")
public class VmController {

    private static final String REFUSED = "Refused: the VM isn't in a state that allows this (the message says why)";

    private final WorkflowClient client;
    private final VmRegistry registry;
    private final InventoryActivitiesImpl inventory;
    private final com.example.vmintent.audit.DecisionLog decisions;

    public VmController(WorkflowClient client, VmRegistry registry, InventoryActivitiesImpl inventory,
                        com.example.vmintent.audit.DecisionLog decisions) {
        this.client = client;
        this.registry = registry;
        this.inventory = inventory;
        this.decisions = decisions;
    }

    // ------------------------------------------------------------------ lifecycle

    @Tag(name = "VM lifecycle")
    @Operation(operationId = "getVmLifecycle", summary = "Get a VM's lifecycle",
            description = "Expiry date, whether the warning was sent, power, current size, snapshots and recent events. "
                    + "Live from the lifecycle workflow while the VM exists; from the inventory after it's removed.")
    @ApiResponse(responseCode = "200", description = "The lifecycle")
    @ApiResponse(responseCode = "404", description = "No such VM, or one built before lifecycles existed",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @GetMapping("/vms/{specHash}/lifecycle")
    public VmLifecycle lifecycle(@Parameter(description = "The VM's spec hash") @PathVariable String specHash) {
        try {
            return life(specHash).status();
        } catch (WorkflowNotFoundException e) {
            VmRecord r = registry.get(specHash);
            if (r != null && r.lifecycle() != null) return r.lifecycle();
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No lifecycle for that VM");
        }
    }

    @Tag(name = "VM lifecycle")
    @Operation(operationId = "renewVm", summary = "Renew a VM", description = "Pushes the expiry back by 1 to 90 days "
            + "(at most 365 days from today). A VM that never expires can't be renewed.")
    @ApiResponse(responseCode = "200", description = "Renewed; the new lifecycle")
    @ApiResponse(responseCode = "409", description = REFUSED, content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/vms/{specHash}/renew")
    public VmLifecycle renew(@PathVariable String specHash, @RequestBody RenewBody body) {
        return change(specHash, life -> life.renew(actor(), body.days()));
    }

    @Tag(name = "VM lifecycle")
    @Operation(operationId = "resizeVm", summary = "Resize a VM", description = "Changes vCPU and memory. "
            + "If the cloud refuses, nothing changes and the reason comes back (409).")
    @ApiResponse(responseCode = "200", description = "Resized; the new lifecycle")
    @ApiResponse(responseCode = "409", description = REFUSED, content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/vms/{specHash}/resize")
    public VmLifecycle resize(@PathVariable String specHash, @RequestBody ResizeBody body) {
        return change(specHash, life -> life.resize(actor(), body.vcpu(), body.memoryGiB()));
    }

    @Tag(name = "VM lifecycle")
    @Operation(operationId = "powerVm", summary = "Power a VM on or off")
    @ApiResponse(responseCode = "200", description = "Done; the new lifecycle")
    @ApiResponse(responseCode = "409", description = REFUSED, content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/vms/{specHash}/power")
    public VmLifecycle power(@PathVariable String specHash, @RequestBody PowerBody body) {
        return change(specHash, life -> life.power(actor(), body.on()));
    }

    @Tag(name = "VM lifecycle")
    @Operation(operationId = "snapshotVm", summary = "Snapshot a VM", description = "Up to 20 snapshots per VM.")
    @ApiResponse(responseCode = "200", description = "Snapshot taken; the new lifecycle")
    @ApiResponse(responseCode = "409", description = REFUSED, content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/vms/{specHash}/snapshot")
    public VmLifecycle snapshot(@PathVariable String specHash, @RequestBody SnapshotBody body) {
        return change(specHash, life -> life.snapshot(actor(), body.label()));
    }

    @Tag(name = "VM lifecycle")
    @Operation(operationId = "decommissionVm", summary = "Remove a VM now",
            description = "Deletes the VM from its cloud and marks it DELETED. This can't be undone.")
    @ApiResponse(responseCode = "200", description = "Removed; the final lifecycle")
    @ApiResponse(responseCode = "409", description = REFUSED, content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/vms/{specHash}/decommission")
    public VmLifecycle decommission(@PathVariable String specHash, @RequestBody(required = false) DecommissionBody body) {
        return change(specHash, life -> life.decommission(actor(), body == null ? null : body.reason()));
    }

    // ------------------------------------------------------------------ inventory check

    @Tag(name = "Inventory")
    @Operation(operationId = "listInventoryChecks", summary = "Latest inventory checks",
            description = "Results of the nightly check (and any run by hand), newest first: VMs that disappeared from "
                    + "their cloud (now MISSING) and VMs in a cloud that nobody recorded (orphans; never deleted "
                    + "automatically). Clouds behind the one-way link are skipped.")
    @GetMapping("/inventory-checks")
    public List<InventoryReport> checks(@Parameter(description = "Most to return (1-50)") @RequestParam(defaultValue = "10") int limit) {
        return inventory.latest(Math.max(1, Math.min(limit, 50)));
    }

    @Tag(name = "Inventory")
    @Operation(operationId = "runInventoryCheck", summary = "Run the inventory check now",
            description = "Starts it straight away instead of waiting for the night. The result appears in "
                    + "GET /api/v2/inventory-checks when it finishes, usually within a minute.")
    @ApiResponse(responseCode = "202", description = "Started")
    @PostMapping("/inventory-checks")
    public ResponseEntity<CheckStarted> runCheck() {
        String id = "inventory-check-manual-" + System.currentTimeMillis();
        InventoryCheckWorkflow wf = client.newWorkflowStub(InventoryCheckWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::run);
        return ResponseEntity.accepted().body(new CheckStarted(id));
    }

    // ------------------------------------------------------------------ helpers

    private VmLifecycle change(String specHash, Function<VmLifecycleWorkflow, VmLifecycle> update) {
        VmLifecycleWorkflow life = life(specHash);
        requireOwner(specHash, life);
        try {
            return update.apply(life);
        } catch (WorkflowNotFoundException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, gone(specHash));
        }
    }

    /** With sign-in on, only the VM's owner or an ADMIN may change it. */
    private void requireOwner(String specHash, VmLifecycleWorkflow life) {
        String me = Caller.signedIn();
        if (me == null || Caller.hasRole(ApiAccessRules.Role.ADMIN)) return;
        String owner;
        try {
            owner = life.status().owner();
        } catch (WorkflowNotFoundException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, gone(specHash));
        }
        boolean allowed = owner == null || owner.equals(me);
        decisions.record(me, String.join(",", Caller.roles()), "vm.change", "vm/" + specHash, allowed, "VM owner or ADMIN",
                allowed ? "owns the VM" : "the VM belongs to " + owner, null);
        if (!allowed) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only the VM's owner, or an admin, can change it.");
        }
    }

    private String gone(String specHash) {
        VmRecord r = registry.get(specHash);
        if (r == null) return "No VM with that spec hash";
        return "This VM is " + r.state().toLowerCase() + ", so it can't be changed"
                + (r.lifecycle() == null && "RUNNING".equals(r.state()) ? " (it was built before lifecycles existed)" : "");
    }

    private VmLifecycleWorkflow life(String specHash) {
        if (!specHash.matches("[0-9a-f]{64}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "specHash must be the 64-character SHA-256 hex string");
        }
        return client.newWorkflowStub(VmLifecycleWorkflow.class, "life-" + specHash);
    }

    private static String actor() {
        return Caller.nameOr(null, "demo-user");
    }
}
