# FriKode Production Container
# Compatible with Koyeb, Render, Fly.io, Railway, and Hugging Face Spaces

FROM python:3.12-slim

# Set environment defaults
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=4000 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/app/sample_project

WORKDIR /app

# Install system dependencies (curl for health check, build-essential if wheels need compile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY . .

# Ensure sample workspace exists
RUN mkdir -p /app/sample_project

# Expose default port
EXPOSE 4000

# Health check to ensure aiohttp is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:${PORT}/api/ping || exit 1

# Start the FriKode collaboration server
CMD ["python", "run.py"]

