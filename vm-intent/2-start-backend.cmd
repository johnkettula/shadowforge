@echo off
REM Starts the Spring Boot API and all Temporal workers on http://localhost:8080
cd /d "%~dp0backend"
mvn spring-boot:run
