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
- SQLite 数据库：`./data/orbit.db`（首次启动自动建表，业务数据为空）

可通过 `.env` 或环境变量覆盖配置，参考 `.env.example`：

```bash
PORT=8787
DB_PATH=./data/orbit.db
VAULT_KEY=replace-with-at-least-32-random-characters
PIPELINE_STEP_MS=1800
FEISHU_PROJECT_BASE_URL=https://project.feishu.cn
FEISHU_SYNC_INTERVAL_MS=300000
```

`VAULT_KEY` 用于 AES-256-GCM 加密平台账号密码，生产环境必须显式配置且妥善保管；更换密钥后旧凭据将无法解密。

首次启动后数据库为空，按以下顺序录入真实业务数据：

1. 在「平台账号」绑定 Git 账号。
2. 在「代码仓库」接入 Git 仓库并关联账号，填写本机实际检出的绝对路径（例如 `/Users/chenhuaqu/sme/sme-main`）。
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
- **飞书项目接入**：可直接使用浏览器中抓取到的 `X-Plugin-Token` 绑定，无需创建开放平台插件账号；同步需求/缺陷，支持事件回调和缺陷关闭状态回写。
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
- `POST /api/integrations/feishu/events`、`POST /api/integrations/feishu/disconnect`。
- `POST /api/pipelines`、`GET /api/pipelines/:id`、`POST /api/pipelines/:id/cancel`。
- `GET /api/reports`、`GET /api/reports/:id`、`GET /api/reports/:id/markdown`。
- `GET /api/health`：数据库连通性检查。

## 飞书项目绑定接入

当前默认使用“抓包 Token”模式，不需要创建开放平台插件，也不需要手动绑定飞书账号：

1. 登录飞书项目，打开浏览器开发者工具 → Network。
2. 筛选 `/open_api/` 请求，选择任意成功请求，复制请求头中的 `X-Plugin-Token`；如果该请求还带有 `X-User-Key`，一并复制。
3. 在「账号中心 → 飞书项目绑定」粘贴访问 Token，填写项目标识、需求类型 Key、缺陷类型 Key 和默认仓库。项目标识可填空间 URL 中的 `simple_name`，也可双击空间名称复制 `project_key`；标准需求和缺陷类型通常为 `story`、`issue`，自定义类型可通过 `GET /open_api/:project_key/work_item/all-types` 查询。
4. 保存时会直接使用该 Token 调用 `GET /open_api/projects/detail` 和两个工作项类型的 `meta` 接口校验权限，不再调用 Plugin Token 交换接口。
5. 绑定成功后点击“同步工作项”，需求/缺陷会写入本地收件箱，再从「需求与缺陷」页面导入。
6. 如需自动关闭飞书缺陷，请配置关闭流转 ID；可调用 `POST /open_api/:project_key/work_item/:work_item_type_key/:work_item_id/workflow/query`，从返回的 `connections.transition_id` 中获取目标关闭状态的流转 ID。
7. 如需事件推送，在插件构成 → 监听事件中配置回调地址 `/api/integrations/feishu/events` 和回调 Token；生产环境必须是公网 HTTPS。

抓包 Token 会过期，通常有效期约 2 小时，过期后重新抓取并更新绑定即可。浏览器 Cookie、`goapi` 的 `x-meego-csrf-token` 不能代替 `X-Plugin-Token`；如果 Network 中不存在 `/open_api/` 请求，则当前页面没有可复用的开放接口 Token。Token、Plugin Secret（兼容旧绑定）和回调 Token 均通过 `CredentialVault` 使用 AES-256-GCM 加密保存。

相关官方文档：创建插件 `/b/helpcenter/1p8d7djs/49k1ojm9`、获取访问凭证 `/b/helpcenter/1p8d7djs/4id4bvnf`、搜索租户用户 `/b/helpcenter/1p8d7djs/4cxu45fl`、获取工作项类型 `/b/helpcenter/1p8d7djs/3pjp854w`、获取工作流详情 `/b/helpcenter/1p8d7djs/5hcmcl04`、状态流转 `/b/helpcenter/1p8d7djs/4xve8n8c`、监听事件 `/b/helpcenter/1p8d7djs/lvojfwht`。

## 本地操作与 Codex Skill

- 飞书需求/缺陷通过平台内弹窗同步并导入，不会打开外部项目页面。
- Git 仓库地址只提供本地复制，不跳转代码托管页面。
- 工作项详情可生成 `$rjcloud-local-delivery` 指令并复制到 Codex，由 Codex 在工作区内完成编码、构建、升级与测试。
- Skill 指令要求先产出开发设计报告，再编码并执行集成验证、生成集成报告，之后才创建本地提交；平台只在测试验收通过后推送配置分支，生产设备升级等其他外部写入仍需确认。

已安装的 skill 位于 `~/.codex/skills/rjcloud-local-delivery`，后续可直接使用：

```text
Use $rjcloud-local-delivery to deliver REQ-1082 locally.
```

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

当前业务数据由 SQLite 持久化，前端通过 `/api` 读取和写入；流水线由服务端调度器按阶段推进，前端轮询展示进度。账号密码使用 AES-256-GCM 加密存储，接口只返回掩码提示，不返回明文或密文。

当前 Git 链路会读取仓库配置的本地路径，在提交阶段创建真实提交，并在自动化测试验收通过后推送到配置分支；未配置本地路径时保留模拟执行模式。编译系统和设备升级服务仍为本地交付平台适配层。飞书项目支持抓包 Token 直连和旧插件凭据兼容，包含真实 Token 校验、工作项同步、事件回调和缺陷关闭回写。后续可在 `server/services/` 中继续替换其余外部系统适配器，数据库与 API 契约可保持不变。

本机已有的 `sme-main` 检出位于 `~/sme/sme-main`。本地路径按仓库配置保存，平台中的 skill 指令会使用该路径执行本地设计、编码、集成验证、构建与测试。

当前默认接入的项目地址：

- Git 仓库：`http://cloudgit.rj.link/sme/sme-main.git`
- 飞书需求平台：`https://project.feishu.cn/rjcloud/story/homepage`
- 飞书缺陷平台：`https://project.feishu.cn/rjcloud/issue/homepage`

后续接入真实系统时，分别对接 Git 服务、飞书开放平台、`sm-web`/RGOS 编译系统、AC/AP 与交换机升级服务和自动化测试平台；前端状态层已经通过 `src/api.ts` 与后端解耦。
