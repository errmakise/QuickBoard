from __future__ import annotations

import base64
import os
import re
from io import BytesIO
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


class RecognizeRequest(BaseModel):
    imageDataUrl: str


app = FastAPI()
_model = None


def _get_model() -> Any:
    global _model
    if _model is not None:
        return _model

    try:
        from pix2text import Pix2Text
    except Exception as e:
        raise RuntimeError("MODEL_IMPORT_FAILED") from e

    try:
        _model = Pix2Text(
            analyzer_config={"model_name": "mfd-1.5"},
            formula_config={"model_name": "mfr-1.5"},
            device="cpu"
        )
    except Exception as e:
        raise RuntimeError("MODEL_INIT_FAILED") from e

    return _model


_DATA_URL_RE = re.compile(r"^data:image/[^;]+;base64,(?P<b64>.+)$", re.IGNORECASE | re.DOTALL)


def _decode_data_url(image_data_url: str) -> Image.Image:
    m = _DATA_URL_RE.match(image_data_url or "")
    if not m:
        raise ValueError("BAD_IMAGE_DATA_URL")
    raw = base64.b64decode(m.group("b64"))
    img = Image.open(BytesIO(raw))
    return img.convert("RGB")


def _preprocess(img: Image.Image) -> Image.Image:
    """针对手写公式的预处理"""
    base = img.convert("L")
    
    # 自适应对比度增强
    base = ImageOps.autocontrast(base, cutoff=1)
    base = ImageEnhance.Contrast(base).enhance(1.3)
    
    # 轻微降噪
    base = base.filter(ImageFilter.MedianFilter(size=2))
    
    # 尺寸标准化
    w, h = base.size
    if w <= 0 or h <= 0:
        return img.convert("RGB")
    
    long_side = max(w, h)
    if long_side < 640:
        scale = 640.0 / float(long_side)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        base = base.resize((max(1, nw), max(1, nh)), resample=Image.Resampling.LANCZOS)
    elif long_side > 1200:
        scale = 1200.0 / float(long_side)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        base = base.resize((max(1, nw), max(1, nh)), resample=Image.Resampling.LANCZOS)
    
    # 添加白色边框
    pad = int(round(max(base.size) * 0.08))
    pad = max(12, min(64, pad))
    base = ImageOps.expand(base, border=pad, fill=255)
    
    return base.convert("RGB")


def _to_png_data_url(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/recognize")
def recognize(req: RecognizeRequest):
    try:
        img = _decode_data_url(req.imageDataUrl)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_IMAGE")

    try:
        model = _get_model()
    except RuntimeError as e:
        if str(e) == "MODEL_IMPORT_FAILED":
            raise HTTPException(status_code=501, detail="MODEL_NOT_INSTALLED")
        raise HTTPException(status_code=500, detail="MODEL_INIT_FAILED")
    except Exception:
        raise HTTPException(status_code=500, detail="MODEL_INIT_FAILED")

    try:
        debug = str(os.getenv("OCR_DEBUG", "")).strip().lower() in {"1", "true", "yes"}
        processed = _preprocess(img) if debug else None
        
        # 使用 Pix2Text 进行识别
        result = model.recognize(processed if debug else img)
        
        # 提取 LaTeX 结果
        latex = ""
        if isinstance(result, dict):
            if "text_formula" in result:
                latex = result["text_formula"]
            elif "formula" in result:
                latex = result["formula"]
            elif "text" in result:
                latex = result["text"]
        elif isinstance(result, str):
            latex = result
        
        # 清理和标准化 LaTeX
        latex = latex.strip()
        if latex and not latex.startswith("$") and not latex.startswith("\\["):
            latex = f"${latex}$"
            
    except Exception:
        raise HTTPException(status_code=500, detail="RECOGNIZE_FAILED")

    resp = {"latex": latex}
    if processed is not None:
        resp["debug"] = {"processedImageDataUrl": _to_png_data_url(processed)}
    return resp