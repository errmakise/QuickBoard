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
        # 首先尝试 Pix2Text（更擅长手写）
        from pix2text import Pix2Text
        try:
            _model = Pix2Text(
                analyzer_config={"model_name": "mfd-1.5"},
                formula_config={"model_name": "mfr-1.5"},
                device="cpu"
            )
            print("✅ 使用 Pix2Text (MFR-1.5) 模型")
            return _model
        except Exception:
            print("⚠️ Pix2Text 初始化失败，回退到 pix2tex")
    except ImportError:
        print("⚠️ Pix2Text 未安装，使用 pix2tex")

    # 回退到 pix2tex
    try:
        from pix2tex.cli import LatexOCR
        _model = LatexOCR()
        print("✅ 使用 pix2tex 模型")
        return _model
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
    base = base.filter(ImageFilter.MedianFilter(size=2))
    
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
    model = _get_model()
    
    # 如果是 Pix2Text
    if hasattr(model, 'recognize'):
        try:
            # 首先尝试原始图像
            result = model.recognize(img)
            if isinstance(result, dict):
                latex = result.get("text_formula", "") or result.get("formula", "") or result.get("text", "")
            else:
                latex = str(result)
            
            if latex.strip():
                return latex.strip()
            
            # 尝试预处理后的图像
            processed = _preprocess_for_handwriting(img)
            result = model.recognize(processed)
            if isinstance(result, dict):
                latex = result.get("text_formula", "") or result.get("formula", "") or result.get("text", "")
            else:
                latex = str(result)
            
            return latex.strip()
            
        except Exception:
            # Pix2Text 失败，回退到 pix2tex 的处理方式
            pass
    
    # 如果是 pix2tex 或者 Pix2Text 失败
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
        processed = _preprocess_for_handwriting(img) if debug else None
        
        # 使用改进的识别策略
        latex = _recognize_with_fallback(img)
        
        # 清理和标准化 LaTeX
        latex = latex.strip()
        if latex and not latex.startswith("$") and not latex.startswith("\\[") and not latex.startswith("\\("):
            latex = f"${latex}$"
            
    except Exception:
        raise HTTPException(status_code=500, detail="RECOGNIZE_FAILED")

    resp = {"latex": latex}
    if processed is not None:
        resp["debug"] = {"processedImageDataUrl": _to_png_data_url(processed)}
    return resp