# Stage 1: Builder
FROM ghcr.io/astral-sh/uv:debian-slim AS builder
WORKDIR /build
ENV UV_PYTHON_INSTALL_DIR="/python"
RUN uv python install 3.14t
COPY pyproject.toml* ./
RUN uv venv /app/.venv --python /python/*/bin/python3.14t

# Stage 2: Runtime (~135 MB Debian Slim)
FROM debian:bookworm-slim AS runtime
RUN groupadd -r appgroup && useradd -r -g appgroup -d /app -s /sbin/nologin appuser
WORKDIR /app
COPY --from=builder /python /python
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY src ./src
USER appuser
ENV PYTHON_GIL=0
ENV PATH="/app/.venv/bin:${PATH}"
CMD ["python", "src/main.py"]

