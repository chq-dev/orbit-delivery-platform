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
```

`VAULT_KEY` 用于 AES-256-GCM 加密平台账号密码，生产环境必须显式配置且妥善保管；更换密钥后旧凭据将无法解密。

首次启动后数据库为空，按以下顺序录入真实业务数据：

1. 在「平台账号」绑定 Git 账号。
2. 在「代码仓库」接入 Git 仓库并关联账号。
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

- **代码仓库**：录入 Git 地址、默认分支、语言与认证账号，支持仓库健康状态和最近交付查看。
- **平台账号**：统一管理 Git、飞书、编译系统、设备端账号；支持手动绑定与 CSV/TXT 批量导入。
- **需求与缺陷**：创建工作项、关联仓库和分支、查看详情；缺陷测试通过后自动关闭。
- **一键交付**：自动生成开发设计报告与集成报告，完成后提交代码、触发固件编译、生成版本、升级 AC/AP 或交换机、自动化测试与报告归档。
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
- `POST /api/repositories`、`POST /api/accounts`、`POST /api/accounts/import`。
- `POST /api/work-items`、`POST /api/work-items/import`。
- `POST /api/pipelines`、`GET /api/pipelines/:id`、`POST /api/pipelines/:id/cancel`。
- `GET /api/reports`、`GET /api/reports/:id`、`GET /api/reports/:id/markdown`。
- `GET /api/health`：数据库连通性检查。

## 本地操作与 Codex Skill

- 飞书需求/缺陷通过平台内弹窗同步并导入，不会打开外部项目页面。
- Git 仓库地址只提供本地复制，不跳转代码托管页面。
- 工作项详情可生成 `$rjcloud-local-delivery` 指令并复制到 Codex，由 Codex 在工作区内完成编码、构建、升级与测试。
- Skill 指令要求先产出开发设计报告，再编码并执行集成验证、生成集成报告，之后才创建本地提交；远程推送、生产设备升级等外部写入仍需确认。

已安装的 skill 位于 `~/.codex/skills/rjcloud-local-delivery`，后续可直接使用：

```text
Use $rjcloud-local-delivery to deliver REQ-1082 locally.
```

该 skill 强制使用本地命令/API、工作区文件或本地导入队列，并要求在 `web/` 或 `lua/` 下遵守最近的 `AGENTS.md`；远程推送和生产设备升级会先请求确认。

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

当前阶段仍为本地交付平台原型，尚未接入真实 Git、飞书、编译系统和设备升级服务；后续可在 `server/services/` 中替换为真实外部系统适配器，数据库与 API 契约可保持不变。

本机已有的 `sme-main` 检出位于 `~/sme/sme-main`，平台中的 skill 指令会要求在该工作区执行本地设计、编码、集成验证、构建与测试。

当前默认接入的项目地址：

- Git 仓库：`http://cloudgit.rj.link/sme/sme-main.git`
- 飞书需求平台：`https://project.feishu.cn/rjcloud/story/homepage`
- 飞书缺陷平台：`https://project.feishu.cn/rjcloud/issue/homepage`

后续接入真实系统时，分别对接 Git 服务、飞书开放平台、`sm-web`/RGOS 编译系统、AC/AP 与交换机升级服务和自动化测试平台；前端状态层已经通过 `src/api.ts` 与后端解耦。
