package com.example.vmintent.spec;

import org.mockito.MockedStatic;
import org.mockito.Mockito;

import java.util.List;
import java.util.function.Supplier;

/**
 * Records the owner every VmIdentity.hash call receives while a piece of code runs, and still
 * returns the real hash. A static spy only sees calls on the thread that made it, so wrap the code
 * where it runs (an activity method runs on a worker thread, not the test's).
 */
public final class HashOwnerSpy {

    private HashOwnerSpy() {}

    public static <T> T recording(List<String> owners, Supplier<T> call) {
        try (MockedStatic<VmIdentity> spy = Mockito.mockStatic(VmIdentity.class, invocation -> {
            if (invocation.getMethod().getName().equals("hash")) owners.add(invocation.getArgument(1));
            return invocation.callRealMethod();
        })) {
            return call.get();
        }
    }
}
