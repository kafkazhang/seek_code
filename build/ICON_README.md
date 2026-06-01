# 应用 / 安装包图标

把你的 **图标版** logo 放到本目录，命名为：

```
build/icon.png
```

要求：
- **仅图标**（不含文字/标语），正方形；
- **1024×1024**，PNG（透明或纯色背景皆可）；
- 这是 electron-builder 的 `buildResources` 目录，打包时会**自动**由这张 `icon.png`
  生成各平台图标：Windows `.ico`、macOS `.icns`、Linux 多尺寸 PNG，无需手动转换。

放进来后无需改配置：
- 打包（`npm run build` + electron-builder）后的桌面/任务栏/安装程序图标会用它；
- 开发期运行（`npm run start`）的窗口/任务栏图标也会用它（`src/main/index.ts` 自动探测 `build/icon.png`）。

> 如需 Windows 单独提供 `.ico`、macOS 单独提供 `.icns`，也可直接放
> `build/icon.ico` / `build/icon.icns`，electron-builder 会优先采用。
