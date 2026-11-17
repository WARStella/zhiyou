# 腾讯云托管 / CPU 推理镜像。
# 不在镜像构建阶段下载任何模型权重：生产环境通过 YOLO_WEIGHTS 指向镜像内
# 文件，或把 person.pt 只读挂载到 /app/person.pt。权重缺失时服务会如实返回
# 503 WEIGHTS_MISSING，而不是在构建期偷偷下载。
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/appuser \
    YOLO_CONFIG_DIR=/home/appuser/.config/Ultralytics \
    MPLCONFIGDIR=/home/appuser/.cache/matplotlib

# opencv / torch 在 slim 镜像里常见的动态库依赖。--no-install-recommends
# 避免把桌面环境带进生产镜像；构建后清空 apt 缓存。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行。Ultralytics/matplotlib 会写用户级配置和缓存，因此保留
# 可写的 HOME，而不是简单地 USER nobody。
RUN groupadd --system appuser \
    && useradd --system --gid appuser --create-home --home-dir /home/appuser appuser

WORKDIR /app

COPY requirements.txt ./requirements.txt

# 先装 CPU wheel（固定版本），再装其余依赖。不要在 requirements 阶段让
# PyPI 解析出 CUDA 版本，否则镜像会膨胀且无法在 CPU 托管上使用。
RUN python -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.4.1 torchvision==0.19.1 \
    && python -m pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appuser app.py detector.py person.py ./

USER appuser

EXPOSE 8000

# -w 1 配合 app.py 内的推理锁：单 worker、四线程，锁保证推理串行；并发
# 推理请求立即得到 429，而不是把 CPU 压垮或在队列里超时。
#
# 端口用 shell 形式读 `PORT`：CloudBase 云托管会注入 PORT，控制台里也配了
# 8000。两种情况都要能用，所以写成 `${PORT:-8000}`；`exec` 保证 gunicorn
# 顶替 shell 成为 1 号进程，容器的 SIGTERM 能正常传到它（否则停止实例要等
# 满超时被强杀）。
CMD ["sh", "-c", "exec gunicorn -w 1 -k gthread --threads 4 -t 120 -b 0.0.0.0:${PORT:-8000} app:app"]
