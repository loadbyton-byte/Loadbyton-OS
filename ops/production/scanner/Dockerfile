FROM debian:bookworm-slim
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; export scanner_ca_option='-o Acquire::https::CaInfo=/run/secrets/build_ca'; fi; \
    apt-get ${scanner_ca_option:-} update && apt-get ${scanner_ca_option:-} install -y --no-install-recommends clamav-daemon clamav-freshclam clamdscan ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /var/lib/clamav /run/clamav && chown -R clamav:clamav /var/lib/clamav /run/clamav
COPY clamd.conf /etc/clamav/clamd.conf
COPY freshclam.conf /etc/clamav/freshclam.conf
COPY start.sh /usr/local/bin/start-scanner
RUN chmod 0755 /usr/local/bin/start-scanner && chmod 0644 /etc/clamav/clamd.conf /etc/clamav/freshclam.conf
USER clamav
EXPOSE 3310
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m CMD clamdscan --ping=1 || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-scanner"]
