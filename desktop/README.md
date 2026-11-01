# 桌面客户端（exe）

一个只负责“打开服务器页面”的 Windows 程序：首次运行输入服务器地址，之后自动记住。
好处：不用记网址；http://IP 访问时“选择目录”也能用（客户端把服务器地址当作安全来源）。

## 获取 exe（推荐：GitHub 自动打包）
1. 打开仓库 GitHub 页面 → **Actions → build-exe → Run workflow**；
2. 等 3~5 分钟，在该次运行页面底部 **Artifacts** 下载 `ZupuWorkbench-exe`，里面就是 `ZupuWorkbench.exe`（免安装便携版）。
3. 打正式版本：`git tag desktop-v1.0.0 && git push --tags`，exe 会自动挂到 Releases。

## 本机自己打包
```powershell
cd desktop
npm install
npm run dist      # 产物在 desktop\dist\
```

## 使用
双击运行 → 输入如 `https://zupu.example.com` 或 `http://192.168.1.10:8081` → 进入。
改地址：菜单「文件 → 修改服务器地址」。
