# @alipay/rotom-website

Rotom A2A Gateway 官网 —— 纯静态 Astro 站点。

**与生产代码完全隔离**:不依赖 `src/master`、`src/executor`、`src/cli`,不参与根 `build:master`,
不进 npm 发布包 `files[]`。本目录的 `dist/` 由 `astro build` 独立产出,可丢到任意静态托管。

## 开发

```bash
# 在仓库根
pnpm website:dev        # http://localhost:4321
pnpm website:build      # 产出到 packages/website/dist/
pnpm website:preview    # 预览构建产物
```

## 截图

`public/screenshots/` 下的截图由 chrome-devtools MCP 本地截取 dashboard 而来。
若本地未启动 master(`pnpm master:start`),截图板块会显示占位灰块,不影响构建。
