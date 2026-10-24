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

    /** The signed-in caller's roles (without ROLE_), or an empty list. */
    public static java.util.List<String> roles() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || a instanceof AnonymousAuthenticationToken) return java.util.List.of();
        return a.getAuthorities().stream().map(g -> g.getAuthority())
                .filter(r -> r.startsWith("ROLE_")).map(r -> r.substring(5)).sorted().toList();
    }

    /** True if the signed-in caller has any of the roles (directly, not through the hierarchy). */
    public static boolean hasAnyRole(ApiAccessRules.Role... roles) {
        for (ApiAccessRules.Role r : roles) if (hasRole(r)) return true;
        return false;
    }

    /** True if the signed-in caller has the role (directly, not through the hierarchy). */
    public static boolean hasRole(ApiAccessRules.Role role) {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getAuthorities().stream().anyMatch(g -> g.getAuthority().equals("ROLE_" + role.name()));
    }
}
