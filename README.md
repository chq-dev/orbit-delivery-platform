# Orbit 研发交付平台

面向 `sme-main` 无线路由、AC/AP 与交换设备管理项目的研发交付平台原型，覆盖「需求解析 → 开发设计报告 → 自动需求编码 → 集成验证报告 → 提交代码 → 编译构建 → 设备升级 → 自动化测试 → 测试报告归档」。

## 业务适配

- 代码仓库：`http://cloudgit.rj.link/sme/sme-main.git`，默认分支 `develop`。
- 前端：`web/` 下的 Vue 3 + Ant Design 联邦组件与应用页面。
- 后端：`lua/` 下的 LuCI `api → service → middle → utils` 四层模块，通过 RGOS CLI/JSON 与设备交互。
- 示例业务：VLAN/SVI/DHCP、WLAN 黑名单、AP 分组与漫游、PoE 供电诊断、端口镜像和 AC/AP/交换机固件升级。
- 测试场景：无线接入、跨 AP 漫游、VLAN 与端口转发、固件升级与回滚、配置保留和异常恢复。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

## 已实现能力

- **代码仓库**：录入 Git 地址、默认分支、语言与认证账号，支持仓库健康状态和最近交付查看。
- **平台账号**：统一管理 Git、飞书、编译系统、设备端账号；支持手动绑定与 CSV/TXT 批量导入。
- **需求与缺陷**：创建工作项、关联仓库和分支、查看详情；缺陷测试通过后自动关闭。
- **一键交付**：自动生成开发设计报告与集成报告，完成后提交代码、触发固件编译、生成版本、升级 AC/AP 或交换机、自动化测试与报告归档。
- **实时流水线**：九阶段状态机、执行进度、阶段日志、运行信息、设计/集成/测试报告查看入口和测试结果摘要。
- **测试报告**：用例通过率、套件明细、失败用例分析和 Markdown 报告导出。

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

当前为纯前端原型：业务数据保存在浏览器 `localStorage`，流水线使用前端定时器模拟执行进度。账号密码不会以明文展示，生产接入时应由后端凭据保险箱负责加密存储和运行时注入。

本机已有的 `sme-main` 检出位于 `~/sme/sme-main`，平台中的 skill 指令会要求在该工作区执行本地设计、编码、集成验证、构建与测试。

当前默认接入的项目地址：

- Git 仓库：`http://cloudgit.rj.link/sme/sme-main.git`
- 飞书需求平台：`https://project.feishu.cn/rjcloud/story/homepage`
- 飞书缺陷平台：`https://project.feishu.cn/rjcloud/issue/homepage`

后续接入真实系统时，可在 `src/store.tsx` 中将本地状态操作替换为 API 调用，分别对接 Git 服务、飞书开放平台、`sm-web`/RGOS 编译系统、AC/AP 与交换机升级服务和自动化测试平台。
