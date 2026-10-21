package com.example.vmintent.db;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.io.File;
import java.io.IOException;

/**
 * Local development database.
 *
 * With vmintent.db.embedded=true (the default) the app starts a real Postgres
 * itself, from binaries Maven downloads: no installer and no admin rights.
 * Data is kept in vmintent.db.embedded-data-dir, so the inventory and audit
 * trail survive restarts.
 *
 * Set vmintent.db.embedded=false to use a normal Postgres server instead; the
 * standard spring.datasource.url / username / password settings then apply.
 */
@Configuration
@ConditionalOnProperty(name = "vmintent.db.embedded", havingValue = "true", matchIfMissing = true)
public class DatabaseConfig {

    private static final Logger log = LoggerFactory.getLogger(DatabaseConfig.class);

    @Bean(destroyMethod = "close")
    public EmbeddedPostgres embeddedPostgres(
            @Value("${vmintent.db.embedded-port:54329}") int port,
            @Value("${vmintent.db.embedded-data-dir}") String dataDir) throws IOException {
        File dir = new File(dataDir);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Could not create database folder " + dir.getAbsolutePath());
        }
        log.info("Starting embedded Postgres on port {} with data in {}", port, dir.getAbsolutePath());
        return EmbeddedPostgres.builder()
                .setPort(port)
                .setDataDirectory(dir)
                .setCleanDataDirectory(false)   // keep data between runs
                .start();
    }

    /** A connection pool in front of the embedded database, sized for many workflows at once. */
    @Bean(destroyMethod = "close")
    public DataSource dataSource(EmbeddedPostgres postgres,
                                 @Value("${spring.datasource.hikari.maximum-pool-size:30}") int poolSize) {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl(postgres.getJdbcUrl("postgres", "postgres"));
        cfg.setMaximumPoolSize(poolSize);
        cfg.setPoolName("vmintent-embedded");
        return new HikariDataSource(cfg);
    }
}
