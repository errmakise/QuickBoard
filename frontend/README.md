# QuickBoard（Frontend）

## 端口约定
- 前端（Vite）：`http://127.0.0.1:5173`
- 后端（API + Socket）：`http://127.0.0.1:3000`

前端通过环境变量 `VITE_API_URL` 指向后端（默认建议 `http://127.0.0.1:3000`），白板的公式识别等能力由后端再转发到 OCR 服务。

## 开发运行
```sh
npm install
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

## 构建
```sh
npm run build
```

## 单测与规范
```sh
npm run test:unit
npm run lint
```
