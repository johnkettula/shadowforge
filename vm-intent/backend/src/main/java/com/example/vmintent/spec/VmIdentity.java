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
 * <p>Anonymous owners get {@link SpecCanonicalizer#hash}, which must never change. A signed-in owner
 * gets the SHA-256 of {@link #ownedString}, which covers the owner too, so duplicates are found
 * within one user and two users who ask for the same spec get two VMs. Nothing recomputes the hash
 * of a VM that exists: day-2 calls, lifecycle and inventory look it up by its stored hash.
 */
public final class VmIdentity {

    public static final String ANONYMOUS = "anonymous";

    private VmIdentity() {}

    /** The spec hash of this spec for this owner (null or "anonymous" = nobody signed in). */
    public static String hash(VmSpec spec, String owner) {
        if (isAnonymous(owner)) return SpecCanonicalizer.hash(spec);
        return SpecCanonicalizer.sha256Hex(ownedString(spec, owner));
    }

    /**
     * What a signed-in owner's hash is taken of: "owner:" + the owner's length + ":" + the owner +
     * the spec's canonical string. A canonical string always starts with "{", so no anonymous spec
     * hashes the same input; the length keeps owners that end in "{..." apart.
     */
    static String ownedString(VmSpec spec, String owner) {
        return "owner:" + owner.length() + ":" + owner + SpecCanonicalizer.canonicalString(spec);
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

    /**
     * The build key a cloud records on the VM it builds: the spec hash, or the hash + "-" + the first
     * 8 characters of the build's run ID (null or "" = just the hash).
     */
    public static String buildKey(String hash, String runIdPrefix) {
        return runIdPrefix == null || runIdPrefix.isEmpty() ? hash : hash + "-" + runIdPrefix;
    }

    /**
     * The spec hash part of a build key (the part before the first "-"). Two keys with the same hash
     * are builds of the same VM; null stays null.
     */
    public static String hashOfBuildKey(String key) {
        if (key == null) return null;
        int i = key.indexOf('-');
        return i < 0 ? key : key.substring(0, i);
    }

    /**
     * True when two build keys have the same spec hash: a retry, or a new run of the same VM. A cloud
     * adopts an existing VM with the requested name only then.
     */
    public static boolean sameBuild(String recordedKey, String newKey) {
        String h = hashOfBuildKey(recordedKey);
        return h != null && !h.isEmpty() && h.equals(hashOfBuildKey(newKey));
    }
}
