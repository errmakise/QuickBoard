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

#### 后端可选环境变量（同步兜底/稳定性）
- `ROOM_SNAPSHOT_INTERVAL_SECONDS`：定期快照广播周期（秒），默认 `30`；设为 `0/false/no/off` 关闭。
  - 作用：在弱网/后台挂起/偶发丢包时，定期把“服务端权威快照（含 tombstones 删除墓碑）”广播给房间内用户，帮助客户端最终收敛一致。
- `ROOM_DELTA_LOG_LIMIT`：断线重连的增量补包日志上限，默认 `5000`（越大越能覆盖更久的离线窗口，但更占内存）。

### 3) 前端服务
```powershell
cd D:\project\QuickBoard\frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

## 弱网模拟（开发验证）
前端内置“弱网模拟器”，用于在本机稳定复现延迟/抖动/丢包，观察同步是否还能最终收敛。

### 开启方式（URL 参数）
示例：打开两个浏览器标签页进入同一房间，然后在其中一个标签页加上弱网参数：

```
http://127.0.0.1:5173/board?room=demo-room&netsim=1&drop=0.1&delay=200&jitter=200
```

参数含义：
- `netsim=1`：开启弱网模拟
- `drop`：丢包率（0~1，例如 `0.1` 表示 10%）
- `delay`：基础延迟（毫秒）
- `jitter`：抖动（毫秒，最终延迟 = delay + random(0..jitter)）

开启后，白板右下角状态区会显示“弱网模拟”当前参数与收发统计。

## 端口被占用时（不改端口，直接结束进程）
```powershell
$ports = 3000, 5007, 5173
Get-NetTCPConnection -State Listen |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```
