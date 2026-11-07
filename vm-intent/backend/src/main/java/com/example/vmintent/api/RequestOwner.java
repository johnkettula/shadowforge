package com.example.vmintent.api;

import com.example.vmintent.security.Caller;
import com.example.vmintent.spec.VmIdentity;

/**
 * Who a request is for, as far as a VM's identity goes (see VmIdentity): the signed-in name, or
 * "anonymous" when nobody is signed in. Only sign-in counts: unlike the audit names (userId,
 * requestedBy), it never falls back to anything the client sent.
 */
public final class RequestOwner {

    private RequestOwner() {}

    public static String current() {
        String me = Caller.signedIn();
        return me == null ? VmIdentity.ANONYMOUS : me;
    }
}
