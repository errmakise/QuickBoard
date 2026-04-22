from __future__ import annotations

import base64
import os
import re
from io import BytesIO
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps, ImageStat


class RecognizeRequest(BaseModel):
    imageDataUrl: str
    debug: bool | None = None


app = FastAPI()
_pix2text_model = None
_pix2tex_model = None


@app.on_event("startup")
def warmup_models() -> None:
    flag = str(os.getenv("OCR_WARMUP", "1")).strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return
    try:
        model = _get_pix2text_model()
        if model is not None:
            return
    except Exception:
        pass
    try:
        _get_pix2tex_model()
    except Exception:
        pass


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


def _estimate_background_luma(gray: Image.Image) -> int:
    w, h = gray.size
    if w <= 0 or h <= 0:
        return 255
    pts = [(0, 0), (max(0, w - 1), 0), (0, max(0, h - 1)), (max(0, w - 1), max(0, h - 1))]
    vals = []
    for x, y in pts:
        try:
            vals.append(int(gray.getpixel((x, y))))
        except Exception:
            pass
    if not vals:
        return 255
    return int(round(sum(vals) / float(len(vals))))


def _auto_crop_to_content(img: Image.Image) -> Image.Image:
    w, h = img.size
    if w <= 0 or h <= 0:
        return img
    gray = img.convert("L")
    bg = _estimate_background_luma(gray)
    if bg < 128:
        try:
            gray = ImageOps.invert(gray)
        except Exception:
            pass
        bg = 255
    try:
        diff = ImageChops.difference(gray, Image.new("L", gray.size, color=bg))
    except Exception:
        diff = ImageChops.difference(gray, Image.new("L", gray.size, color=255))
    diff = ImageOps.autocontrast(diff, cutoff=0)
    t = 12 if bg >= 128 else 18
    mask = diff.point(lambda p: 255 if p > t else 0)
    bbox1 = mask.getbbox()

    bbox2 = None
    try:
        g = ImageOps.autocontrast(gray, cutoff=1)
        g = ImageEnhance.Contrast(g).enhance(1.8)
        mask2 = g.point(lambda p: 255 if p < 245 else 0)
        bbox2 = mask2.getbbox()
    except Exception:
        bbox2 = None

    bbox = None
    if bbox1 and bbox2:
        l1, t1, r1, b1 = bbox1
        l2, t2, r2, b2 = bbox2
        bbox = (min(l1, l2), min(t1, t2), max(r1, r2), max(b1, b2))
    else:
        bbox = bbox1 or bbox2
    if not bbox:
        return img
    left, top, right, bottom = bbox
    bw, bh = max(1, right - left), max(1, bottom - top)
    margin = int(round(max(bw, bh) * 0.14))
    margin = max(10, min(64, margin))
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(w, right + margin)
    bottom = min(h, bottom + margin)
    if right <= left + 1 or bottom <= top + 1:
        return img
    try:
        return img.crop((left, top, right, bottom))
    except Exception:
        return img


def _sanitize_latex(latex: str) -> str:
    s = latex if isinstance(latex, str) else ""
    s = s.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not s:
        return ""

    def skip_ws(idx: int) -> int:
        n = len(s)
        while idx < n and s[idx].isspace():
            idx += 1
        return idx

    def parse_braced_group(idx: int) -> int | None:
        n = len(s)
        if idx >= n or s[idx] != "{":
            return None
        depth = 0
        i = idx
        while i < n:
            ch = s[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
            elif ch == "\\":
                i += 1
            i += 1
        return None

    def parse_bracket_group(idx: int) -> int | None:
        n = len(s)
        if idx >= n or s[idx] != "[":
            return None
        i = idx + 1
        while i < n:
            ch = s[i]
            if ch == "]":
                return i + 1
            if ch == "\\":
                i += 1
            i += 1
        return None

    def parse_control_sequence(idx: int) -> int:
        n = len(s)
        if idx >= n:
            return idx
        if s[idx] != "\\":
            return idx
        i = idx + 1
        if i >= n:
            return i
        if s[i].isalpha() or s[i] == "@":
            i += 1
            while i < n and (s[i].isalpha() or s[i] == "@"):
                i += 1
            return i
        return i + 1

    def strip_macros(text: str) -> str:
        nonlocal s
        s = text
        out: list[str] = []
        i = 0
        n = len(s)
        while i < n:
            if s[i] != "\\":
                out.append(s[i])
                i += 1
                continue

            for cmd in ("\\newcommand", "\\renewcommand"):
                if s.startswith(cmd, i):
                    j = i + len(cmd)
                    j = skip_ws(j)
                    if j < n and s[j] == "*":
                        j += 1
                        j = skip_ws(j)
                    g1 = parse_braced_group(j)
                    if g1 is None:
                        break
                    j = skip_ws(g1)
                    gopt = parse_bracket_group(j)
                    if gopt is not None:
                        j = skip_ws(gopt)
                    g2 = parse_braced_group(j)
                    if g2 is None:
                        break
                    i = g2
                    break
            else:
                for cmd in ("\\def", "\\gdef", "\\xdef", "\\edef"):
                    if s.startswith(cmd, i):
                        j = i + len(cmd)
                        j = skip_ws(j)
                        j = parse_control_sequence(j)
                        j = skip_ws(j)
                        g = parse_braced_group(j)
                        i = g if g is not None else j
                        break
                else:
                    out.append(s[i])
                    i += 1
                continue
            continue

        s = text
        return "".join(out)

    s2 = strip_macros(s)
    s2 = re.sub(r"\s+", " ", s2).strip()
    return s2


def _preprocess_for_handwriting(img: Image.Image) -> Image.Image:
    """专门针对手写公式的预处理"""
    base = img.convert("L")
    bg = _estimate_background_luma(base)
    if bg < 128:
        try:
            base = ImageOps.invert(base)
        except Exception:
            pass

    base = ImageOps.autocontrast(base, cutoff=1)
    base = ImageEnhance.Contrast(base).enhance(1.35)

    try:
        base = base.filter(ImageFilter.MedianFilter(size=3))
    except Exception:
        pass

    try:
        base = base.filter(ImageFilter.MinFilter(size=3))
    except Exception:
        pass

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


def _preprocess_binarized(img: Image.Image) -> Image.Image:
    base = _preprocess_for_handwriting(img).convert("L")
    try:
        mean = float(ImageStat.Stat(base).mean[0])
    except Exception:
        mean = 220.0
    t = int(max(140, min(235, mean * 0.92)))
    bw = base.point(lambda p: 255 if p > t else 0)
    try:
        bw = bw.filter(ImageFilter.MinFilter(size=3))
    except Exception:
        pass
    return bw.convert("RGB")


def _pad_to_stride_multiple(img: Image.Image, stride: int = 32) -> Image.Image:
    if stride <= 1:
        return img
    w, h = img.size
    if w <= 0 or h <= 0:
        return img
    nw = ((w + stride - 1) // stride) * stride
    nh = ((h + stride - 1) // stride) * stride
    if nw == w and nh == h:
        return img
    out = Image.new("RGB", (nw, nh), (255, 255, 255))
    out.paste(img.convert("RGB"), (0, 0))
    return out


def _extract_latex(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result.strip()
    if isinstance(result, dict):
        for key in ("text_formula", "formula", "latex", "text", "result"):
            v = result.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in result.values():
            text = _extract_latex(v)
            if text:
                return text
        return ""
    if isinstance(result, (list, tuple)):
        parts = []
        for item in result:
            text = _extract_latex(item)
            if text:
                parts.append(text)
        return " ".join(parts).strip()
    return ""


def _to_png_data_url(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _recognize_with_fallback(img: Image.Image) -> str:
    """使用多种策略进行识别"""
    base = img
    cropped = _auto_crop_to_content(base)
    variants = [base]
    if cropped.size != base.size:
        variants.append(cropped)
    candidates: list[Image.Image] = []
    for v in variants:
        candidates.append(_pad_to_stride_multiple(v))
        try:
            candidates.append(_pad_to_stride_multiple(_preprocess_for_handwriting(v)))
        except Exception:
            pass
        try:
            candidates.append(_pad_to_stride_multiple(_preprocess_binarized(v)))
        except Exception:
            pass

    # 如果是 Pix2Text
    model = _get_pix2text_model()
    if model is not None and hasattr(model, 'recognize'):
        try:
            if hasattr(model, "recognize_formula"):
                for cand in candidates:
                    try:
                        result = model.recognize_formula(cand, batch_size=1, return_text=True)
                    except TypeError:
                        result = model.recognize_formula(cand)
                    latex = _sanitize_latex(_extract_latex(result))
                    if latex:
                        return latex

            # 兜底：走默认 recognize（可能包含检测/布局）
            for cand in candidates:
                result = model.recognize(cand)
                latex = _sanitize_latex(_extract_latex(result))
                if latex:
                    return latex
            model = None

        except Exception:
            model = None

    # 如果是 pix2tex 或者 Pix2Text 失败
    try:
        model = _get_pix2tex_model()
    except Exception:
        return ""

    try:
        for cand in candidates:
            try:
                latex = model(cand)
            except Exception:
                continue
            latex = _sanitize_latex(latex.strip() if isinstance(latex, str) else "")
            if latex:
                return latex
        latex = ""
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

    debug_flag = req.debug is True
    if not debug_flag:
        debug_flag = str(os.getenv("OCR_DEBUG", "")).strip().lower() in {"1", "true", "yes"}
    processed = None
    if debug_flag:
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

    latex = _sanitize_latex(latex)
    if latex and not latex.startswith("$") and not latex.startswith("\\[") and not latex.startswith("\\("):
        latex = f"${latex}$"

    if not latex:
        resp = {"latex": "", "error": "EMPTY_LATEX"}
    else:
        resp = {"latex": latex}
    if processed is not None:
        resp["debug"] = {"processedImageDataUrl": _to_png_data_url(processed)}
    return resp
