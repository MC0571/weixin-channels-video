# Agent 安装与本地运行边界

本文记录截至 **2026-10-10** 查阅的官方资料。每个 Agent 的产品、运行环境和权限不同；安装前识别当前 Agent 实际运行的位置、系统、Shell、架构，以及它能否访问目标 Chrome。图标、账号名称和来源提示词中的扩展 ID 都不能证明这些事实。

在运行任何 `node`、`npm`、`npx` 或 Skill `prepare` 命令前，先完成本节的平台检查与 Skill 安装方式选择。若 Skill 尚未安装，可先从 [GitHub 上的本文](https://github.com/MC0571/weixin-channels-video/blob/main/skills/weixin-channels-video/references/agent-installation.md)读取规则；该 Skill 的最低 Node 版本以 `scripts/runtime-support.mjs` 为准。

## 六个 Agent 的官方入口

| Agent | 官方文档所述的 Skill 形式和安装入口 | 本地执行范围与未确认项 |
| --- | --- | --- |
| Codex | Skill 是含 `SKILL.md` 的目录，可带 `scripts/`、`references/`、`assets/`。用户级目录为 `$HOME/.agents/skills/`；项目级目录为 `.agents/skills/`。Codex 自动检测变更，未显示时重启。[Skills](https://learn.chatgpt.com/docs/build-skills) | Windows 桌面版和 CLI 可使用原生 PowerShell 环境，也可选择 WSL2；WSL2 中 Codex 实际运行在 Linux，WSL1 已不再支持。核实本会话用的是本机 Codex、WSL 还是远端环境；远端/云端工作区不因此获得本机 Chrome 访问权。[Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox) · [WSL](https://learn.chatgpt.com/docs/windows/wsl) |
| Claude Code | 个人目录 `~/.claude/skills/<name>/SKILL.md`，项目目录 `.claude/skills/<name>/SKILL.md`；Skill 可包含辅助文件。已存在的目录会监听文件变化；若本次才创建顶层 `.claude/skills/`，运行 `/reload-skills`。个人目录不用于 Cowork 或云端会话；那些会话使用账号启用的 Skill。[Skills](https://code.claude.com/docs/en/skills) | 官方当前列出的本机系统为 macOS 13+、Windows 10 1809+/Server 2019+、Ubuntu 20.04+、Debian 10+、Alpine 3.19+，x64/ARM64；Windows 可原生运行或在 WSL1/2 内运行。原生 Windows 默认用 PowerShell；Git for Windows 是 Bash 工具的可选依赖。WSL 中的 Agent 使用 Linux Node，不能据此注册 Windows Chrome host。[设置与平台](https://code.claude.com/docs/en/setup) |
| WorkBuddy | 本地“技能市场”可上传技能包，导入后自动配置，可启用或关闭。官方说明 Skill 可包含脚本/工作流，并在授权下读写文件或执行系统命令。[技能市场](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) | 官方桌面安装要求为 macOS 12+，Windows 10+ x64；Windows ARM64 以当前版本说明为准。运行具体命令由当前权限模式决定，可能要求确认。文档没有定义用户导入包的固定扩展名、ZIP 根目录约定或安装路径；先查看当前应用的导入界面，不套用 CodeBuddy 或 Vercel CLI 的布局。[Mac 安装](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide) · [Windows 安装](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide) · [权限模式](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes) |
| 豆包工作 | 公开资料说明豆包开放平台可通过 Skill、Plugin 或 OpenAPI 接入豆包工作，目前处于内测/意向接入阶段。[Skill 接入](https://open.doubao.com/document/doubao-developer-guide/skill-integration-guide) | 这些资料没有给普通桌面用户定义本地 Skill 目录、导入包格式、Node/Shell 执行或访问本机 Chrome 的契约。不能据此宣称可完成本机配对；当前产品未明确给出本地文件与命令工具时，报告此限制并交接，不猜目录或变通权限。 |
| 千问办公（QwenWork） | 官方文档把 Skill 描述为带 `SKILL.md` 的目录，可有辅助文件；列出 `~/.qwenworkcn/skills/`、对话中从仓库安装和界面上传 `SKILL.md` 与辅助文件。上传后自动加载；对话中可自动触发或用 `/` 选择。[Skills](https://docs.qwenwork.cn/features/skills) | 桌面版文档列出 macOS 14+（Intel/Apple Silicon）和 Windows 10+ x64；桌面客户端可操作本地文件。公开资料没有定义 Skill 脚本中的 Node/Shell 执行权限或 Windows 下 `~` 的具体展开方式；使用当前应用的导入/授权结果核实，不能据“本地文件”推断任意命令可运行。[桌面端要求](https://docs.qwenwork.cn/getting-started/desktop-workflow) |
| TRAE | 先确认是 TRAE CN、TraeCode/国际版还是 TraeWork。TRAE CN 官方文档列出项目目录 `.trae/skills/`、macOS/Linux 全局目录 `~/.trae-cn/skills/`、Windows 全局目录 `%userprofile%/.trae-cn/skills/`；也可启用 `.agents/skills/`。界面支持上传 `SKILL.md` 或含它的 ZIP；单文件导入后，脚本等资源需按文档手动放入技能目录。[TRAE CN Skills](https://docs.trae.cn/ide_skills) | TRAE CN IDE 文档列出 macOS 12+（Apple Silicon/Intel）和 Windows 10/11 x64；不要用 CN 路径推断不同产品线配置。若使用 `.agents/skills/`，必须在 IDE 设置中显式启用；安装工具与目录不同，需按实际宿主验证。[系统要求](https://docs.trae.cn/ide_get-started-with-trae) |

Vercel `skills` CLI 的 Agent 清单包含 `codex`、`claude-code`、`trae`、`trae-cn` 等特定键，但不包含 WorkBuddy、豆包工作或 QwenWork。该清单只证明 CLI 支持相应文件安装目标，不证明宿主已启用 Skill、能执行本地脚本或能访问 Chrome。[CLI 文档](https://www.skills.sh/docs/cli) · [Agent 映射](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)

### 选用安装方式

1. **先确定执行地点。** 使用当前 Agent 提供的 Shell/终端只读信息确认 OS、架构、当前 Shell 和 `node` 的实际路径；确认 Chrome 也在该机器上。若 Agent 是云端、远端或隔离容器，只有在已确认工具能操作同一台 Chrome 主机时才继续本地桥接。
2. **已安装 Skill 时先核实。** 保留同名 Skill 的已有文件和本地修改。需要更新时按宿主官方更新方式处理，不用全量安装器覆盖其他 Skill。
3. **插件页提示词或新机器没有 Skill 时，先取得完整官方 Skill Release 包。** 使用 [GitHub Releases](https://github.com/MC0571/weixin-channels-video/releases) 的 Skill TAR.GZ/ZIP，不要求用户克隆源码仓库、运行构建或依赖 Chrome Web Store。释放出的目录必须完整保留 `SKILL.md`、`scripts/`、`references/` 和随包资源。
4. **只有确认是受支持的 Agent CLI 且 Node 已满足最低版本，才用 Vercel `skills` CLI。** 先检查用户级目标目录中没有同名 Skill 或本地修改；如果已存在，按宿主官方更新方式处理，不能用自动确认覆盖。没有同名目标时，用 `--global` 安装到用户级目录，显式指定单一宿主和 Skill。`npx --yes` 只跳过 npm 下载一次性 CLI 包的确认，`skills add --yes` 只跳过安装器确认：

   ```sh
   npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex
   ```

   将 `codex` 换成确认后的 `claude-code`、`trae` 或 `trae-cn`。始终指定单一 `--agent` 和 `--skill`；不省略目标、不用 `--all`，不把 CodeBuddy 映射给 WorkBuddy，也不把 Qwen Code 映射给 QwenWork。其他产品使用上表列出的官方导入/安装入口，并检查完整资源是否保留；若 UI 对文件格式或资源保留说明不足，先核对界面/文档，不能猜包结构。[CLI 参数](https://github.com/vercel-labs/skills#options) · [Agent 映射](https://github.com/vercel-labs/skills/blob/main/src/agents.ts)
5. **加载或启用 Skill。** 按对应产品的实际入口启用并确认新会话可识别 Skill。TRAE 的单文件导入不包含本项目的运行脚本；将完整解压目录放入受支持目录或补齐所有文件。WorkBuddy 上传包的精确格式、豆包工作本地导入契约以及 TRAE 国际版目录目前属于未知时，保留未知并交接最短人工步骤。

## Node、OS、浏览器与权限检查

本 Skill 的运行时最低版本为 Node.js **22.22.2**。构建、测试和 API/Worker 开发工具可能要求更高版本，不能据此提高普通 Skill 用户的门槛。Node 版本事实以 `scripts/runtime-support.mjs` 为准。

- 在目标 Agent 实际运行环境中读取系统与架构，确认 `node` 的绝对可执行路径及 `node --version`。不能只看本机另一个终端、Chrome 安装状态或 Agent 图标。兼容版本直接复用，不安装第二份。
- 若 Node 缺失或低于最低版本，优先从 Node.js 官方归档下载**与目标 OS 和 CPU 架构匹配**的 v22.22.2 安装包/压缩包。官方归档列出 Windows x86/x64/ARM64 MSI/ZIP 与 macOS x64/ARM64 PKG/tar.gz；下载页同时提供签名 SHASUMS。按官方说明核验对应文件名的 SHA-256，能验证签名时也验证签名；校验不符立即停止。[Node.js v22.22.2 归档](https://nodejs.org/en/download/archive/v22.22.2) · [SHASUMS 签名验证](https://github.com/nodejs/node#verifying-binaries)
- Node 22 官方构建表目前列出 Windows x64/x86（Windows 10/Server 2016+）和 ARM64（Windows 10+），macOS x64/ARM64（macOS 11+）；归档版本还需核对对应文件是否存在。官方预编译包的构建机版本不等于最低运行系统版本。[Node 22 BUILDING.md](https://github.com/nodejs/node/blob/v22.x/BUILDING.md)
- 优先采用该 OS 官方安装流程或放在当前用户可访问的工具目录并用绝对路径调用。对缺失/过旧 Node 的普通安装，沿用当前任务或仍有效的用户安装委托，不重复询问；保留已有 Node、Shell 配置与其他工具。不为安装本 Skill 改全局 PATH、ExecutionPolicy、安全策略或管理员权限。Windows 使用普通固定 PowerShell/.NET 操作，不把 POSIX 命令套到 PowerShell，不执行临时脚本绕过策略。若宿主/系统实际要求额外审批、管理员权限或组织策略拦截，暂停该动作并让用户完成必要确认或提供最短交接。
- **Windows + WSL + Windows Chrome：** WSL 中的 Node 是 Linux 可执行文件，不能拿它注册 Windows Native Messaging host。只有在 WSL interop 已可用且策略允许时，才通过受支持的 Windows 调用运行 Windows `node.exe`，并用 Windows 路径操作 Skill、CLI 和 Chrome 用户数据；确认实际 `process.platform` 为 `win32`。无法调用 Windows Node 或访问选定 Windows profile 时停止并交接，不能改用 Linux Node 伪装桥接。
- 先按宿主当前授权检查它能否读写 Skill/下载目录、执行本地 Node、下载 GitHub Release 并操作目标 Chrome。权限拒绝或安全策略阻断时，报告具体动作与错误类别；不降低权限、不关闭沙箱、不走其他桥接绕过。

## 三入口共享安装顺序

这些步骤由 `SKILL.md` 中的共享流程执行；本节只定义宿主、平台和权限差异，不复制解析或桥接业务规则。

1. **当前扩展页 → Skill：** 页面里的运行时扩展 ID 和 Profile 仅作线索。先确认 Agent 和 Chrome 在同一目标机器，再保留或安装 Skill。执行 `prepare` 后，按已选 profile 和本机查询到的 ID 运行 `diagnose --profile <directory-or-unique-name> --extension-id <extension-id>`。两个选项必须成对提供；此只读检查只查看 Chrome profile 元数据，不读桥接配置、不做实时握手。`candidate.status` 只描述记录状态，须在目标 profile 的 `chrome://extensions` 核实来源、启用情况和实际 ID 后才复用扩展。
2. **已安装 Skill → 扩展：** 先运行普通 `diagnose`，处理顶层单项 `nextAction` 指明的 Chrome/Node、profile/扩展、注册/配对或连接事项，再重新诊断。若运行候选诊断，候选动作会提升为顶层 `nextAction`，排在 Chrome/Node 阻断项之后、未配置桥接的泛化动作之前；存在两者时先处理顶层项。唯一 profile 直接使用；多个且用户未选时只询问一次，记住选择并用于所有后续命令。不要逐个尝试账号，不创建或改写 profile。扩展缺失时运行 `prepare` 并使用其 `extensionAssets` 返回的绝对目录作为持久加载位置。
3. **换机且两者都缺失：** 先安装完整 Skill 并读取其 references；再用 Release 获取和校验运行资源；按目标机实际 Chrome profile 检查/安装扩展。来源页面 ID、旧机器 profile 名和路径只作线索，不能代替目标机核实。安装新扩展后从目标 profile 的 `chrome://extensions` 取得实际 ID，再以候选诊断核对 profile 元数据；诊断状态不是实时握手，最终仍通过 `install-bridge`、`connect`、`status` 验证。

三种入口最终都按 `SKILL.md` 完成扩展复用或安装、桥接注册、`connect` 和 `status`。注册/连接必须以实际诊断和握手结果为准。首次打开、系统授权、登录、扫码或验证码由用户完成；在现有授权范围内且工具可用的普通安装/文件准备直接代办。若只有桌面操作工具不可用，但仍能在目标机器读写文件和执行命令，则先下载、校验、解压并给出所选 profile、真实绝对路径及最短人工加载步骤；如果 Agent 无法在目标机器读写文件、运行命令或取得 Release 包，不能声称已完成这些准备，只交接需要用户执行的最短步骤。
