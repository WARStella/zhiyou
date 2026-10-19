"""CPU YOLO person detection. No uploads, predictions, or image files are persisted."""
import base64
import binascii
import hmac
import io
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

MAX_BYTES = 1024 * 1024
MAX_DETECTIONS = 1000
Image.MAX_IMAGE_PIXELS = 16_000_000
_model = None
_lock = threading.Lock()
_key = os.environ.get('YOLO_API_KEY', '')
_model_path = os.environ.get('YOLO_MODEL_PATH', 'yolo11n.pt')
_confidence = float(os.environ.get('YOLO_CONFIDENCE', '0.35'))


@asynccontextmanager
async def lifespan(app):
    global _model
    if not _key or not 0 < _confidence < 1:
        raise RuntimeError('Configure YOLO_API_KEY and a confidence threshold between 0 and 1')
    from ultralytics import YOLO
    _model = YOLO(_model_path)
    if _model.names.get(0) != 'person':
        raise RuntimeError('Use a COCO detection model with class 0 = person')
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(RequestValidationError)
async def invalid_body(request, error):
    from starlette.responses import JSONResponse
    return JSONResponse({'detail': 'Invalid image request'}, status_code=422)


class CountBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    imageBase64: str = Field(min_length=4, max_length=1398104)


@app.middleware('http')
async def limit_and_auth(request: Request, call_next):
    from starlette.responses import JSONResponse
    if not _key or not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + _key):
        return JSONResponse({'detail': 'Unauthorized'}, status_code=401)
    # Read bounded chunks before JSON parsing, including clients using chunked transfer.
    size, chunks = 0, []
    async for chunk in request.stream():
        size += len(chunk)
        if size > 1_400_000:
            return JSONResponse({'detail': 'Image too large'}, status_code=413)
        chunks.append(chunk)
    request._body = b''.join(chunks)
    return await call_next(request)


def detect(encoded: str):
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_BYTES:
            raise ValueError('Image too large')
        image = Image.open(io.BytesIO(raw))
        if image.format not in ('JPEG', 'PNG') or image.width * image.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError('Unsupported image')
        image = ImageOps.exif_transpose(image).convert('RGB')
    except (ValueError, binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(400, 'Use a JPG/PNG image up to 1MB and 16 megapixels') from None
    # One shared CPU model: serialize inference; return busy rather than queueing unbounded uploads.
    if not _lock.acquire(blocking=False):
        image.close()
        raise HTTPException(429, 'Detector busy, retry later')
    try:
        if _model is None:
            raise HTTPException(503, 'Detector not ready')
        result = _model.predict(source=image, classes=[0], conf=_confidence, iou=0.45,
                                max_det=MAX_DETECTIONS, imgsz=960, device='cpu', save=False,
                                save_txt=False, verbose=False)[0]
        boxes = []
        for coords, confidence, cls in zip(result.boxes.xyxyn.tolist(), result.boxes.conf.tolist(), result.boxes.cls.tolist()):
            if int(cls) != 0 or confidence < _confidence:
                continue
            x1, y1, x2, y2 = [max(0., min(1., float(v))) for v in coords]
            if x2 > x1 and y2 > y1:
                boxes.append({'x': x1, 'y': y1, 'width': x2-x1, 'height': y2-y1, 'confidence': float(confidence)})
        return {'count': len(boxes), 'boxes': boxes, 'model': Path(_model_path).stem,
                'estimated': True, 'confidenceThreshold': _confidence, 'truncated': len(boxes) >= MAX_DETECTIONS}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Detector unavailable') from None
    finally:
        _lock.release()
        image.close()


@app.get('/health')
def health():
    return {'ready': _model is not None, 'model': Path(_model_path).stem}


@app.post('/count')
def count(body: CountBody):
    return detect(body.imageBase64)
