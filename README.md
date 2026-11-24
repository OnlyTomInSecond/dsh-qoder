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

### 3. 提供凭据

本插件**不修改 DSH 源码**，也不需要给 DSH 打任何补丁；凭据有两种给法。

**方式 A：Config + 环境变量**

在 profile patch 里声明 provider profile，令牌由环境变量提供。这种方式不依赖 Models 页的编辑卡片，任何 DSH 版本都可用：

```yaml
- id: llm-qoder
  name: '@local/dsh-llm-qoder'
  config:
    providers:
      qoder:
        apiKeyEnv: QODER_API_KEY
```

```bash
QODER_API_KEY=pt-... dsh web   # 或该安装的启动命令
```

CN 区把 `qoder` / `QODER_API_KEY` 换成 `qoder-cn` / `QODER_CN_API_KEY`。

**方式 B：Models 页（取决于你的 DSH 版本）**

如果当前 DSH 的 Models 页能给「profile 只有 `apiKeyEnv` 一个字段」的未知供应商渲染输入卡片，就可以在 **Settings → Models → Add provider** 里选 `Qoder` / `Qoder CN` 并直接填令牌，令牌写入 DSH 凭据存储的 `QODER_API_KEY` / `QODER_CN_API_KEY` 引用。若该版本只会显示一行提示、无法输入 key，请改用方式 A —— 本插件不会为此改动 DSH。

### 4. 验证

- 重启或刷新后，**Settings → Models → Add provider** 应出现 `Qoder` / `Qoder CN`。
- 添加 token 后，模型选择器出现对应模型。
- 命令行检查 composed config：`dsh --profile web --dump-config | grep -A3 llm-qoder`
- `~/.dsh/qoder/` 出现目录缓存，说明后台实时目录刷新成功（首次使用可能先显示内置静态模型）。

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

**方式 A：Config + 环境变量（任何 DSH 版本都可用）**

在 profile patch 写入 provider profile，`apiKeyEnv` 指向环境变量名，令牌通过环境变量提供（见「从源码安装」第 3 节）。

**方式 B：Models 页（取决于你的 DSH 版本）**

如果当前版本的 Models 页能给未知供应商的 `{ apiKeyEnv }` profile 渲染输入卡片，可以直接在 **Settings → Models → Add provider** 里选 `Qoder` / `Qoder CN` 填写令牌并 Apply。令牌写入 DSH 凭据存储的 `QODER_API_KEY`（CN 为 `QODER_CN_API_KEY`）引用，不进入配置文件；保存后下一次请求立即生效，已添加的行可以 Edit 修改或用官方 Remove 删除（同时删除凭据引用）。该能力由 DSH 自身提供，本插件不修改 DSH 来换取它。

也支持：

1. 环境变量：`QODER_API_KEY` / `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT`（CN 用 `QODERCN_*`）
2. DSH 凭据记录 `llm-qoder/qoder`（PAT 换取的 job token 及刷新后的令牌会写回这里）

输入值以 `pt-` 开头时按 PAT 换取短时 job token；否则按 `jt-` 访问令牌直接使用。模型目录缓存同样只落在 `$DSH_HOME/qoder/`。

冷启动时优先复用未过期的 `llm-qoder/<provider>` grant；只有配置的 PAT 变了、或 grant 刷新失败时才重新兑换。兑换失败会把 Qoder 返回的错误体一并显示，便于区分 token 无效与网络/协议问题。

## 使用

Host 侧安装后立即生效。配置好凭据（见上一节的方式 A 或 B）后，模型选择器出现 `Qoder` / `Qoder CN` 的模型（以 Qoder 实时目录为准）。本插件只注册 Host 侧的 LLM 路由与模型元数据，不改动 DSH 的任何客户端代码。

想把 Qoder 设为默认模型，在 profile patch 中覆盖：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: qoder
    model: Qwen3.8-Flash
```

## 配置

```yaml
- id: llm-qoder
  name: '@local/dsh-llm-qoder'
  config:
    persistCredentials: true   # 刷新后的凭据写入 DSH 凭据记录
```

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

两者是**独立账号、独立额度、独立模型目录**，因此必须作为两条 provider 路由存在；这与 pi 插件的做法一致。区别只在区域配置和凭据，适配层与协议实现完全共用。两条路由始终注册，是否使用由是否配置了对应 profile 与凭据决定。

## 实现结构

| 文件 | 作用 |
|---|---|
| `src/index.ts` | DSH provider 路由、模型元数据、流式调用入口 |
| `src/qoder-credentials.ts` | DSH 凭据引用 / DSH 记录 / 环境变量的解析与刷新 |
| `src/pi-context.ts` | DSH 消息与工具 → pi transcript |
| `src/qoder/settings.ts` | Credit/流式选项：volatile Config schema + 每请求解析 |
| `src/stream-bridge.ts` | pi 事件 → DSH `StreamChunk` |
| `src/qoder/` | 自包含的 Qoder 协议实现（含 `pi-ai.ts` 本地类型/辅助函数，无外部运行时依赖） |

## 验证

```bash
node build.mjs
node scripts/smoke.mjs                              # 实时目录
QODER_API_KEY=... QODER_SMOKE_STREAM=1 node scripts/smoke.mjs  # 真实流式
```

模型目录、真实流式和 DSH `headless` 端到端均已验证。`headless` profile 默认不挂载 settings/credentials，因此流式冒烟需要显式传 `QODER_API_KEY`/`QODER_ACCESS_TOKEN`；这是 DSH 启动环境变量，不涉及 pi 配置。
