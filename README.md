# 实时协作白板（QuickBoard）

## 项目结构
- `frontend/`：Vue 3 + Vite 前端
- `backend/`：Node.js + Express + Socket.IO 后端
- `ocr_service/`：FastAPI OCR 服务（公式识别）

## 固定端口约定
- 前端（Vite）：`http://127.0.0.1:5173`
- 后端（API + Socket）：`http://127.0.0.1:3000`
- OCR（公式识别）：`http://127.0.0.1:5007/recognize`

前端只请求后端 `:3000`，由后端转发到 OCR `:5007`。

## 开发环境运行

### 1) OCR 服务
```powershell
cd D:\project\QuickBoard\ocr_service
python -m uvicorn app:app --host 127.0.0.1 --port 5007
```

### 2) 后端服务
```powershell
cd D:\project\QuickBoard\backend
npm install
$env:PORT=3000
$env:LOCAL_MATH_OCR_URL="http://127.0.0.1:5007/recognize"
node server.js
```

### 3) 前端服务
```powershell
cd D:\project\QuickBoard\frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

## 端口被占用时（不改端口，直接结束进程）
```powershell
$ports = 3000, 5007, 5173
Get-NetTCPConnection -State Listen |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```
