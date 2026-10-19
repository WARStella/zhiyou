FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 YOLO_MODEL_PATH=/models/yolo11n.pt YOLO_CONFIG_DIR=/tmp/ultralytics YOLO_AUTOINSTALL=false
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_DEFAULT_TIMEOUT=60 PIP_RETRIES=3 PIP_RESUME_RETRIES=3
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.1
ENV PIP_PROGRESS_BAR=raw
# Use the domestic NJU mirror for the two large CPU wheels, pinned to the official SHA-256 values.
# Other dependencies use PyPI. Raw progress keeps slow downloads visible in cloud build logs.
RUN set -eu; \
    for attempt in 1 2 3; do \
        if python -m pip install --no-cache-dir --only-binary=:all: \
            'https://mirror.nju.edu.cn/pytorch/whl/cpu/torch-2.14.1%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl#sha256=5a6363570c753812540a05eb82380e329469cbe668643e88111414c12627711f' \
            'https://mirror.nju.edu.cn/pytorch/whl/cpu/torchvision-0.29.1%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl#sha256=ef220d4b21878c58947851beb7337382897159105f012f0c9c07bf7e84174d7e' \
            --index-url https://pypi.org/simple; then break; fi; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        echo "CPU package download failed; retrying with hash verification ($attempt/3)"; \
    done
RUN python -m pip install --no-cache-dir -r requirements.txt torch==2.14.1+cpu torchvision==0.29.1+cpu && python -m pip check
RUN mkdir -p /models && python -c "from ultralytics import YOLO; YOLO('/models/yolo11n.pt')"
COPY app.py .
RUN useradd --create-home detector && chown -R detector:detector /app /models
USER detector
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
