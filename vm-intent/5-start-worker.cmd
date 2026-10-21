@echo off
REM Starts ONE extra worker process (no web server). Start 2-start-backend.cmd first:
REM it runs the database this worker shares. Double-click again for more workers.
REM Close this window to stop the worker; its work is picked up by the others.
cd /d "%~dp0backend"
set SPRING_PROFILES_ACTIVE=worker
set VMINTENT_DB_EMBEDDED=false
set VMINTENT_DB_URL=jdbc:postgresql://localhost:54329/postgres
set VMINTENT_DB_USER=postgres
set VMINTENT_DB_PASSWORD=
title vm-intent worker
REM -Dmaven.main.skip: reuse the code 2-start-backend.cmd already compiled.
mvn -q spring-boot:run -Dmaven.main.skip=true -Dspring-boot.run.profiles=worker
