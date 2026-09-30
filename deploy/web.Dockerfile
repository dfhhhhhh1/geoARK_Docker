FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# .env is dockerignored, so build-time config comes in as an argument.
# Vite inlines VITE_-prefixed environment variables into the bundle.
ARG VITE_CARTO_KEY=
ENV VITE_CARTO_KEY=$VITE_CARTO_KEY
RUN npm run build

FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
