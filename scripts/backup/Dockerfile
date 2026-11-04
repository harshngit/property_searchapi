# Image for the backup and restore-test Cloud Run Jobs (sec. 25.5.1).
# pg_dump must be the same major version as the database server or newer:
# set PG_MAJOR to the Cloud SQL / server version when building.
#   docker build -f scripts/backup/Dockerfile --build-arg PG_MAJOR=16 -t <region>-docker.pkg.dev/<project>/<repo>/ps-backup .
FROM node:20-slim
ARG PG_MAJOR=16
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts/backup ./scripts/backup
CMD ["node", "scripts/backup/backup.js"]
