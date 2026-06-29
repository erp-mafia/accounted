FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

ARG SUPERCRONIC_VERSION=v0.2.33
ARG TARGETARCH

# SHA-256 of the supercronic v0.2.33 release binaries.
# Computed from https://github.com/aptible/supercronic/releases/download/v0.2.33/
# (the upstream project publishes only SHA-1 checksums, so these are recorded here).
# Dependabot watches FROM lines, not these ARGs — bump manually when SUPERCRONIC_VERSION changes.
ARG SUPERCRONIC_SHA256_AMD64=feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671
ARG SUPERCRONIC_SHA256_ARM64=f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3

# curl stays in the image — the crontab uses it at runtime to call the app.
RUN apk add --no-cache curl \
    && case ${TARGETARCH} in \
         amd64) ARCH=linux-amd64; SHA=${SUPERCRONIC_SHA256_AMD64} ;; \
         arm64) ARCH=linux-arm64; SHA=${SUPERCRONIC_SHA256_ARM64} ;; \
         *)     ARCH=linux-amd64; SHA=${SUPERCRONIC_SHA256_AMD64} ;; \
       esac \
    && curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-${ARCH}" \
       -o /usr/local/bin/supercronic \
    && echo "${SHA}  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic

# Run as the alpine-built-in unprivileged user. Defense-in-depth alongside
# cap_drop:[ALL] and read_only:true in docker-compose.yml. The crontab is
# bind-mounted read-only with default 644 perms (readable by all), and the
# supercronic binary is world-executable (chmod 0755 above).
USER nobody:nobody

ENTRYPOINT ["supercronic"]
CMD ["/etc/supercronic/crontab"]
