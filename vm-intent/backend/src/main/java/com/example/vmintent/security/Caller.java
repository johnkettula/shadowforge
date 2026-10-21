package com.example.vmintent.security;

import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * Who is calling. When sign-in is on, this is the signed-in user or service, and it overrides
 * any userId / requestedBy in the request body, so callers can't act as someone else in the
 * audit trail. When sign-in is off, the body's value (or a default) is used.
 */
public final class Caller {

    private Caller() {}

    /** The signed-in caller's name, or null if nobody is signed in. */
    public static String signedIn() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || !a.isAuthenticated() || a instanceof AnonymousAuthenticationToken) return null;
        return a.getName();
    }

    /** The signed-in caller, else the claimed name, else the fallback. */
    public static String nameOr(String claimed, String fallback) {
        String s = signedIn();
        if (s != null) return s;
        return claimed == null || claimed.isBlank() ? fallback : claimed;
    }

    /** True if the signed-in caller has the role (directly, not through the hierarchy). */
    public static boolean hasRole(ApiAccessRules.Role role) {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getAuthorities().stream().anyMatch(g -> g.getAuthority().equals("ROLE_" + role.name()));
    }
}
