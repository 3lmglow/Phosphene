# syntax=docker/dockerfile:1.7

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z

FROM --platform=$BUILDPLATFORM golang:1.24.8-alpine3.22 AS builder

ARG TARGETOS
ARG TARGETARCH
ARG MINIO_RELEASE

ENV CGO_ENABLED=0

RUN --mount=type=cache,target=/go/pkg/mod \
    GOBIN=/out GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go install -trimpath \
    -ldflags="-s -w -X github.com/minio/minio/cmd.Version=${MINIO_RELEASE} -X github.com/minio/minio/cmd.ReleaseTag=${MINIO_RELEASE}" \
    github.com/minio/minio@${MINIO_RELEASE} \
    && license_file="$(find /go/pkg/mod/github.com/minio -maxdepth 2 -name LICENSE -print -quit)" \
    && test -n "$license_file" \
    && cp "$license_file" /out/MINIO-LICENSE

FROM alpine:3.22

ARG MINIO_RELEASE

LABEL org.opencontainers.image.title="Phosphene MinIO" \
      org.opencontainers.image.description="MinIO community server built from the security-fixed official source tag" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

RUN apk add --no-cache ca-certificates curl \
    && addgroup -S -g 10001 minio \
    && adduser -S -D -H -u 10001 -G minio minio \
    && mkdir -p /data \
    && chown -R minio:minio /data

COPY --from=builder --chown=root:root /out/minio /usr/local/bin/minio
COPY --from=builder --chown=root:root /out/MINIO-LICENSE /usr/share/licenses/minio/LICENSE

ENV HOME=/tmp

USER minio
EXPOSE 9000 9001
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
