package com.example.vmintent.audit;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.HexFormat;

/**
 * Write-once storage for closed workflow histories (vmintent.audit.archive-dir).
 *
 *   <archive>/<retention>y/<classification>/<year>/<month>/<workflow id>/<run id>.json   the history
 *                                                                          ... .json.sha256  its SHA-256
 *
 * A file is created once and never written again: a second write of the same history is a no-op,
 * a different one is refused, and each file is made read-only. Only the archive sweep removes a
 * file, at the end of its retention. Reads check the SHA-256, so a changed file is reported.
 *
 * This is a folder (a persistent volume in Kubernetes). For storage that even an administrator
 * can't change before the retention ends, point it at a bucket with object lock in compliance
 * mode (S3, or MinIO); see docs/AUDIT.md.
 */
@Component
public class ArchiveStore {

    public record Stored(String path, String sha256, long sizeBytes, boolean alreadyThere) {}

    private final Path root;

    public ArchiveStore(@Value("${vmintent.audit.archive-dir:${user.home}/.vm-intent/archive}") String dir) {
        this.root = Path.of(dir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(root);
        } catch (IOException e) {
            throw new IllegalStateException("Can't use the archive folder " + root + ": " + e.getMessage(), e);
        }
    }

    public Path root() {
        return root;
    }

    /** Where a history goes; the path is relative to the archive folder. */
    public static String pathFor(int retentionYears, String classification, Instant closedAt, String workflowId, String runId) {
        ZonedDateTime t = (closedAt == null ? Instant.EPOCH : closedAt).atZone(ZoneOffset.UTC);
        return retentionYears + "y/" + safe(classification) + "/" + t.getYear() + "/" + String.format("%02d", t.getMonthValue())
                + "/" + safe(workflowId) + "/" + safe(runId) + ".json";
    }

    public Stored write(String relativePath, String content) throws IOException {
        Path file = resolve(relativePath);
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        String sha = sha256(bytes);
        Files.createDirectories(file.getParent());
        try {
            Files.write(file, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        } catch (FileAlreadyExistsException e) {
            String existing = sha256(Files.readAllBytes(file));
            if (!existing.equals(sha)) {
                throw new IOException(relativePath + " is already archived with different content; archived files are never replaced");
            }
            return new Stored(relativePath, sha, bytes.length, true);
        }
        Path sidecar = file.resolveSibling(file.getFileName() + ".sha256");
        Files.writeString(sidecar, sha + "  " + file.getFileName() + "\n", StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        file.toFile().setWritable(false, false);
        sidecar.toFile().setWritable(false, false);
        return new Stored(relativePath, sha, bytes.length, false);
    }

    /** The file's content. Throws if it's gone or its SHA-256 isn't expectedSha256 (when given). */
    public String read(String relativePath, String expectedSha256) throws IOException {
        byte[] bytes = Files.readAllBytes(resolve(relativePath));
        if (expectedSha256 != null && !sha256(bytes).equals(expectedSha256)) {
            throw new IOException(relativePath + " has changed since it was archived (SHA-256 doesn't match)");
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /** Removes a file at the end of its retention. */
    public boolean delete(String relativePath) throws IOException {
        Path file = resolve(relativePath);
        Path sidecar = file.resolveSibling(file.getFileName() + ".sha256");
        file.toFile().setWritable(true, true);
        sidecar.toFile().setWritable(true, true);
        Files.deleteIfExists(sidecar);
        return Files.deleteIfExists(file);
    }

    private Path resolve(String relativePath) {
        Path p = root.resolve(relativePath).normalize();
        if (!p.startsWith(root)) throw new IllegalArgumentException("Not an archive path: " + relativePath);
        return p;
    }

    /** Workflow IDs can hold ':' and other characters some file systems don't allow. */
    static String safe(String s) {
        return s == null ? "_" : s.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
