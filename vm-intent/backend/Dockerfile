# Builds the backend into one image. The same image runs as the API or as a worker:
#   SPRING_PROFILES_ACTIVE=api     REST API only (port 8080)
#   SPRING_PROFILES_ACTIVE=worker  workflows and activities, no web server
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B -DskipTests package && cp target/vm-intent-*.jar /app.jar

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 vmintent
USER vmintent
COPY --from=build /app.jar /app/app.jar
# Use most of the container's memory for the heap; leave room for threads and off-heap buffers.
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+UseG1GC"
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/app.jar"]
