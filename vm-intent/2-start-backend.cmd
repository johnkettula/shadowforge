@echo off
REM Starts the Spring Boot API and all Temporal workers on http://localhost:8080
REM AI settings (optional): copy ai-settings.example.cmd to ai-settings.cmd and pick a provider.
if exist "%~dp0ai-settings.cmd" call "%~dp0ai-settings.cmd"
cd /d "%~dp0backend"
mvn spring-boot:run
