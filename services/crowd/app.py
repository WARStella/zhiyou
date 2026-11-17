"""智游·灵动人形特化 YOLO 人群计数服务。

HTTP 契约由 Node 云函数严格校验，因此这里延续“错误码固定、字段固定、
不向调用方泄露图片/密钥/堆栈”的策略。

设计要点：

* 所有路径（包括 /health）都先过 Bearer 鉴权。
* 推理用一把非阻塞锁串行化；锁被占用立即 429，不排队。
* detector 只跑 person 类，切片结果按中心点归属去重。
* 500 只返回固定的 INFERENCE_FAILED，不把异常文本或堆栈写进响应。
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import logging
import os
import threading
from typing import Any, Dict, Optional, Tuple

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from detector import (
    DEFAULT_IMGSZ,
    DetectorError,
    InvalidImageError,
    PersonDetector,
    WeightsMissingError,
)

LOGGER = logging.getLogger(__name__)

DEFAULT_MODEL_NAME = "yolo11n-person"
DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_PIXELS = 30_000_000


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError, OverflowError):
        LOGGER.warning("环境变量 %s 不是整数，使用默认值", name)
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except (TypeError, ValueError, OverflowError):
        LOGGER.warning("环境变量 %s 不是数字，使用默认值", name)
        return default


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value is not None and value.strip() else default


# 密钥只从环境变量读取，绝不写死。没有配置时服务仍能启动，但所有请求
# 都会按契约返回 401，而不是阴差阳错地放行。
API_KEY = (os.environ.get("YOLO_API_KEY") or "").strip()
if not API_KEY:
    LOGGER.warning("YOLO_API_KEY 未配置：所有请求都会返回 401")

MAX_BODY_BYTES = _env_int("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)
if MAX_BODY_BYTES <= 0:
    LOGGER.warning("MAX_BODY_BYTES 非正，使用默认值")
    MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES

MAX_PIXELS = _env_int("YOLO_MAX_PIXELS", DEFAULT_MAX_PIXELS)
if MAX_PIXELS <= 0:
    LOGGER.warning("YOLO_MAX_PIXELS 非正，使用默认值")
    MAX_PIXELS = DEFAULT_MAX_PIXELS

DETECTOR = PersonDetector(
    weights=_env_str("YOLO_WEIGHTS", "person.pt"),
    imgsz=_env_int("YOLO_IMGSZ", DEFAULT_IMGSZ),
    conf=_env_float("YOLO_CONF", 0.35),
    iou=_env_float("YOLO_IOU", 0.5),
    max_det=_env_int("YOLO_MAX_DET", 300),
    grid=_env_int("YOLO_TILING_GRID", 2),
    overlap=_env_float("YOLO_TILING_OVERLAP", 0.2),
    device=_env_str("YOLO_DEVICE", "cpu"),
    model_name=_env_str("YOLO_MODEL_NAME", DEFAULT_MODEL_NAME),
    max_pixels=MAX_PIXELS,
    # auto / force / off。CloudBase CPU 上默认 auto：只有大图才切片，
    # 避免每张手机照片都付 4 次推理的延迟与费用。
    tiling_mode=_env_str("YOLO_TILING_MODE", "auto"),
    torch_threads=_env_int("YOLO_TORCH_THREADS", 1),
)

# 启动时预加载，避免第一个 /count 请求承担模型加载的超时风险。加载失败
# 不阻止进程启动：health 会如实显示 ready=false，/count 返回 503。
try:
    DETECTOR.load()
except DetectorError as exc:
    LOGGER.warning("检测器启动加载失败，等待后续请求重试：%s", exc)
except Exception:  # pragma: no cover - 极端环境问题也不能泄露堆栈给调用方
    LOGGER.exception("检测器启动加载出现未预期异常")

# gunicorn 固定 -w 1 --threads 4，这个进程内锁足以串行化推理。用非阻塞
# acquire 是为了按契约立即返回 429，而不是让请求在锁上排队直到超时。
_INFERENCE_LOCK = threading.Lock()

app = Flask(__name__)
# 在读取 body 之前就拦住超大请求；count() 里还会再检查一次实际 raw 长度，
# 以覆盖 chunked/no Content-Length 的情况。
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES


# ---------------------------------------------------------------------------
# 鉴权与错误响应
# ---------------------------------------------------------------------------


def _is_authorized() -> bool:
    """严格校验 Bearer token；未配置密钥时 fail closed。"""

    if not API_KEY:
        return False

    header = request.headers.get("Authorization", "")
    parts = header.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    token = parts[1].strip()
    if not token:
        return False

    # 用常量时间比较避免把密钥长度/前缀差异暴露给探测者。编码成 bytes
    # 也能安全处理非 ASCII 的环境变量值。
    try:
        return hmac.compare_digest(token.encode("utf-8"), API_KEY.encode("utf-8"))
    except (UnicodeError, TypeError):
        return False


def _error_response(code: str, message: str, status: int) -> Tuple[Response, int]:
    return jsonify({"error": {"code": code, "message": message}}), status


def _unauthorized() -> Tuple[Response, int]:
    return _error_response("UNAUTHORIZED", "访问凭据缺失或无效", 401)


def _invalid_body() -> Tuple[Response, int]:
    return _error_response("INVALID_BODY", "请求体格式非法", 400)


def _invalid_image() -> Tuple[Response, int]:
    return _error_response("INVALID_IMAGE", "图片格式非法或无法解码", 400)


def _payload_too_large() -> Tuple[Response, int]:
    return _error_response("PAYLOAD_TOO_LARGE", "请求体超过大小限制", 413)


def _busy() -> Tuple[Response, int]:
    return _error_response("BUSY", "服务正忙，请稍后重试", 429)


def _weights_missing() -> Tuple[Response, int]:
    return _error_response("WEIGHTS_MISSING", "检测权重不可用", 503)


def _inference_failed() -> Tuple[Response, int]:
    return _error_response("INFERENCE_FAILED", "推理失败", 500)


@app.before_request
def _require_bearer_auth():  # type: ignore[no-untyped-def]
    # 所有**业务**路径都必须先鉴权，包括 /health 和 /model。
    # 唯一的例外是 /healthz：见下方路由说明。
    if request.path in PUBLIC_PATHS:
        return None
    if not _is_authorized():
        return _unauthorized()
    return None


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------


# 唯一免鉴权的路径。**只用于平台健康检查**，必须假定它是公网可见的：
# 因此只回一个 {"ok": true}，不带模型名、权重名、版本、就绪状态或任何调试信息。
PUBLIC_PATHS = frozenset({"/healthz"})


@app.route("/healthz", methods=["GET"])
def healthz():  # type: ignore[no-untyped-def]
    """存活探针（**免鉴权**）。

    为什么必须和 `/health` 分开：CloudBase 云托管（以及大多数容器平台）的
    健康检查是**平台自己发**的请求，它拿不到我们的 Bearer 密钥。若把检查
    指向需要鉴权的 `/health`，平台会一直收到 401 并把版本判成不健康 ——
    而我们在本地看到的却是"鉴权生效了，返回 401，符合预期"。

    `/healthz` 只回答"进程还活着"，**不回答"模型能不能用"**。就绪状态在
    需要密钥的 `/health` 里，避免把"权重缺失/正在加载"暴露给任何人。
    """

    return jsonify({"ok": True}), 200


@app.route("/health", methods=["GET"])
def health():  # type: ignore[no-untyped-def]
    ready = bool(DETECTOR.ready)
    return (
        jsonify(
            {
                "ok": True,
                "ready": ready,
                "model": DETECTOR.model_name,
                "weightsLoaded": ready,
            }
        ),
        200,
    )


@app.route("/model", methods=["GET"])
def model_info():  # type: ignore[no-untyped-def]
    return jsonify(DETECTOR.describe()), 200


@app.route("/count", methods=["POST"])
def count():  # type: ignore[no-untyped-def]
    # 先用 Content-Length 快速拒绝，再检查实际 body。两者都以原始请求体
    # 字节数为准，避免 base64 解码后的图片大小绕过限制。
    content_length = request.content_length
    if content_length is not None and content_length > MAX_BODY_BYTES:
        return _payload_too_large()

    try:
        raw_body = request.get_data(cache=True)
    except RequestEntityTooLarge:
        return _payload_too_large()
    if len(raw_body) > MAX_BODY_BYTES:
        return _payload_too_large()

    if not request.is_json:
        return _invalid_body()

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _invalid_body()
    if not isinstance(payload, dict):
        return _invalid_body()

    if "imageBase64" not in payload or not isinstance(payload.get("imageBase64"), str):
        return _invalid_body()
    image_base64 = payload["imageBase64"]
    if not image_base64:
        return _invalid_image()

    try:
        # validate=True 只接受纯 base64；带 data: 前缀、日志错误信息等
        # 非 base64 内容会在这里被拒绝。
        image_bytes = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError):
        return _invalid_image()
    if not image_bytes:
        return _invalid_image()

    # 推理锁只包住模型加载/推理，不排队：拿不到锁立刻 429。
    if not _INFERENCE_LOCK.acquire(blocking=False):
        return _busy()

    try:
        if not DETECTOR.ready:
            try:
                DETECTOR.load()
            except WeightsMissingError:
                return _weights_missing()
            except Exception:
                LOGGER.exception("请求期间加载检测权重失败")
                return _weights_missing()

        try:
            result: Dict[str, Any] = DETECTOR.count(image_bytes)
        except InvalidImageError:
            return _invalid_image()
        except WeightsMissingError:
            return _weights_missing()
        except DetectorError:
            LOGGER.warning("检测失败，已返回固定的 INFERENCE_FAILED")
            return _inference_failed()
        except Exception:
            # 堆栈只进服务端日志，响应体绝不带异常文本、图片内容或路径。
            LOGGER.exception("检测过程中出现未预期异常")
            return _inference_failed()

        return jsonify(result), 200
    finally:
        _INFERENCE_LOCK.release()


# ---------------------------------------------------------------------------
# 统一 JSON 错误响应
# ---------------------------------------------------------------------------


@app.errorhandler(413)
def _handle_413(exc):  # type: ignore[no-untyped-def]
    return _payload_too_large()


@app.errorhandler(404)
def _handle_404(exc):  # type: ignore[no-untyped-def]
    # 未匹配路径也可能绕过 before_request 的路由前置流程（取决于 Flask
    # 版本），所以这里再校验一次，保证“所有路径都要鉴权”成立。
    if not _is_authorized():
        return _unauthorized()
    return _error_response("NOT_FOUND", "接口不存在", 404)


@app.errorhandler(405)
def _handle_405(exc):  # type: ignore[no-untyped-def]
    if not _is_authorized():
        return _unauthorized()
    return _error_response("METHOD_NOT_ALLOWED", "请求方法不允许", 405)


@app.errorhandler(400)
def _handle_400(exc):  # type: ignore[no-untyped-def]
    return _invalid_body()


@app.errorhandler(Exception)
def _handle_unexpected(exc):  # type: ignore[no-untyped-def]
    # 兜底：任何未被上面捕获的异常，都不能把 Flask 的 HTML 调试页或堆栈
    # 返回给 Node。HTTP 异常保留其状态码，但响应体仍是统一 JSON。
    if isinstance(exc, HTTPException):
        status = exc.code or 500
        if status == 413:
            return _payload_too_large()
        if status == 404:
            if not _is_authorized():
                return _unauthorized()
            return _error_response("NOT_FOUND", "接口不存在", 404)
        if status == 405:
            if not _is_authorized():
                return _unauthorized()
            return _error_response("METHOD_NOT_ALLOWED", "请求方法不允许", 405)
        if status == 401:
            return _unauthorized()
        if status == 400:
            return _invalid_body()
        if status >= 500:
            return _inference_failed()
        return _error_response("REQUEST_FAILED", "请求处理失败", status)

    LOGGER.exception("未处理异常")
    return _inference_failed()
