# 应用内 Logo / Favicon

把你的 **图标版** logo 放到本目录，命名为：

```
src/renderer/public/brand.png
```

要求：
- **仅图标**（不含 “seekcode” 文字与标语），正方形；
- **透明背景**（PNG with alpha）。标题栏是深色，带白底的图会显示成白方块；
- 建议 ≥ 256×256（界面里显示约 26px，favicon 复用同一张）。

放进来后无需改任何代码：
- 标题栏左上角的品牌标识会自动用它（`<BrandMark>`）；
- 浏览器/窗口 favicon 也会用它（`index.html` 已引用 `./brand.png`）。

> 文件缺失时，标题栏会回退到内置的「声呐脉冲」动画标识，界面不会破损。
