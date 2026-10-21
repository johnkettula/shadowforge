# Builds the React app and serves it with nginx, which also forwards /api to the backend.
FROM node:22-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# The image turns templates/*.template into conf.d/*.conf, filling in environment variables.
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=http://api:8080
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
