FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DEFAULT_TIMEOUT=120

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL}

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    curl \
    libgl1 \
    libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY ocr_service/requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
  && pip install -r requirements.txt

COPY ocr_service ./
EXPOSE 5007
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5007"]
