package com.example.vmintent.spec;

/**
 * A VM's identity: its spec hash, and the workflow IDs built from it. Every place that hashes a
 * spec or names a VM's build or lifecycle workflow goes through here, so the identity is defined
 * once.
 *
 * <p>owner = who the VM is for, taken from sign-in on the server (see api.RequestOwner), never from
 * a userId or requestedBy in a request body. A null owner and "anonymous" both mean nobody is
 * signed in.
 *
 * <p>Today the owner doesn't change the hash: every owner gets {@link SpecCanonicalizer#hash}, so
 * existing VMs keep their hash and their workflow IDs. The per-user identity feature will change
 * only the branch for owners that aren't anonymous; the anonymous hash must never change.
 */
public final class VmIdentity {

    public static final String ANONYMOUS = "anonymous";

    private VmIdentity() {}

    /** The spec hash of this spec for this owner (null or "anonymous" = nobody signed in). */
    public static String hash(VmSpec spec, String owner) {
        if (isAnonymous(owner)) return SpecCanonicalizer.hash(spec);
        // Per-user identity isn't switched on yet: a signed-in owner gets the same hash as anyone.
        return SpecCanonicalizer.hash(spec);
    }

    /** True for null and "anonymous": nobody is signed in. */
    public static boolean isAnonymous(String owner) {
        return owner == null || ANONYMOUS.equals(owner);
    }

    /** ID of the VmReconcileWorkflow that builds the VM. */
    public static String buildWorkflowId(String hash) {
        return "vm-" + hash;
    }

    /** ID of the VmLifecycleWorkflow that looks after the VM once it runs. */
    public static String lifecycleWorkflowId(String hash) {
        return "life-" + hash;
    }
}
