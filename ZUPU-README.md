# 族谱扫描清理 · 本地运行

## 启动

后端（Nest，端口 8080）：
```
cd D:\xiangmu\node\ZupuTupianUtils
npm run dev:server
```

前端（React 圆形原型 UI，端口 8888）：
```
cd D:\xiangmu\node\ZupuTupianUtils
npm run dev:admin
```

或：
```
cd D:\xiangmu\node\ZupuTupianUtils\admin-web
npm run dev
```

打开 http://localhost:8888 ，账号 `admin` / `admin123`。
审阅深链：`/tasks/:id/review`（如 http://localhost:8888/tasks/1/review）。

## 目录

- `admin-web/` React 工作台（圆形 Apple 风格，与原型一致）
- `server/` Nest 后端
- `待处理的图片/` 样例与原型参考
- `data/` / `sql/` 数据与脚本

清理算法走 Nest + ScanWash，勿改 Python 核心。
