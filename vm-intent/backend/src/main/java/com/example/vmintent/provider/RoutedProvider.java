package com.example.vmintent.provider;

import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.failure.ApplicationFailure;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * A provider whose VMs may live on real clouds (CloudBackends) as well as the simulator.
 *   - A build (plan, createVm) goes to backendForBuild(spec), or to the simulator when that is null.
 *   - Every later call goes by the VM ID: to the first of backends() that handles it, else the simulator.
 *     An ID a backend handles never reaches SimCloud: if that backend isn't set up, the call fails with
 *     a non-retryable NotSetUp failure.
 *   - listVmIds is the simulator's VMs plus those of every backend that is set up.
 */
public abstract class RoutedProvider extends SimulatedProvider {

    /**
     * A backend this provider can send calls to.
     *
     * @param handles which VM IDs are the backend's; answers even when the backend isn't set up
     * @param setUp   whether the backend is set up
     * @param backend the backend; when it isn't set up, throws the non-retryable NotSetUp failure the user sees
     */
    protected record Backend(Predicate<String> handles, BooleanSupplier setUp, Supplier<? extends CloudBackend> backend) {

        CloudBackend require() {
            CloudBackend b = backend.get();
            if (b == null || !setUp.getAsBoolean()) {
                throw ApplicationFailure.newNonRetryableFailure("The backend for this VM isn't set up", VsphereRoutes.NOT_SET_UP);
            }
            return b;
        }
    }

    protected RoutedProvider(SimCloud cloud) {
        super(cloud);
    }

    /** The backend that builds this spec, or null for the simulator. Throws NotSetUp when it's chosen but not set up. */
    protected abstract CloudBackend backendForBuild(VmSpec spec);

    /** Every backend this provider can send calls to, set up or not. */
    protected abstract List<Backend> backends();

    /** The backend that handles this VM ID, or null for the simulator. */
    private CloudBackend backendFor(String vmId) {
        for (Backend b : backends()) {
            if (b.handles().test(vmId)) return b.require();
        }
        return null;
    }

    @Override
    public ProviderPlan plan(VmSpec spec) {
        CloudBackend b = backendForBuild(spec);
        return b != null ? b.plan(spec) : super.plan(spec);
    }

    @Override
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        CloudBackend b = backendForBuild(spec);
        return b != null ? b.createVm(spec, plan, idempotencyKey) : super.createVm(spec, plan, idempotencyKey);
    }

    @Override
    public VmStatus describeVm(String vmId) {
        CloudBackend b = backendFor(vmId);
        return b != null ? b.describeVm(vmId) : super.describeVm(vmId);
    }

    @Override
    public void deleteVm(String vmId) {
        CloudBackend b = backendFor(vmId);
        if (b != null) b.deleteVm(vmId);
        else super.deleteVm(vmId);
    }

    @Override
    public void resizeVm(String vmId, int vcpu, int memoryGiB) {
        CloudBackend b = backendFor(vmId);
        if (b != null) b.resizeVm(vmId, vcpu, memoryGiB);
        else super.resizeVm(vmId, vcpu, memoryGiB);
    }

    @Override
    public void setPower(String vmId, boolean on) {
        CloudBackend b = backendFor(vmId);
        if (b != null) b.setPower(vmId, on);
        else super.setPower(vmId, on);
    }

    @Override
    public String snapshotVm(String vmId, String label) {
        CloudBackend b = backendFor(vmId);
        return b != null ? b.snapshotVm(vmId, label) : super.snapshotVm(vmId, label);
    }

    @Override
    public List<String> listVmIds() {
        List<String> ids = new ArrayList<>(super.listVmIds());
        for (Backend b : backends()) {
            if (b.setUp().getAsBoolean()) ids.addAll(b.backend().get().listVmIds());
        }
        return ids;
    }
}
