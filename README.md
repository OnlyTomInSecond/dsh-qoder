# @local/dsh-llm-qoder

让 DeepSeek Harness 直接使用 **Qoder** 的模型与额度。PAT/刷新令牌、COSY 签名、模型目录、SSE 网关、thinking/DSML 工具调用处理等协议实现全部内置于本包（`src/qoder/`），不依赖任何其他 Qoder 插件或 pi 包；`index.js` 是自包含的 DSH 插件产物。

## 从源码安装

### 0. 准备

- Node.js 22+ 与 `pnpm`（DSH 自身需要）
- 可运行的 DSH：源码 checkout，或已安装的 `dsh` CLI
- Git

插件本身没有运行时依赖，Qoder 协议层会打进 `index.js`；构建期依赖只有 `esbuild` 与 `@deepseek-ai/schemastery`。

### 1. 下载并构建

```bash
git clone <本仓库地址> dsh-qoder
cd dsh-qoder
npm install
npm run build
```

`npm install` 安装构建期依赖（`prepare` 会自动跑一次构建），`npm run build` 重新生成 `index.js`。有 lockfile 时也可以用 `npm ci`。

`index.js` 是构建产物，**不在仓库里**：任何一次 `git pull` 或改动 `src/` 之后重跑 `npm run build` 即可。

### 2. 安装到 DSH profile

下面以 Web UI 使用的 `web` profile 为例；其他 profile 换成对应名字。**必须使用绝对路径**：`installBundle` 最终执行 `pnpm add <spec>`，工作目录是 profile 目录，只有 `./`、`../` 会相对调用方解析，裸相对路径会落到 `~/.dsh/profiles/<profile>/` 下。

**方式 A：Agent 工具（推荐）**

```
plugin_manager(action="install_bundle", target="/绝对路径/dsh-qoder")
```

**方式 B：DSH CLI**

```bash
dsh plugin --profile web add /绝对路径/dsh-qoder
```

如果 DSH 是源码 checkout、没有全局 `dsh`：

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /绝对路径/dsh-qoder
```

**方式 C：Web UI**

侧边栏 **Plugins → Add plugin**，填入同一个绝对路径，确认安装。

安装后：

- profile 的 `package.json` 增加 `"@local/dsh-llm-qoder": "link:/.../dsh-qoder"`
- `dsh.profile.bundles` 末尾加入 `@local/dsh-llm-qoder`
- 包内 `cordis.patch.yml` 插入 `llm-qoder` 行，同时注册 `qoder` 与 `qoder-cn` 两条路由

### 3. 在 Plugins 页配置

本插件**不会**在 Models 页登记 Qoder 供应商条目：它不声明 configurable provider，所以 Models 页里既没有 Qoder 的「添加供应商」入口，也没有它的卡片。所有配置都在 **DSH 原生的插件配置页** 里完成：打开 **Plugins → `@local/dsh-llm-qoder`**，正文里就是这张卡片。这是 DSH 为「bundle 自己的配置」预留的位置（`plugins.bundle.config` 槽位），和其他插件（终端、Web 搜索等）的配置页完全一致。

卡片提供：

- **每个区域的访问令牌**（`Qoder` / `Qoder CN`），写入 DSH 凭据存储的 `QODER_API_KEY` / `QODER_CN_API_KEY` 引用，不落到配置文件；留空表示不修改，页面只显示「已配置」而从不回显令牌。保存令牌即可让该区域的模型出现在模型选择器里——模型列表跟随**令牌**，不再需要任何「添加供应商」步骤。
- **上下文窗口三选一**：目录默认档 / 目录最大档 / 自定义，与 pi 插件的 `/qoder-settings context <default|max|tokens>` 同一套语义。显式值超过目录公布的最大档会被夹到该档（上游不接受更大的窗口）。
- **其余额度选项**：输出上限、思考回放、流空闲超时、增量合并间隔、`debug`，与「配置」一节的字段一一对应。

实现要点：

- 浏览器半是 `src/client/`，构建成 DSH 客户端模块系统要求的 lazy-CJS 产物 `lib/client.js`（`npm run build` 生成）；只把 `react` 留作外部依赖，其余全部内联。
- `plugins.bundle.config` 是按**包名**取键的槽位，页面**不会**给它传 `form`（只有 `plugins.item` / `plugins.row.config` 会拿到 `ConfigPageForm`，因为它们的键就是设置命名空间）。所以卡片自己通过 `ctx.configForms.get("llm-qoder")` 绑定该插件的 Config 表单并跟随它的快照，而不是等页面施舍 `form`。
- `ctx.remote.credentials` 的方法返回的是 `RemoteResult` 信封（`{ok, value}` / `{ok, error}`），失败不是异常。浏览器半统一解包，被拒绝的写入才会以错误显示，而不是当成成功。
- Host 侧不新增任何 HTTP 路由，也不改 DSH 源码；卡片通过 `ctx.configForms` 写配置、通过 `ctx.remote.credentials` 写令牌，都是 DSH 已有的服务。
- bundle 被关闭时配置页一并消失，因为 DSH 的 client 模块系统按 Loader 行装载浏览器半。
- 卡片文案走客户端 locale 服务（命名空间 `llmQoder`，内置中英两套），跟随界面语言，不在代码里硬编码中文。
- 页面正文只放这张卡片：长描述来自 `locale/*.json` 的 `meta.detail`，指向 `docs/plugin-page.md`，不再把整份 README 摆到插件页上。

也可以完全不用界面，仅用环境变量提供令牌：

```bash
QODER_API_KEY=pt-... dsh web   # 或该安装的启动命令
```

CN 区改用 `QODERCN_API_KEY`。环境变量的优先级高于配置页写入的令牌，适合一次性运行。

### 4. 验证

- **Plugins → `@local/dsh-llm-qoder`** 里两个区域都能填写令牌，保存后显示「已配置」。
- 保存令牌后，模型选择器立即出现该区域的模型——模型列表跟随**令牌**，与 Models 页无关。
- 模型选择器出现对应模型（以 Qoder 实时目录为准）；首次可能先显示内置静态模型，后台刷新后替换。
- 命令行检查 composed config：`dsh --profile web --dump-config | grep -A3 llm-qoder`
- `~/.dsh/qoder/` 出现目录缓存，说明后台实时目录刷新成功。

### 5. 更新

```bash
cd dsh-qoder
npm run build
```

然后对同一目录再执行一次 remove + install，让 Harness 导入新的模块代：

```
plugin_manager(action="remove_bundle", target="@local/dsh-llm-qoder")
plugin_manager(action="install_bundle", target="/绝对路径/dsh-qoder")
```

插件的所有改动都在本包内（`src/` → `index.js`），DSH 侧不需要重建任何东西。

### 6. 卸载

- Agent：`plugin_manager(action="remove_bundle", target="@local/dsh-llm-qoder")`
- Web：**Plugins** 页找到该 bundle，点 **Remove**

## 凭据

只使用 DSH 自己的凭据体系，不读取 `~/.pi/` 或任何其他 Agent 的登录状态。

推荐用 **Plugins → `@local/dsh-llm-qoder`** 里的配置卡片填写：令牌写入 DSH 凭据存储的 `QODER_API_KEY`（CN 为 `QODER_CN_API_KEY`）引用，不进入配置文件，保存后下一次请求立即生效，可随时覆盖。

也可以在启动环境里提供令牌（见「从源码安装」第 3 节）；环境变量优先级更高，适合一次性运行。

也支持：

1. 环境变量：`QODER_API_KEY` / `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT`（CN 用 `QODERCN_*`）
2. DSH 凭据记录 `llm-qoder/qoder`（PAT 换取的 job token 及刷新后的令牌会写回这里）

输入值以 `pt-` 开头时按 PAT 换取短时 job token；否则按 `jt-` 访问令牌直接使用。模型目录缓存同样只落在 `$DSH_HOME/qoder/`。

冷启动时优先复用未过期的 `llm-qoder/<provider>` grant；只有配置的 PAT 变了、或 grant 刷新失败时才重新兑换。兑换失败会把 Qoder 返回的错误体一并显示，便于区分 token 无效与网络/协议问题。

## 使用

Host 侧安装后立即生效。在 **Plugins → `@local/dsh-llm-qoder`** 里填入令牌（或按上一节用环境变量）后，模型选择器出现 `Qoder` / `Qoder CN` 的模型（以 Qoder 实时目录为准）。插件只注册 Host 侧的 LLM 路由、模型元数据，以及一个走 DSH 原生 Plugins 页的浏览器半，不改动 DSH 源码。

想把 Qoder 设为默认模型，在 profile patch 中覆盖：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: qoder
    model: Qwen3.8-Flash
```

## 配置

所有配置项都在 **Plugins → `@local/dsh-llm-qoder`** 的卡片里；也可以用 profile patch 直接写同名字段。

### 额度与流式选项

这些选项与 pi 插件的 `/qoder-settings` 同名同义，区别是 DSH 插件把它们声明为 **volatile Config 字段**：直接写在 profile patch 里，或在生成的插件设置表单里改，**下一次请求立即生效**，不需要重新挂载。取值优先级是 **环境变量 > Config > 默认值**，环境变量仍然可以覆盖一次性的运行。

| 字段 | 默认 | 作用 | 环境变量 |
|---|---|---|---|
| `contextWindow` | 目录默认档 | 用于触发压缩的上下文预算。留空表示用 Qoder 目录自己标注的默认档（常见 200K），而不是最大档 | `QODER_CONTEXT_WINDOW` |
| `useMaxContext` | `false` | 改用目录里最大的一档（更多压缩余量，也更多 Credit） | `QODER_CONTEXT_MAX=1` |
| `maxOutputTokens` | `32768` | 单次请求 `max_tokens`（上限 131072） | `QODER_MAX_OUTPUT_TOKENS` |
| `replayReasoning` | `none` | 回放多少历史思考：`none` / `last` / `all`（qodercli 行为，最贵） | `QODER_REPLAY_REASONING` |
| `streamIdleTimeoutMs` | `120000` | 单个流读取的空闲超时 | `QODER_STREAM_IDLE_TIMEOUT_MS` |
| `streamDeltaIntervalMs` | `50` | 文本/思考增量的合并间隔，`0` 表示不合并 | `QODER_STREAM_DELTA_INTERVAL_MS` |
| `debug` | `false` | 输出 best-effort 路径的诊断日志 | `QODER_DEBUG` |

降低 Credit 的实际手段：保持默认上下文档、保持 32K 输出上限、`replayReasoning: none`；长会话主动开新会话或手动 compact，而不是让一条对话长到几十万 token。

上下文窗口按目录的 `context_config` 决策：优先取标记为 `is_default` 的档位；没有默认标记时取最小档（最便宜），再退到 `max_input_tokens`，最后才是内置的 200K 兜底。`contextWindow` 显式赋值会被夹到目录公布的最大档以内，因为上游不接受更大的窗口。

## 两个区域

| | `qoder`（国际） | `qoder-cn`（中国） |
|---|---|---|
| 网关 | `api3.qoder.sh` | `gateway.qoder.com.cn` |
| 凭据引用 | `QODER_API_KEY` | `QODER_CN_API_KEY` |
| 环境变量 | `QODER_*` | `QODERCN_*` |
| 模型目录缓存 | `$DSH_HOME/qoder/qoder-models-cache.json` | `$DSH_HOME/qoder/qoder-cn-models-cache.json` |

两者是**独立账号、独立额度、独立模型目录**，因此必须作为两条 provider 路由存在；这与 pi 插件的做法一致。区别只在区域配置和凭据，适配层与协议实现完全共用。两条路由始终注册，是否使用只看该区域是否存了令牌。

## 实现结构

| 文件 | 作用 |
|---|---|
| `src/index.ts` | DSH provider 路由、模型元数据、流式调用入口 |
| `src/qoder-credentials.ts` | DSH 凭据引用 / DSH 记录 / 环境变量的解析与刷新 |
| `src/pi-context.ts` | DSH 消息与工具 → pi transcript |
| `src/qoder/settings.ts` | Credit/流式选项：volatile Config schema + 每请求解析 |
| `src/qoder/limits.ts` | Host 与浏览器半共用的上下限/默认值（避免两边漂移） |
| `src/client/index.ts` | 浏览器半：Plugins 页里的配置卡片（令牌 + 额度选项） |
| `src/client/form.ts` | 卡片的状态、校验与保存顺序（纯逻辑 + 控制器） |
| `src/client/locales.ts` | 卡片文案（中/英），注册进客户端 locale 服务 |
| `docs/plugin-page.md` | 插件页正文：一句话说明，正文其余交给卡片 |
| `src/stream-bridge.ts` | pi 事件 → DSH `StreamChunk` |
| `src/qoder/` | 自包含的 Qoder 协议实现（含 `pi-ai.ts` 本地类型/辅助函数，无外部运行时依赖） |

## 验证

```bash
node build.mjs
node scripts/config-card-smoke.mjs                   # 表单规则 + 模型列表 gate（离线）
node scripts/client-card-smoke.mjs                   # 浏览器半的接线（离线）
node scripts/smoke.mjs                               # 实时目录（需要令牌）
QODER_API_KEY=... QODER_SMOKE_STREAM=1 node scripts/smoke.mjs  # 真实流式
```

`scripts/config-card-smoke.mjs` 驱动配置卡片背后的纯逻辑（三种窗口模式、超限拒绝、零值增量间隔、只写真正改动的字段、令牌写入），并用假服务验证「模型列表跟随令牌而非任何供应商条目」。

`scripts/client-card-smoke.mjs` 按 DSH 客户端模块系统的方式装载 `lib/client.js`（`window.__ModuleLoader__.load` + 注入的 `require`），把 `react`、`ctx.slots`、`ctx.configForms`、`ctx.remote.credentials`、`ctx.locale` 换成假服务，再渲染卡片并点击保存。它守住三件曾经坏掉的事：卡片能拿到插件的 Config 表单、令牌输入可写并真的写入凭据、被拒绝的 `RemoteResult` 会显示成错误而不是静默成功。

模型目录、真实流式和 DSH `headless` 端到端均已验证。`headless` profile 默认不挂载 settings/credentials，因此流式冒烟需要显式传 `QODER_API_KEY`/`QODER_ACCESS_TOKEN`；这是 DSH 启动环境变量，不涉及 pi 配置。
