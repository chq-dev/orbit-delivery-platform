# Orbit 研发交付平台

面向 `sme-main` 无线路由、AC/AP 与交换设备管理项目的研发交付平台原型，覆盖「需求解析 → 开发设计报告 → 自动需求编码 → 集成验证报告 → 提交代码 → 编译构建 → 设备升级 → 自动化测试 → 测试报告归档」。

## 业务适配

- 代码仓库：`http://cloudgit.rj.link/sme/sme-main.git`，默认分支 `develop`。
- 被管理项目前端：`web/` 下的 Vue 3 + Ant Design 联邦组件与应用页面。
- 被管理项目后端：`lua/` 下的 LuCI `api → service → middle → utils` 四层模块，通过 RGOS CLI/JSON 与设备交互。
- 示例业务：VLAN/SVI/DHCP、WLAN 黑名单、AP 分组与漫游、PoE 供电诊断、端口镜像和 AC/AP/交换机固件升级。
- 测试场景：无线接入、跨 AP 漫游、VLAN 与端口转发、固件升级与回滚、配置保留和异常恢复。

## 本地运行

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动：

- 前端：`http://localhost:4173`
- 后端 API：`http://localhost:8787`
- SQLite 数据库：`./data/orbit.db`（首次启动自动建表；配置飞书访问凭证后启动即同步真实工作项）

可通过 `.env` 或环境变量覆盖配置，参考 `.env.example`：

```bash
PORT=8787
DB_PATH=./data/orbit.db
VAULT_KEY=replace-with-at-least-32-random-characters
PIPELINE_STEP_MS=1800
FEISHU_PROJECT_BASE_URL=https://project.feishu.cn
FEISHU_SYNC_INTERVAL_MS=300000
FEISHU_AUTO_SYNC=true
FEISHU_ACCESS_TOKEN=
FEISHU_INGEST_TOKEN=
FEISHU_USER_KEY=
FEISHU_PROJECT_KEY=rjcloud
FEISHU_REQUIREMENT_TYPE_KEY=story
FEISHU_DEFECT_TYPE_KEY=issue
```

`VAULT_KEY` 用于 AES-256-GCM 加密平台账号密码，生产环境必须显式配置且妥善保管；更换密钥后旧凭据将无法解密。

### 页面驱动的本机飞书同步（推荐）

平台服务器可以访问不到 `project.feishu.cn`，但用户当前电脑通常可以。此模式不暴露浏览器
Cookie；飞书同步任务由代理主动向平台领取，只有点击“一键本机执行”交付时，页面才会直接请求
当前客户端的回环代理：

```text
浏览器页面 http://8.145.45.84:8787
  └─ 同源 API /api/integrations/feishu/agent/status
       └─ 平台代理状态与命令队列
            └─ http://127.0.0.1:18787 本机同步代理（主动心跳）
                 ├─ 持有 meegle auth login 的飞书登录态
                 ├─ 拉取实时 story / issue
                 └─ 使用平台同步密钥写入 /api/integrations/feishu/ingest
```

在客户端项目目录启动代理并保持运行：

```bash
npm install -g @lark-project/meegle@1.0.27
meegle config set host project.feishu.cn
npm run feishu:agent
```

macOS 可安装为当前用户登录自启，代理退出后会自动重启：

```bash
./scripts/install-feishu-agent-macos.sh
tail -f /tmp/orbit-feishu-agent.out /tmp/orbit-feishu-agent.err
```

该脚本使用当前仓库路径、`npm` 和 Node.js 路径生成
`~/Library/LaunchAgents/com.orbit.feishu-agent.plist`。如果更换了仓库目录或 Node 版本，
重新执行脚本即可。

打开平台「需求与缺陷」或「账号中心」页面，「本机飞书实时同步」卡片会通过同源接口显示代理
是否在线、Meegle 是否已授权以及最近一次同步结果。代理每 10 秒上报一次心跳，超过 45 秒
未上报才会显示离线，因此不会再受 Chrome 本地网络权限或跨来源回环地址限制影响。

首次绑定平台同步密钥时，在服务器生成一次性密钥并写入客户端代理配置；之后页面中的
「开始飞书授权」「立即同步」「轮换密钥」都会进入平台命令队列，由在线代理领取执行：

1. `开始飞书授权`：页面显示设备授权链接和用户码；代理轮询授权结果，成功后自动执行首次全量同步。
2. 之后页面每 60 秒检查代理状态；页面初始化或重新可见时，若距上次成功同步超过 10 分钟会自动下发全量同步任务。
3. 浏览器只接触平台状态和任务 ID，不接触飞书登录 Token 或平台同步密钥。

两个凭据的来源不同，均不需要从飞书网页 Cookie 中提取：

- **飞书登录态**：由 `meegle auth login --device-code` 保存在本机 Meegle CLI；页面只驱动授权流程。
- **平台同步密钥**：平台内部用于保护 ingest 和代理心跳接口。首次可由平台生成数据库密钥，
  并一次性写入客户端代理配置；若服务器设置了 `FEISHU_INGEST_TOKEN`，则以环境变量为准，
  页面不允许轮换，客户端代理需使用相同值启动。

本机代理默认监听 `127.0.0.1:18787`。飞书同步和密钥轮换通过平台命令队列执行；客户端本地
交付由页面直接调用 `POST /delivery/start`，代理只接受工作项、仓库和布尔选项，本地路径与分支
始终从平台仓库配置读取。代理主动访问平台以下接口：

```bash
FEISHU_AGENT_PORT=18787
FEISHU_AGENT_HEARTBEAT_INTERVAL_MS=10000
FEISHU_AGENT_LOGIN_POLL_INTERVAL_MS=3000
```

代理配置默认写入 `~/.config/orbit/feishu-sync.json`（权限 `0600`），不会写入浏览器
`localStorage` 或源码。页面提供“轮换密钥”操作，旧密钥在轮换后立即失效。首次生成密钥采用
先到先得（TOFU）模型，因为当前平台没有用户登录体系；生产环境建议由管理员在服务器设置
`FEISHU_INGEST_TOKEN`，或仅在受信网络内开放首次绑定。

### 命令行/常驻同步（备选）

如果平台服务器不能直接访问 `project.feishu.cn`，不要在前端直连飞书，也不要把抓包 Token 放到浏览器。请在**能访问飞书的机器**上运行外部同步器：

```bash
# 1. 安装并登录官方 Meegle CLI（首次授权一次，后续无需手工绑定）
npm install -g @lark-project/meegle@1.0.27
meegle config set host project.feishu.cn
meegle auth login --device-code

# 2. 配置平台地址和同步凭证
export FEISHU_PROJECT_KEY=rjcloud
export PLATFORM_BASE_URL=http://8.145.45.84:8787
export PLATFORM_SYNC_TOKEN='与服务器 FEISHU_INGEST_TOKEN 相同的值'

# 3. 拉取真实需求/缺陷并写入平台；watch 模式可常驻轮询
npm run sync:feishu
npm run sync:feishu:watch
```

同步器使用官方 `meegle workitem query` 按 `story` 和 `issue` 拉取数据，默认全量查询并按外部工作项 ID 幂等更新。每次完整同步都会对账飞书当前活动工作项：新增项写入、变化项更新、飞书已删除项在本平台软归档（保留历史交付记录），无需先发起交付。需要临时缩短同步范围时可显式设置 `FEISHU_SYNC_FULL=false`，此时不会执行删除对账。服务器侧的 `FEISHU_INGEST_TOKEN` 用于保护写入接口；未配置时仅允许本机回环调用。

服务器 `.env` 最少需要：

```bash
DB_PATH=./data/orbit.db
VAULT_KEY=<至少 32 位随机字符串>
FEISHU_AUTO_SYNC=false
FEISHU_INGEST_TOKEN=<自行生成的强随机字符串>
```

同步机上的 `PLATFORM_SYNC_TOKEN` 必须与服务器 `FEISHU_INGEST_TOKEN` 完全一致，可用
`openssl rand -hex 32` 生成。`FEISHU_INGEST_TOKEN` 不是从飞书获取的，而是平台内部
用于保护写入接口的共享密钥；飞书侧的凭证是 `meegle auth login` 保存的登录态，
或管理员提供的一次性 `MEEGLE_USER_ACCESS_TOKEN`。

可用健康接口确认配置是否真正生效：

```bash
curl -sS http://8.145.45.84:8787/api/health
```

外部同步成功后应看到 `feishu.ingestTokenConfigured=true`、`feishu.mode="cli"`、
`feishu.connected=true` 和大于 0 的 `feishu.workItemCount`。只有配置了上述凭证，
后续 watch 轮询才能做到无需人工操作；飞书不允许匿名读取，因此无法通过纯前端代码
或写死源码彻底消除首次授权。

### 只读快照降级（非实时）

浏览器不能直接读取 `project.feishu.cn/goapi`：未登录会跳转登录页，已登录时接口也没有
允许平台域名读取的 CORS 响应头。因此不要把 Chrome Cookie、抓包 Token 或 Plugin
Secret 放进前端。列表采用“授权同步机生成快照、浏览器只读轮询”的方式：

1. 能访问飞书的机器执行一次 `meegle auth login --device-code`。
2. 按需设置 `FEISHU_SNAPSHOT_PATH`，默认写入 `data/feishu-work-items.json`。
3. 运行 `npm run sync:feishu:snapshot:watch`，同步器会原子写入
   `data/feishu-work-items.json`，格式包含 `syncedAt` 和去重后的真实工作项。
4. Vite 开发服务器会把该文件映射为 `/feishu-work-items.json`，生产构建会将其输出到
   `dist/feishu-work-items.json`；前端默认每 60 秒读取并合并到“需求与缺陷”列表。

跨服务器部署时，把 `FEISHU_SNAPSHOT_PATH` 指向 Web 静态目录，或把生成的 JSON 同步到
该目录。也可以通过 `VITE_FEISHU_SNAPSHOT_URL` 指向任意允许 CORS 的只读快照地址。
前端仅消费 `externalId`、标题、描述、优先级、负责人、飞书状态、项目线和更新时间，
不会接触飞书凭证。项目线默认读取需求字段 `field_c7834f` 和缺陷字段 `field_e1d325`，
可通过 `FEISHU_REQUIREMENT_PROJECT_FIELD`、`FEISHU_DEFECT_PROJECT_FIELD` 覆盖。工作项列表
支持按项目线、飞书状态和负责人筛选；负责人和项目线均为飞书多选字段时按“包含所选值”匹配。

前端快照中的新增工作项标记为“仅展示”，发起交付前仍需由后端同步或导入为平台工作项。
7 天内生成的快照会覆盖同一条后端飞书记录的标题、状态、负责人和项目线，同时保留平台侧
交付状态与仓库关联；超过 7 天的旧快照仍回退到服务端数据，避免旧快照复活已删除项。

如果当前数据库已经包含真实飞书工作项，可先用 `npm run snapshot:from-db` 生成一次
`data/feishu-work-items.json`，再启动页面即可由前端直接读取；后续用 Meegle watch
覆盖同一文件即可持续更新。快照文件和数据库都在 `.gitignore` 中，不会提交真实项目数据。

首次部署时可选择后端直连飞书，或在另一台能访问飞书的机器上运行外部同步器。两者都会把真实需求和缺陷写入「需求与缺陷」列表；外部同步模式由同步器按 `FEISHU_SYNC_INTERVAL_MS` 轮询。数据库路径仍建议挂载持久卷，避免重新部署后丢失本地状态：

1. 在「平台账号」绑定 Git 账号。
2. 在「代码仓库」接入 Git 仓库并关联账号，填写当前客户端实际检出的绝对路径（例如 `/Users/chenhuaqu/sme/sme-main`）。保存配置不会在服务器校验客户端目录；跨服务器部署时由页面请求本机代理执行。服务端已停用自动推进和模拟交付，不能再把未执行的阶段标记为成功。
3. 在「需求与缺陷」创建或导入工作项，随后发起交付。

生产构建并启动全栈服务：

```bash
npm run build
npm run start:server
```

后端测试与类型检查：

```bash
npm run test:server
npm run typecheck:server
```

## 已实现能力

- **代码仓库**：录入 Git 地址、默认分支、本地代码路径、语言与认证账号，支持分支和本地路径修改、仓库健康状态和最近交付查看。
- **平台账号**：统一管理 Git、飞书、编译系统、设备端账号；支持手动绑定与 CSV/TXT 批量导入。
- **飞书项目接入**：支持后端直连、官方 Meegle CLI 跨服务器外部同步和页面绑定；同步结果直接更新需求与缺陷列表，支持定时刷新、事件回调和缺陷关闭状态回写。
- **需求与缺陷**：创建工作项、关联仓库和分支、查看详情；缺陷测试通过后自动关闭。
- **一键交付**：自动生成开发设计报告与集成报告，在配置的本地路径创建真实 Git 提交，测试验收通过后推送目标分支，并完成编译、设备升级和报告归档。
- **实时流水线**：九阶段状态机、执行进度、阶段日志、运行信息、设计/集成/测试报告查看入口和测试结果摘要。
- **测试报告**：用例通过率、套件明细、失败用例分析和 Markdown 报告导出。
- **后端业务层**：Express + SQLite 持久化仓库、加密账号池、工作项、飞书导入队列、交付流水线和测试报告。
- **交付状态机**：服务端事务推进九个阶段，自动生成设计/集成/测试报告，更新工作项状态、缺陷自动关闭和仓库最新版本。
- **数据约束**：外键、唯一约束、输入校验、幂等去重、单工作项并发交付拦截与失败回滚。

## 后端架构

```text
server/
  app.ts                    Express 应用、静态资源与统一错误处理
  index.ts                  API 启动、SQLite 初始化、流水线调度器
  routes.ts                 REST 路由
  db/                       schema、迁移版本与业务序列号
  domain/                   领域类型、错误、校验与时间格式化
  security/vault.ts         AES-256-GCM 凭据保险箱
  services/                 账号、仓库、工作项、流水线、报告业务逻辑
  tests/                    业务与持久化测试
```

主要 API：

- `GET /api/bootstrap`：一次返回页面所需的仓库、账号、工作项、流水线、报告和飞书收件箱。
- `POST /api/repositories`、`PATCH /api/repositories/:id`（修改默认分支和本地路径）、`POST /api/accounts`、`POST /api/accounts/import`。
- `POST /api/work-items`、`POST /api/work-items/import`。
- `GET /api/integrations/feishu/status`、`POST /api/integrations/feishu/connect`。
- `POST /api/integrations/feishu/test`、`POST /api/integrations/feishu/sync`。
- `POST /api/integrations/feishu/ingest`：供 Meegle CLI 外部同步器写入工作项，使用 `FEISHU_INGEST_TOKEN` 鉴权。
- `GET /api/integrations/feishu/agent/status`：返回代理在线状态、脱敏健康状态和最近命令，不返回任何密钥。
- `POST /api/integrations/feishu/agent/heartbeat`：代理携带同步密钥上报心跳并领取待执行命令。
- `POST /api/integrations/feishu/agent/commands`：页面下发登录、同步或密钥轮换命令；相同类型的未完成命令会去重。
- `POST /api/integrations/feishu/agent/commands/:id/result`：代理携带同步密钥上报命令结果。
- `GET /api/integrations/feishu/sync-token`：返回平台同步密钥状态和尾号，不返回明文。
- `POST /api/integrations/feishu/sync-token/bootstrap`：首次生成平台同步密钥，明文仅返回一次。
- `POST /api/integrations/feishu/sync-token/rotate`：携带当前 Bearer 密钥轮换，旧密钥立即失效。
- `POST /api/integrations/feishu/events`、`POST /api/integrations/feishu/disconnect`。
- `POST /api/pipelines`、`GET /api/pipelines/:id`、`POST /api/pipelines/:id/cancel`。
- `GET /api/reports`、`GET /api/reports/:id`、`GET /api/reports/:id/markdown`。
- `GET /api/health`：数据库连通性检查。

## 飞书项目绑定接入

飞书项目页面需要登录，服务端不能匿名抓取 HTML。平台支持两条实时同步路径：

- **跨服务器外部同步（推荐）**：在能访问飞书的机器上运行官方 `meegle` CLI。页面通过平台状态/命令接口控制本机代理，代理主动心跳并从 `/api/integrations/feishu/ingest` 写入平台。后端无需访问飞书，也不需要配置飞书 Token。
- **后端直连**：平台服务器本身能访问 `project.feishu.cn` 时，在部署环境注入访问 Token，启动时自动同步。

后端直连配置示例：

```bash
FEISHU_AUTO_SYNC=true
FEISHU_ACCESS_TOKEN=抓包得到的X-Plugin-Token
FEISHU_USER_KEY=可选的X-User-Key
FEISHU_PROJECT_KEY=rjcloud
FEISHU_REQUIREMENT_TYPE_KEY=story
FEISHU_DEFECT_TYPE_KEY=issue
FEISHU_DEFAULT_REPO_ID=repo-1
```

服务启动时会自动完成绑定校验并同步；同步到的工作项按 `source + external_id` 幂等更新，不会重复插入。若未注入凭证且页面也未绑定，服务端会输出明确的配置提示，列表在运行外部同步器后自动填充。

如需在页面绑定，当前默认使用“抓包 Token”模式，不需要创建开放平台插件：

1. 登录飞书项目，打开浏览器开发者工具 → Network。
2. 筛选 `/open_api/` 请求，选择任意成功请求，复制请求头中的 `X-Plugin-Token`；如果该请求还带有 `X-User-Key`，一并复制。
3. 在「账号中心 → 飞书项目绑定」粘贴访问 Token，填写项目标识、需求类型 Key、缺陷类型 Key 和默认仓库。项目标识可填空间 URL 中的 `simple_name`，也可双击空间名称复制 `project_key`；标准需求和缺陷类型通常为 `story`、`issue`，自定义类型可通过 `GET /open_api/:project_key/work_item/all-types` 查询。
4. 保存时会直接使用该 Token 调用 `GET /open_api/projects/detail` 和两个工作项类型的 `meta` 接口校验权限，不再调用 Plugin Token 交换接口。
5. 绑定成功后点击“同步工作项”，需求/缺陷会写入本地收件箱并直接更新「需求与缺陷」列表。
6. 如需自动关闭飞书缺陷，请配置关闭流转 ID；可调用 `POST /open_api/:project_key/work_item/:work_item_type_key/:work_item_id/workflow/query`，从返回的 `connections.transition_id` 中获取目标关闭状态的流转 ID。
7. 如需事件推送，在插件构成 → 监听事件中配置回调地址 `/api/integrations/feishu/events` 和回调 Token；生产环境必须是公网 HTTPS。

抓包 Token 会过期，通常有效期约 2 小时；长期部署建议改用 `FEISHU_PLUGIN_ID`、`FEISHU_PLUGIN_SECRET`、`FEISHU_USER_KEY` 或页面中的 Plugin 凭据，服务会自动换取并缓存访问 Token。浏览器 Cookie、`goapi` 的 `x-meego-csrf-token` 不能代替 `X-Plugin-Token`；如果 Network 中不存在 `/open_api/` 请求，则当前页面没有可复用的开放接口 Token。Token、Plugin Secret（兼容旧绑定）和回调 Token 均通过 `CredentialVault` 使用 AES-256-GCM 加密保存。

相关官方文档：创建插件 `/b/helpcenter/1p8d7djs/49k1ojm9`、获取访问凭证 `/b/helpcenter/1p8d7djs/4id4bvnf`、搜索租户用户 `/b/helpcenter/1p8d7djs/4cxu45fl`、获取工作项类型 `/b/helpcenter/1p8d7djs/3pjp854w`、获取工作流详情 `/b/helpcenter/1p8d7djs/5hcmcl04`、状态流转 `/b/helpcenter/1p8d7djs/4xve8n8c`、监听事件 `/b/helpcenter/1p8d7djs/lvojfwht`。

## 本地操作与 Codex Skill

- 飞书需求/缺陷通过官方 Meegle CLI 外部同步、部署环境凭证或平台内弹窗同步，不会打开外部项目页面。
- Git 仓库地址只提供本地复制，不跳转代码托管页面。
- 工作项详情可生成 `$rjcloud-local-delivery` 指令并复制到 Codex，由 Codex 在工作区内完成编码、构建、升级与测试。
- Skill 指令要求先产出开发设计报告，再编码并执行集成验证、生成集成报告，之后才创建本地提交；平台只在测试验收通过后推送配置分支，生产设备升级等其他外部写入仍需确认。

已安装的 skill 位于 `~/.codex/skills/rjcloud-local-delivery`，后续可直接使用：

```text
Use $rjcloud-local-delivery to deliver REQ-1082 locally.
```

### 客户端本地执行

远端平台无法访问开发机上的 `/Users/...` 路径。需要在客户端检出中执行代码时，先在客户端运行
并保持 `npm run feishu:agent`。页面“启动一键交付”选择“客户端本地”后点击“一键本机执行”，
浏览器会请求本机代理，代理从平台仓库配置读取路径和分支并直接执行 `deliver:local`：

```text
浏览器页面 -> POST http://127.0.0.1:18787/delivery/start
           -> 本机代理读取平台 /api/bootstrap
           -> npm run deliver:local -- --path <仓库配置> --branch <仓库配置> --run ...
           -> 页面轮询 /delivery/status/:id
```

执行弹窗会实时显示“读取平台 → 校验契约 → 校验仓库 → Codex 执行 → 检查证据 → 提交推送 → 回写平台”的步骤状态。平台健康检查遇到瞬时网络错误会自动重试；失败时停留在具体步骤并显示连接超时、路径、分支、Codex 或回写错误。旧服务端缺少 `deliveryContractVersion` 时会在启动 Codex 前明确拒绝。

点击“一键本机执行”后页面会立即显示上述七步，不需要等待本机代理返回；失败后自动滚动到进度面板并高亮失败步骤。若点击后仍完全没有进度面板，说明浏览器加载的仍是旧版前端构建，请确认 `/api/health` 返回 `deliveryContractVersion: 1`，并在部署新构建后强制刷新页面。

需要手工排障时仍可执行同一脚本：

```bash
npm run deliver:local -- \
  --api http://8.145.45.84:8787 \
  --work-item REQ-1137 \
  --repo repo-1 \
  --path /Users/chenhuaqu/sme/sme-main \
  --branch dev-harvey \
  --run \
  --push
```

脚本会在客户端校验绝对路径、Git 根目录、分支和 origin，生成
`delivery-artifacts/<work-item>/codex-prompt.md`，然后在该目录运行 `codex exec`。
只有显式增加 `--push` 才会推送；非交互式推送还需要 `--yes`。项目内 skill 位于
`skills/orbit-local-delivery/SKILL.md`。执行成功后脚本会把真实 commit、路径和分支回写
`POST /api/pipelines/local`，平台会按现有规则更新工作项状态并处理缺陷关闭回写。

该 skill 强制使用本地命令/API、工作区文件或本地导入队列，并要求在 `web/` 或 `lua/` 下遵守最近的 `AGENTS.md`；平台只在测试验收通过后推送配置分支，生产设备升级等其他外部写入会先请求确认。

### 组织级 coding-skills

已从 `http://cloudgit.rj.link/agentic-coding/coding-skills.git`（`main`）接入 9 个 Skill，安装到 `~/.codex/skills`：

- 流程编排：`sdd`
- 需求到交付：`grill-with-req`、`spec-design`、`task-breakdown`、`task-implement`、`verification-evidence`、`code-review`
- 架构知识：`design-to-l1`、`design-to-l2`

工作项详情生成的指令会同时引用 `$rjcloud-local-delivery` 的领域安全规则和 `$sdd` 的阶段技能链。新安装的 Skill 从下一轮 Codex 对话开始进入可发现列表。

技能源保留在 `~/.coding-skills/source`，后续更新命令：

```bash
node ~/.coding-skills/source/bin/skill.cjs update \
  --dir ~/.codex/skills \
  --source http://cloudgit.rj.link/agentic-coding/coding-skills.git \
  --ref main
```

## 说明

当前业务数据由 SQLite 持久化，前端通过 `/api` 读取和写入。交付阶段只由客户端 runner 或真实外部适配器回写；服务端不再按计时器自动推进，也不再提供模拟交付入口。构建、设备升级和测试只有在对应证据文件存在时才会成为成功状态。账号密码使用 AES-256-GCM 加密存储，接口只返回掩码提示，不返回明文或密文。

当前 Git 链路会读取仓库配置的客户端路径。跨服务器部署时，页面一键请求本机代理，由代理在代码所在客户端执行路径/分支校验、Codex、提交和可选推送，再把真实 commit 回写平台。没有客户端代码变更、提交或证据文件的运行不会被记为成功；旧版 `triggered_by=系统` 的流水线在页面上会标注“无客户端执行证据”。编译系统和设备升级服务仍为本地交付平台适配层。飞书项目支持官方 Meegle CLI 外部同步、抓包 Token 直连和旧插件凭据兼容，包含真实 Token 校验、工作项同步、事件回调和缺陷关闭回写。后续可在 `server/services/` 中继续替换其余外部系统适配器，数据库与 API 契约可保持不变。

本机已有的 `sme-main` 检出位于 `~/sme/sme-main`。客户端路径按仓库配置保存，平台中的 skill 指令会使用该路径执行本地设计、编码、集成验证、构建与测试。

当前默认接入的项目地址：

- Git 仓库：`http://cloudgit.rj.link/sme/sme-main.git`
- 飞书需求平台：`https://project.feishu.cn/rjcloud/story/homepage`
- 飞书缺陷平台：`https://project.feishu.cn/rjcloud/issue/homepage`

后续接入真实系统时，分别对接 Git 服务、飞书开放平台、`sm-web`/RGOS 编译系统、AC/AP 与交换机升级服务和自动化测试平台；前端状态层已经通过 `src/api.ts` 与后端解耦。
