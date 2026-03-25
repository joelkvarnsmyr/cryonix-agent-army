FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (gcc/g++ needed for pyswisseph C/C++ extension)
RUN apt-get update && apt-get install -y \
    curl \
    gcc \
    g++ \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN curl -sSL https://install.python-poetry.org | python3 -
ENV PATH="/root/.local/bin:$PATH"

# Configure Poetry to not use virtualenvs inside container
RUN poetry config virtualenvs.create false

# Copy dependency definition
COPY pyproject.toml poetry.lock* ./

# Install dependencies
RUN poetry install --no-interaction --no-ansi --no-root

# Copy application code
COPY src ./src

# Expose port
EXPOSE 8000

# Run commands
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
