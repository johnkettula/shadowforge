package com.example.vmintent.catalog;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

/**
 * Where the catalog actions do their work, on one PC. Stands in for the real systems:
 *
 *   file store   (vmintent.catalog.files-dir)    the source of files and tool bundles, like a MinIO bucket
 *                                                or an SSH file server: any folders (web/...), and bundles/<name>/<version>/...
 *   targets      (vmintent.catalog.targets-dir)  one folder per VM (by spec hash) standing in for its disk:
 *                                                fs/... (copied files), tools/<bundle>/ and config.json
 *
 * Every write is made so that a step that dies part way can be run again: files are written under
 * a .part name and renamed only when complete and checked, so a file is either all there or not at all.
 */
@Component
public class TargetStore {

    private static final Logger log = LoggerFactory.getLogger(TargetStore.class);
    public static final String PART = ".part";
    static final String INSTALLED = ".installed";

    private final Path files;
    private final Path targets;
    private final ObjectMapper json = new ObjectMapper();

    public TargetStore(@Value("${vmintent.catalog.files-dir:${user.home}/.vm-intent/files}") String filesDir,
                       @Value("${vmintent.catalog.targets-dir:${user.home}/.vm-intent/targets}") String targetsDir) {
        this.files = Path.of(filesDir).toAbsolutePath().normalize();
        this.targets = Path.of(targetsDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.files);
            Files.createDirectories(this.targets);
            seedExamples();
        } catch (IOException e) {
            throw new IllegalStateException("Can't use the catalog folders " + files + " and " + targets + ": " + e.getMessage(), e);
        }
    }

    public Path filesDir() {
        return files;
    }

    public Path targetsDir() {
        return targets;
    }

    /** A VM's folder. specHash is checked so it can't point anywhere else. */
    public Path target(String specHash) {
        if (specHash == null || !specHash.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("vm must be a VM's 64-character spec hash, like ${ steps.create.specHash }");
        }
        return targets.resolve(specHash);
    }

    /** A path inside the file store; refuses anything that would leave it. */
    public Path source(String relative) {
        return inside(files, relative, "files");
    }

    /** A path on the VM ("/srv/app/a.txt") inside its folder. */
    public Path onVm(String specHash, String vmPath) {
        return inside(target(specHash).resolve("fs"), vmPath.replaceFirst("^/+", ""), "to");
    }

    static Path inside(Path root, String relative, String what) {
        if (relative == null || relative.isBlank()) throw new IllegalArgumentException(what + ": empty path");
        Path p = root.resolve(relative.replace('\\', '/')).normalize();
        if (!p.startsWith(root)) throw new IllegalArgumentException(what + ": '" + relative + "' leaves the allowed folder");
        return p;
    }

    // ------------------------------------------------------------------ copying

    public record CopyOutcome(String path, String outcome, long bytes, String sha256) {}

    /**
     * Copies one file so that a copy that dies part way leaves nothing that looks finished:
     * if the target already has a file with the same SHA-256 it's skipped; otherwise the file is
     * written to name.part, flushed to disk, checked, and renamed over the target in one step.
     */
    public CopyOutcome copy(Path from, Path to) throws IOException {
        if (!Files.isRegularFile(from)) throw new java.nio.file.NoSuchFileException(files.relativize(from) + " isn't in the file store");
        String want = sha256(from);
        if (Files.isRegularFile(to) && sha256(to).equals(want)) {
            return new CopyOutcome(to.toString(), "already there", Files.size(to), want);
        }
        Files.createDirectories(to.getParent());
        Path part = to.resolveSibling(to.getFileName() + PART);
        try (InputStream in = Files.newInputStream(from);
             FileChannel ch = FileChannel.open(part, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
             OutputStream out = java.nio.channels.Channels.newOutputStream(ch)) {
            in.transferTo(out);
            out.flush();
            ch.force(true);
        }
        String got = sha256(part);
        if (!got.equals(want)) {
            Files.deleteIfExists(part);
            throw new IOException("copy of " + from.getFileName() + " came out different (SHA-256 " + got + ", expected " + want + ")");
        }
        Files.move(part, to, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        return new CopyOutcome(to.toString(), "copied", Files.size(to), want);
    }

    /** Removes .part files left in a folder (and below) by a copy that died. Returns how many. */
    public int removeLeftovers(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return 0;
        List<Path> parts;
        try (Stream<Path> s = Files.walk(dir)) {
            parts = s.filter(p -> p.getFileName().toString().endsWith(PART)).toList();
        }
        for (Path p : parts) Files.deleteIfExists(p);
        return parts.size();
    }

    // ------------------------------------------------------------------ tools

    public Path bundleSource(String bundle, String version) {
        return source("bundles/" + bundle + "/" + version);
    }

    public Path toolDir(String specHash, String bundle) {
        return inside(target(specHash).resolve("tools"), bundle, "bundle");
    }

    /** The installed version, or null. A folder without the marker is a half install. */
    public String installedVersion(String specHash, String bundle) throws IOException {
        Path marker = toolDir(specHash, bundle).resolve(INSTALLED);
        return Files.isRegularFile(marker) ? Files.readString(marker).trim() : null;
    }

    public void markInstalled(String specHash, String bundle, String version) throws IOException {
        Path marker = toolDir(specHash, bundle).resolve(INSTALLED);
        Path part = marker.resolveSibling(INSTALLED + PART);
        Files.writeString(part, version);
        Files.move(part, marker, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    public Map<String, String> installedTools(String specHash) throws IOException {
        Map<String, String> out = new TreeMap<>();
        Path dir = target(specHash).resolve("tools");
        if (!Files.isDirectory(dir)) return out;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path b : ds) {
                String v = installedVersion(specHash, b.getFileName().toString());
                if (v != null) out.put(b.getFileName().toString(), v);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ config

    public Map<String, Object> readConfig(String specHash) throws IOException {
        Path f = target(specHash).resolve("config.json");
        if (!Files.isRegularFile(f)) return new LinkedHashMap<>();
        return json.readValue(f.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {});
    }

    public void writeConfig(String specHash, Map<String, Object> config) throws IOException {
        Path f = target(specHash).resolve("config.json");
        Files.createDirectories(f.getParent());
        Path part = f.resolveSibling("config.json" + PART);
        Files.writeString(part, json.writerWithDefaultPrettyPrinter().writeValueAsString(new TreeMap<>(config)));
        Files.move(part, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }

    public long fileCount(String specHash) throws IOException {
        Path fs = target(specHash).resolve("fs");
        if (!Files.isDirectory(fs)) return 0;
        try (Stream<Path> s = Files.walk(fs)) {
            return s.filter(Files::isRegularFile).filter(p -> !p.getFileName().toString().endsWith(PART)).count();
        }
    }

    public static void deleteTree(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        try (Stream<Path> s = Files.walk(dir)) {
            for (Path p : s.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
        }
    }

    public static String sha256(Path f) throws IOException {
        try (InputStream in = Files.newInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            return HexFormat.of().formatHex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ------------------------------------------------------------------ examples

    /** A few files and bundles the built-in definitions use, so they work on a fresh PC. */
    private void seedExamples() throws IOException {
        List<String[]> seed = new ArrayList<>();
        seed.add(new String[]{"web/index.html", "<!doctype html><title>vm-intent</title><h1>Hello from a catalog run</h1>\n"});
        seed.add(new String[]{"web/app.conf", "listen 80;\nroot /srv/www;\n"});
        seed.add(new String[]{"web/robots.txt", "User-agent: *\nDisallow:\n"});
        seed.add(new String[]{"bundles/nginx/1.27/install.sh", "#!/bin/sh\necho installing nginx 1.27\n"});
        seed.add(new String[]{"bundles/nginx/1.27/nginx.conf", "worker_processes auto;\n"});
        seed.add(new String[]{"bundles/node-exporter/1.8/install.sh", "#!/bin/sh\necho installing node-exporter 1.8\n"});
        int made = 0;
        for (String[] s : seed) {
            Path p = files.resolve(s[0]);
            if (Files.exists(p)) continue;
            Files.createDirectories(p.getParent());
            Files.writeString(p, s[1], StandardCharsets.UTF_8);
            made++;
        }
        if (made > 0) log.info("Catalog: example files and bundles added to {}", files);
    }
}
