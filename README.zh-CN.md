# dsh-search-picker

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-8257D0.svg)](https://github.com/topics/dsh-plugin)
[![CI](https://github.com/xiaoxiaosrm/dsh-search-picker/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaoxiaosrm/dsh-search-picker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.1.0-0A84FF.svg)](https://github.com/xiaoxiaosrm/dsh-search-picker/releases/tag/v0.1.0)

[English](README.md) | **中文**

在 DSH 桌面版侧边栏底部（Settings 行上方）放一个「搜索：…」按钮，一键切换 `ctx.web` 的搜索后端。切换写入的是 **官方 `web` 设置命名空间的 `searchProvider` 字段**，也就是「插件 > 网页搜索」页编辑的同一个字段，因此：

- 切换立即生效，不需要重启；
- 重启后保持（写入宿主 settings 文档）；
- 与官方设置页完全一致，不会互相覆盖。

## 可选引擎

| id | 引擎 | 凭据 | 说明 |
|---|---|---|---|
| `deepseek-official` | DeepSeek 官方 Messages | `DEEPSEEK_API_KEY` | 官方内置，Anthropic Messages + `web_search_20250305`，每次搜索消耗模型 token |
| `deepseek-search-api` | DeepSeek 官方 Search API | `DEEPSEEK_API_KEY` | 官方内置，直接检索 API，不烧模型 token |
| `opencode-go` | OpenCode Go | `OPENCODE_GO_API_KEY` | 本插件提供；Anthropic Messages + `x-opencode-session` 头；约 $0.01/次 |
| `tavily` | Tavily | `TAVILY_API_KEY` | 本插件提供；未配置 key 时置灰 |
| `exa` | Exa | `EXA_API_KEY` | 本插件提供；未配置 key 时置灰 |

未配置凭据的引擎在菜单里置灰；直接在设置里选中未注册/不可用的 provider 时，`web_search` 会返回明确的 `WEB_PROVIDER_*` 错误，不会静默换引擎。

## 界面

按钮固定在侧边栏底部、Settings 行上方。菜单是 `position: fixed` 浮层：宽度跟随侧边栏内容宽度（侧边栏默认 280px、可拖拽 264–420px，对应菜单 240–396px），拖动侧边栏时实时变化，因此不会被侧边栏列的 `overflow: hidden` 裁掉；侧边栏折叠成 56px 图标轨时，菜单以 280px 向右浮出。

菜单背景是不透明的：浅色主题纯白、深色主题深灰（`--dsw-alias-bg-layer-1`，随主题自动切换），并配官方浮层描边与柔和投影（`--dsw-elevation-panel`，0.5px 描边 + 双层阴影）。官方菜单那套 `--dsw-specific-menu` + `backdrop-filter` 毛玻璃刻意没有沿用——它只有 58% 不透明、必须靠 blur 才成型，缺了模糊就会透出侧边栏文字。

## 安装（desktop profile）

1. 克隆到任意固定位置：

   ```powershell
   git clone https://github.com/xiaoxiaosrm/dsh-search-picker.git D:\tools\dsh-search-picker
   ```

2. 编辑 `%DSH_HOME%\profiles\desktop\package.json`（POSIX：`$DSH_HOME/profiles/desktop/package.json`）：
   - `dependencies` 增加 `"dsh-search-picker": "file:D:/tools/dsh-search-picker"`；
   - `dsh.profile.bundles` 增加 `"dsh-search-picker"`。
3. 在 `%DSH_HOME%\profiles\desktop` 执行 `pnpm install`。
4. 完全退出并重开 DSH 桌面版（loader 只在启动时扫描 profile bundles；客户端 bundle 同样在启动时读入内存，改完插件后刷新页面不够）。

如果 `file:` 依赖解析失败，可把本目录复制到 `%DSH_HOME%\profiles\desktop\node_modules\dsh-search-picker`，并在 `dsh.profile.bundles` 中追加包名。

## 配置

插件自带默认 patch 条目（`cordis.patch.yml`），所有字段均可省略，省略即使用内置默认值：

```yaml
- insert:
    - id: search-picker
      name: dsh-search-picker
      config:
        opencodeGo:
          baseURL: https://opencode.ai/inference/go/anthropic/v1
          model: deepseek-v4.1-flash
          maxTokens: 4096
          maxUses: 5
        tavily:
          baseURL: https://api.tavily.com
          apiKeyEnv: TAVILY_API_KEY
        exa:
          baseURL: https://api.exa.ai
          apiKeyEnv: EXA_API_KEY
```

在 profile 的 `cordis.patch.yml` 里按同一个条目 id 覆盖任意字段即可。

## 凭据

本插件不直接读写凭据文件：搜索时通过 `ctx.credentials` 解析 `apiKeyEnv` 指向的凭据引用，找不到时回退到进程环境变量。缺失凭据抛出 `WEB_PROVIDER_CREDENTIAL_MISSING`，错误信息包含所引用的变量名。

## 回退

1. 在菜单里切回 `deepseek-official`（或使用官方「插件 > 网页搜索」页）；
2. 从 profile `package.json` 删除 `dsh-search-picker` 依赖与 `dsh.profile.bundles` 条目，`pnpm install`，重启桌面版。

## 排障

- **`deepseek-official` 返回 404**：检查 profile patch 或其它插件是否覆盖了 `web-search-deepseek.baseURL`。它必须保持内置默认值（`https://api.deepseek.com/anthropic/v1`）；指向搜索服务的地址会把这个 provider 弄坏。
- **菜单宽度不跟随侧边栏**：浮层用 `ResizeObserver` 测量锚点；改过 profile/bundle 后重启桌面版以重新加载客户端 bundle。

## 测试

```powershell
npm run check                # 三个入口文件的 node --check
npm test                     # node --test test/engines.test.mjs
node test/engines.test.mjs   # 单进程兜底
```

单进程兜底用于禁止子进程管道的 Windows 沙箱（`spawn EPERM`）。

## 已知限制

- 菜单里的引擎是固定清单；官方两个 provider 的 `apiKeyEnv` 若被改到别的凭据名，置灰判断仍按默认引用名。
- 与 `dsh-free-search` / `dsh-web-search-free` 这类「运行时接管 `web.searchProvider`」的插件冲突，不要同时安装。
- `opencode-go` 的 `x-opencode-session` 在拿不到当前会话 id 时使用进程内随机 UUID（对 Go 中继而言只需不透明且稳定）。

## 兼容性

- DSH 桌面版 `0.2.1-rc.2`（声明在 `package.json` 的 `dsh.compatibility`）。
- 客户端半区面向 `web` 平台，inject `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-settings`。

## 许可证

[MIT](LICENSE) © 2026 xiaoxiaosrm
