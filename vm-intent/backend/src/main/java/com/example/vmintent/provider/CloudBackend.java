package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;

import java.util.List;

/**
 * A real cloud behind a provider (vCenter, VCF Automation, ...), which a RoutedProvider sends calls to
 * instead of the simulator. Every method is required, so a backend that lacks one doesn't compile
 * rather than quietly falling back to SimCloud.
 *
 * The method is handles, not owns: the backends keep their static owns(String), and Java won't allow an
 * instance method with the same signature next to it.
 */
public interface CloudBackend {

    /** Whether this VM ID is one of this backend's (by its prefix, e.g. "vcenter:"). */
    boolean handles(String vmId);

    ProviderPlan plan(VmSpec spec);

    String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey);

    VmStatus describeVm(String vmId);

    void deleteVm(String vmId);

    void resizeVm(String vmId, int vcpu, int memoryGiB);

    void setPower(String vmId, boolean on);

    String snapshotVm(String vmId, String label);

    /** Every VM this backend built, as VM IDs it handles. */
    List<String> listVmIds();
}
