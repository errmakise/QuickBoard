import json
import os
import sys

from PIL import Image
from PIL import ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import _auto_crop_to_content, _pad_to_stride_multiple, _preprocess_for_handwriting, _sanitize_latex


def main() -> int:
    stride = 32

    img_white = Image.new("RGB", (485, 768), (255, 255, 255))
    processed_white = _preprocess_for_handwriting(img_white)
    padded_white = _pad_to_stride_multiple(processed_white, stride=stride)

    img_content = Image.new("RGB", (900, 600), (255, 255, 255))
    d = ImageDraw.Draw(img_content)
    d.rectangle((380, 260, 520, 330), fill=(0, 0, 0))
    cropped = _auto_crop_to_content(img_content)
    processed_cropped = _preprocess_for_handwriting(cropped)
    padded_cropped = _pad_to_stride_multiple(processed_cropped, stride=stride)

    img_faint = Image.new("RGB", (900, 600), (255, 255, 255))
    df = ImageDraw.Draw(img_faint)
    df.line((260, 300, 640, 300), fill=(220, 220, 220), width=5)
    df.line((450, 200, 450, 420), fill=(220, 220, 220), width=5)
    faint_cropped = _auto_crop_to_content(img_faint)

    img_dark = Image.new("RGB", (640, 420), (20, 20, 20))
    dd = ImageDraw.Draw(img_dark)
    dd.line((110, 210, 520, 210), fill=(245, 245, 245), width=6)
    dd.line((315, 130, 315, 310), fill=(245, 245, 245), width=6)
    processed_dark = _preprocess_for_handwriting(img_dark).convert("L")
    hist = processed_dark.histogram()
    total = float(processed_dark.size[0] * processed_dark.size[1])
    mean_dark = sum((i * float(c)) for i, c in enumerate(hist)) / max(1.0, total)

    ok_stride_white = padded_white.size[0] % stride == 0 and padded_white.size[1] % stride == 0
    ok_crop_smaller = cropped.size[0] < img_content.size[0] and cropped.size[1] < img_content.size[1]
    ok_stride_cropped = padded_cropped.size[0] % stride == 0 and padded_cropped.size[1] % stride == 0
    ok_faint_crop_smaller = faint_cropped.size[0] < img_faint.size[0] and faint_cropped.size[1] < img_faint.size[1]
    ok_dark_inverted = mean_dark > 150.0

    macro_only = r"\newcommand{\R} {\mathbb{R}} \newcommand{\1} {\lambda} \newcommand{\id} {\Sigma}"
    macro_plus = r"\newcommand{\R} {\mathbb{R}} \newcommand{\1} {\lambda} 1+1"
    sanitized_only = _sanitize_latex(macro_only)
    sanitized_plus = _sanitize_latex(macro_plus)
    ok_sanitize_only_empty = sanitized_only.strip() == ""
    ok_sanitize_plus_keeps = sanitized_plus.replace(" ", "") == "1+1"
    ok = bool(
        ok_stride_white
        and ok_crop_smaller
        and ok_stride_cropped
        and ok_faint_crop_smaller
        and ok_dark_inverted
        and ok_sanitize_only_empty
        and ok_sanitize_plus_keeps
    )
    report = {
        "ok": bool(ok),
        "suite": "ocr_preprocess_selftest",
        "checks": {
            "strideWhite": bool(ok_stride_white),
            "cropSmaller": bool(ok_crop_smaller),
            "strideCropped": bool(ok_stride_cropped),
            "faintCropSmaller": bool(ok_faint_crop_smaller),
            "darkBgInverted": bool(ok_dark_inverted),
            "sanitizeMacroOnlyEmpty": bool(ok_sanitize_only_empty),
            "sanitizeKeepsFormula": bool(ok_sanitize_plus_keeps)
        },
        "stride": stride,
        "cases": {
            "white": {
                "inputSize": list(img_white.size),
                "processedSize": list(processed_white.size),
                "paddedSize": list(padded_white.size)
            },
            "contentCrop": {
                "inputSize": list(img_content.size),
                "croppedSize": list(cropped.size),
                "processedSize": list(processed_cropped.size),
                "paddedSize": list(padded_cropped.size)
            },
            "faintCrop": {
                "inputSize": list(img_faint.size),
                "croppedSize": list(faint_cropped.size)
            },
            "darkBg": {
                "inputSize": list(img_dark.size),
                "processedMeanLuma": float(mean_dark)
            },
            "sanitize": {
                "inputMacroOnly": macro_only,
                "outputMacroOnly": sanitized_only,
                "inputMacroPlus": macro_plus,
                "outputMacroPlus": sanitized_plus
            }
        }
    }
    sys.stdout.write(json.dumps(report) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
