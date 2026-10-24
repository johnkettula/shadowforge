package com.example.vmintent.catalog;

import com.example.vmintent.catalog.CatalogModels.Blueprint;
import com.example.vmintent.catalog.CatalogModels.Definition;
import io.swagger.v3.oas.annotations.media.Schema;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * The published definitions and blueprints, stored in Postgres (catalog_definition) so every API
 * process sees the same ones. A published version never changes: to change a definition, publish
 * it again with a higher version. Runs keep a copy of the version they started with.
 *
 * The usual way in is a merge request in Git: the definitions live in a repository, reviewers
 * approve the change, and the pipeline publishes it (deploy/catalog/publish.sh). The examples in
 * src/main/resources/catalog are published at startup as "built-in" if they're not there yet.
 */
@Component
@ConditionalOnWebApplication
public class DefinitionCatalog {

    private static final Logger log = LoggerFactory.getLogger(DefinitionCatalog.class);

    @Schema(description = "One published version.")
    public record Entry(
            @Schema(allowableValues = {"Provisioning", "Blueprint"}) String kind,
            String name, int version, String description, String sha256, String publishedBy, String publishedAt,
            boolean retired) {}

    @Schema(description = "What publishing did.")
    public record PublishResult(
            @Schema(allowableValues = {"PUBLISHED", "UNCHANGED", "REFUSED"}) String outcome,
            String kind, String name, int version,
            @Schema(description = "Why it was refused: every problem found, each as 'where: what'.") List<String> problems) {}

    private final JdbcClient jdbc;
    private final ClassificationCatalog classifications;

    public DefinitionCatalog(JdbcClient jdbc, ClassificationCatalog classifications) {
        this.jdbc = jdbc;
        this.classifications = classifications;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void publishBuiltIns() {
        try {
            Resource[] files = new PathMatchingResourcePatternResolver().getResources("classpath*:catalog/*.yaml");
            // Blueprints first: definitions may name them.
            Arrays.sort(files, Comparator.comparing((Resource r) -> !String.valueOf(r.getFilename()).startsWith("blueprint"))
                    .thenComparing(r -> String.valueOf(r.getFilename())));
            for (Resource f : files) {
                String yaml = new String(f.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                PublishResult r = publish(yaml, "built-in");
                if ("PUBLISHED".equals(r.outcome())) log.info("Catalog: published built-in {} {} v{}", r.kind(), r.name(), r.version());
                else if ("REFUSED".equals(r.outcome())) log.warn("Catalog: built-in {} not published: {}", f.getFilename(), r.problems());
            }
        } catch (Exception e) {
            log.warn("Catalog: couldn't publish the built-in definitions: {}", e.getMessage());
        }
    }

    public DefinitionParser.Context context() {
        return new DefinitionParser.Context(classifications::exists, name -> latestBlueprint(name).isPresent());
    }

    /** Checks a definition without publishing it. */
    public DefinitionParser.Result validate(String yaml) {
        return DefinitionParser.parse(yaml, context());
    }

    public synchronized PublishResult publish(String yaml, String publishedBy) {
        DefinitionParser.Result r = validate(yaml);
        if (!r.ok()) return new PublishResult("REFUSED", r.kind(), r.name(), r.version(), r.problems());
        String sha = r.definition() != null ? r.definition().sourceSha256() : r.blueprint().sourceSha256();
        Optional<Entry> same = entry(r.kind(), r.name(), r.version());
        if (same.isPresent()) {
            if (same.get().sha256().equals(sha)) return new PublishResult("UNCHANGED", r.kind(), r.name(), r.version(), List.of());
            return new PublishResult("REFUSED", r.kind(), r.name(), r.version(), List.of("version: " + r.version()
                    + " is already published with different content; published versions never change, so raise the version"));
        }
        int latest = latestVersion(r.kind(), r.name());
        if (r.version() < latest) {
            return new PublishResult("REFUSED", r.kind(), r.name(), r.version(),
                    List.of("version: must be higher than the latest published version, " + latest));
        }
        try {
            jdbc.sql("""
                    INSERT INTO catalog_definition (kind, name, version, yaml, sha256, published_by)
                    VALUES (:kind, :name, :version, :yaml, :sha, :by)
                    """)
                    .param("kind", r.kind()).param("name", r.name()).param("version", r.version())
                    .param("yaml", yaml).param("sha", sha).param("by", publishedBy)
                    .update();
        } catch (DuplicateKeyException race) {
            return new PublishResult("REFUSED", r.kind(), r.name(), r.version(), List.of("version: published by someone else just now"));
        }
        return new PublishResult("PUBLISHED", r.kind(), r.name(), r.version(), List.of());
    }

    /** No new runs of this version; runs already going carry on. */
    public boolean retire(String kind, String name, int version, boolean retired) {
        return jdbc.sql("UPDATE catalog_definition SET retired = :r WHERE kind = :k AND name = :n AND version = :v")
                .param("r", retired).param("k", kind).param("n", name).param("v", version).update() > 0;
    }

    public List<Entry> list(boolean allVersions) {
        List<Entry> all = jdbc.sql("""
                SELECT kind, name, version, yaml, sha256, published_by,
                       to_char(published_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS at, retired
                FROM catalog_definition ORDER BY kind DESC, name, version DESC
                """).query((rs, n) -> new Entry(rs.getString("kind"), rs.getString("name"), rs.getInt("version"),
                description(rs.getString("yaml")), rs.getString("sha256"), rs.getString("published_by"),
                rs.getString("at"), rs.getBoolean("retired"))).list();
        if (allVersions) return all;
        List<Entry> latest = new ArrayList<>();
        for (Entry e : all) {
            if (latest.isEmpty() || !latest.get(latest.size() - 1).name().equals(e.name())
                    || !latest.get(latest.size() - 1).kind().equals(e.kind())) latest.add(e);
        }
        return latest;
    }

    public Optional<String> yaml(String kind, String name, int version) {
        return jdbc.sql("SELECT yaml FROM catalog_definition WHERE kind = :k AND name = :n AND version = :v")
                .param("k", kind).param("n", name).param("v", version).query(String.class).optional();
    }

    /** The newest version that isn't retired (version 0), or that exact version. */
    public Optional<Definition> definition(String name, int version) {
        Optional<String> yaml = version > 0 ? yaml(DefinitionParser.PROVISIONING, name, version)
                : jdbc.sql("""
                        SELECT yaml FROM catalog_definition WHERE kind = 'Provisioning' AND name = :n AND NOT retired
                        ORDER BY version DESC LIMIT 1
                        """).param("n", name).query(String.class).optional();
        return yaml.map(y -> DefinitionParser.parse(y, DefinitionParser.Context.lenient()).definition());
    }

    public boolean isRetired(String kind, String name, int version) {
        return entry(kind, name, version).map(Entry::retired).orElse(false);
    }

    public Optional<Blueprint> latestBlueprint(String name) {
        return jdbc.sql("""
                SELECT yaml FROM catalog_definition WHERE kind = 'Blueprint' AND name = :n AND NOT retired
                ORDER BY version DESC LIMIT 1
                """).param("n", name).query(String.class).optional()
                .map(y -> DefinitionParser.parse(y, DefinitionParser.Context.lenient()).blueprint());
    }

    /** The newest version of every blueprint that isn't retired. */
    public List<Blueprint> blueprints() {
        return jdbc.sql("""
                SELECT DISTINCT ON (name) yaml FROM catalog_definition
                WHERE kind = 'Blueprint' AND NOT retired ORDER BY name, version DESC
                """).query(String.class).list().stream()
                .map(y -> DefinitionParser.parse(y, DefinitionParser.Context.lenient()).blueprint()).toList();
    }

    private Optional<Entry> entry(String kind, String name, int version) {
        return jdbc.sql("""
                SELECT kind, name, version, yaml, sha256, published_by,
                       to_char(published_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS at, retired
                FROM catalog_definition WHERE kind = :k AND name = :n AND version = :v
                """).param("k", kind).param("n", name).param("v", version)
                .query((rs, n) -> new Entry(rs.getString("kind"), rs.getString("name"), rs.getInt("version"),
                        description(rs.getString("yaml")), rs.getString("sha256"), rs.getString("published_by"),
                        rs.getString("at"), rs.getBoolean("retired"))).optional();
    }

    private int latestVersion(String kind, String name) {
        return jdbc.sql("SELECT COALESCE(MAX(version), 0) FROM catalog_definition WHERE kind = :k AND name = :n")
                .param("k", kind).param("n", name).query(Integer.class).single();
    }

    private static String description(String yaml) {
        DefinitionParser.Result r = DefinitionParser.parse(yaml, DefinitionParser.Context.lenient());
        if (r.definition() != null) return r.definition().description();
        if (r.blueprint() != null) return r.blueprint().description();
        return null;
    }
}
