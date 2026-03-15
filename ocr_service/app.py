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
_pix2text_model = None
_pix2tex_model = None


def _get_pix2text_model() -> Any | None:
    global _pix2text_model
    if _pix2text_model is not None:
        return _pix2text_model
    try:
        from pix2text import Pix2Text
        _pix2text_model = Pix2Text(
            analyzer_config={"model_name": "mfd-1.5"},
            formula_config={"model_name": "mfr-1.5"},
            device="cpu"
        )
        print("✅ 使用 Pix2Text (MFR-1.5) 模型")
        return _pix2text_model
    except Exception:
        return None


def _get_pix2tex_model() -> Any:
    global _pix2tex_model
    if _pix2tex_model is not None:
        return _pix2tex_model
    try:
        from pix2tex.cli import LatexOCR
        _pix2tex_model = LatexOCR()
        print("✅ 使用 pix2tex 模型")
        return _pix2tex_model
    except Exception as e:
        raise RuntimeError("MODEL_IMPORT_FAILED") from e


def _decode_data_url(image_data_url: str) -> Image.Image:
    m = re.match(r"^data:image/[^;]+;base64,(?P<b64>.+)$", image_data_url or "", re.IGNORECASE | re.DOTALL)
    if not m:
        raise ValueError("BAD_IMAGE_DATA_URL")
    raw = base64.b64decode(m.group("b64"))
    img = Image.open(BytesIO(raw))
    return img.convert("RGB")


def _preprocess_for_handwriting(img: Image.Image) -> Image.Image:
    """专门针对手写公式的预处理"""
    base = img.convert("L")
    
    # 自适应对比度增强（轻微）
    base = ImageOps.autocontrast(base, cutoff=1)
    base = ImageEnhance.Contrast(base).enhance(1.2)
    
    # 轻微降噪
    try:
        base = base.filter(ImageFilter.MedianFilter(size=3))
    except Exception:
        pass
    
    # 尺寸标准化
    w, h = base.size
    if w <= 0 or h <= 0:
        return img.convert("RGB")
    
    long_side = max(w, h)
    if long_side < 480:
        scale = 480.0 / float(long_side)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        base = base.resize((max(1, nw), max(1, nh)), resample=Image.Resampling.LANCZOS)
    elif long_side > 1000:
        scale = 1000.0 / float(long_side)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        base = base.resize((max(1, nw), max(1, nh)), resample=Image.Resampling.LANCZOS)
    
    # 添加白色边框
    pad = int(round(max(base.size) * 0.06))
    pad = max(8, min(32, pad))
    base = ImageOps.expand(base, border=pad, fill=255)
    
    return base.convert("RGB")


def _to_png_data_url(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _recognize_with_fallback(img: Image.Image) -> str:
    """使用多种策略进行识别"""
    def _as_text(v: Any) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        try:
            return str(v)
        except Exception:
            return ""
    
    # 如果是 Pix2Text
    model = _get_pix2text_model()
    if model is not None and hasattr(model, 'recognize'):
        try:
            # 首先尝试原始图像
            result = model.recognize(img)
            if isinstance(result, dict):
                latex = _as_text(
                    result.get("text_formula", "") or result.get("formula", "") or result.get("text", "")
                )
            else:
                latex = _as_text(result)
            
            if latex.strip():
                return latex.strip()
            
            # 尝试预处理后的图像
            processed = _preprocess_for_handwriting(img)
            result = model.recognize(processed)
            if isinstance(result, dict):
                latex = _as_text(
                    result.get("text_formula", "") or result.get("formula", "") or result.get("text", "")
                )
            else:
                latex = _as_text(result)
            
            return latex.strip()
            
        except Exception:
            model = None
    
    # 如果是 pix2tex 或者 Pix2Text 失败
    try:
        model = _get_pix2tex_model()
    except Exception:
        return ""

    try:
        # 尝试预处理后的图像
        processed = _preprocess_for_handwriting(img)
        latex = model(processed)
        return latex.strip() if isinstance(latex, str) else ""
    except Exception:
        # 最后尝试原始图像
        try:
            latex = model(img)
            return latex.strip() if isinstance(latex, str) else ""
        except Exception:
            return ""


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/recognize")
def recognize(req: RecognizeRequest):
    try:
        img = _decode_data_url(req.imageDataUrl)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_IMAGE")

    pix2text_ready = _get_pix2text_model() is not None
    if not pix2text_ready:
        try:
            _get_pix2tex_model()
        except RuntimeError as e:
            if str(e) == "MODEL_IMPORT_FAILED":
                raise HTTPException(status_code=501, detail="MODEL_NOT_INSTALLED")
            raise HTTPException(status_code=500, detail="MODEL_INIT_FAILED")
        except Exception:
            raise HTTPException(status_code=500, detail="MODEL_INIT_FAILED")

    debug = str(os.getenv("OCR_DEBUG", "")).strip().lower() in {"1", "true", "yes"}
    processed = None
    if debug:
        try:
            processed = _preprocess_for_handwriting(img)
        except Exception:
            processed = None

    try:
        latex = _recognize_with_fallback(img)
    except Exception as e:
        resp = {"latex": "", "error": "RECOGNIZE_FAILED", "detail": f"{type(e).__name__}:{e}"}
        if processed is not None:
            resp["debug"] = {"processedImageDataUrl": _to_png_data_url(processed)}
        return resp

    if not isinstance(latex, str):
        latex = ""

    latex = latex.strip()
    if latex and not latex.startswith("$") and not latex.startswith("\\[") and not latex.startswith("\\("):
        latex = f"${latex}$"

    resp = {"latex": latex}
    if processed is not None:
        resp["debug"] = {"processedImageDataUrl": _to_png_data_url(processed)}
    return resp
