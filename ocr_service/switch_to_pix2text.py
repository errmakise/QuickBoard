#!/usr/bin/env python3
"""
一键切换到 Pix2Text 的脚本
"""
import os
import sys
import shutil
import subprocess

def run_cmd(cmd, cwd=None):
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error: {result.stderr}")
        return False
    print(result.stdout)
    return True

def main():
    ocr_dir = os.path.dirname(os.path.abspath(__file__))
    
    print("=== 切换到 Pix2Text 方案 ===")
    
    # 1. 安装新的依赖
    print("\n1. 安装 Pix2Text 依赖...")
    req_file = os.path.join(ocr_dir, "requirements-pix2text.txt")
    if not run_cmd(f"{sys.executable} -m pip install -r {req_file}"):
        print("❌ 依赖安装失败")
        return False
    
    # 2. 备份原文件
    print("\n2. 备份原文件...")
    app_py = os.path.join(ocr_dir, "app.py")
    app_py_bak = os.path.join(ocr_dir, "app-pix2tex.py.bak")
    
    if os.path.exists(app_py) and not os.path.exists(app_py_bak):
        shutil.copy2(app_py, app_py_bak)
        print("已备份 app.py -> app-pix2tex.py.bak")
    
    # 3. 替换为新文件
    print("\n3. 切换到 Pix2Text 实现...")
    app_new = os.path.join(ocr_dir, "app_pix2text.py")
    app_target = os.path.join(ocr_dir, "app.py")
    
    if os.path.exists(app_new):
        shutil.copy2(app_new, app_target)
        print("✅ 已切换到 Pix2Text 实现")
    else:
        print(f"❌ 找不到新文件: {app_new}")
        return False
    
    print("\n=== 切换完成 ===")
    print("现在可以重新启动 OCR 服务了:")
    print(f"cd {ocr_dir}")
    print("python -m uvicorn app:app --host 127.0.0.1 --port 5005")
    
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)