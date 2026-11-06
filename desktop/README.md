# 族谱清晰化工作台桌面端

这是一个独立的 Windows 桌面启动器，默认使用本地 `8091` 端口，现有浏览器版不受影响。

## 当前阶段

桌面端启动本地 Nest 服务并打开现有管理界面。使用桌面端时，项目根目录优先通过服务端的 Windows 目录选择器选择，图片不需要先上传到浏览器；关闭窗口后桌面端会缩到托盘，本地服务和后台任务继续运行。

账号登录、模型配置、云端模型调用和每个账号的生图用量统计仍复用现有服务端接口，不另建一套账号体系。

## 打包前提

当前版本的安装包需要目标电脑已有：

- Node.js
- Python + OpenCV（算法处理）
- MySQL（沿用现有服务端配置）

后续如果需要真正单文件、无运行环境依赖的 EXE，需要再把 Node/Python/OpenCV 和 native `sharp` 一起做运行时封装，这属于第二阶段打包工作。

## 构建

先在仓库根目录构建服务端和管理端：

```powershell
npm run build:server:prod
npm run build:admin:prod
```

然后在 `desktop/` 安装依赖并打包：

```powershell
npm install
npm run dist
```
