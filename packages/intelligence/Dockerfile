FROM python:3.11-slim

RUN apt-get update && apt-get install -y curl gcc g++ python3-dev && rm -rf /var/lib/apt/lists/*

RUN pip install poetry
RUN poetry config virtualenvs.create false

WORKDIR /app

COPY pyproject.toml poetry.lock* ./
RUN poetry install --no-interaction --no-ansi --no-root || pip install fastapi uvicorn redis ccxt xgboost hmmlearn arch filterpy scikit-learn pandas numpy tomlkit httpx pydantic pydantic-settings

COPY . .

RUN mkdir -p /app/models

EXPOSE 8001

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001", "--reload"]
