package com.example.vmintent.api;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** The owner comes from sign-in only: the signed-in name, else "anonymous". */
class RequestOwnerTest {

    @AfterEach
    void signOut() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void nobodySignedInIsAnonymous() {
        SecurityContextHolder.clearContext();
        assertEquals("anonymous", RequestOwner.current());
    }

    @Test
    void springsAnonymousTokenIsAnonymous() {
        SecurityContextHolder.getContext().setAuthentication(new AnonymousAuthenticationToken("key", "anonymousUser",
                AuthorityUtils.createAuthorityList("ROLE_ANONYMOUS")));
        assertEquals("anonymous", RequestOwner.current());
    }

    @Test
    void aSignedInCallerIsTheOwner() {
        signIn("alice");
        assertEquals("alice", RequestOwner.current());
    }

    static void signIn(String name) {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(name, null, List.of()));
    }
}
