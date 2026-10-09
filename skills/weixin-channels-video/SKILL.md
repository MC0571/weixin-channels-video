---
name: weixin-channels-video
description: 通过本机 Chrome 插件解析视频号分享链接并下载视频；首次使用时协助安装插件与本地通信桥接。
---

# 视频号解析与下载

使用包内 `scripts/cli.mjs` 调用本项目 Chrome 插件。插件复用用户自己的元宝登录态，执行共享解析核心并下载视频；Skill 不操作上游页面、不读取 Cookie 或钥匙串，不依赖 Docker、远程解析服务或 Codex Chrome 插件。

## 检测与恢复连接

需要 macOS、Node.js 24+ 和本机 Chrome 116+。先执行：

```sh
node <skill-root>/scripts/cli.mjs status
```

结果分开报告配置、连接和登录状态。只有插件已连接时才检查实际元宝登录；未连接不代表未登录，检查失败不代表登录失效。已连接时直接使用，不打开插件页。

未连接、配置无效或通信失败时，先执行只读诊断：

```sh
node <skill-root>/scripts/cli.mjs diagnose
```

根据诊断中的 Chrome 安装、版本与运行状态、profile、扩展记录、桥接注册与文件、配对及连接状态选择下一步。只报告与当前故障有关的已确认事实和应对方式，不把完整 JSON 当作用户指引。`unknown` 表示无法确认；`recorded_unknown` 表示存在扩展记录但无法确认是否启用；扩展记录缺失也可能是 ID 不匹配。不能仅凭连接超时断言扩展未安装。

- **Chrome 未安装或版本不足**：提供 [Chrome 官方下载入口](https://www.google.com/chrome/) 和安装/更新步骤；获得授权且有桌面工具时协助安装。首次运行、许可确认、系统授权和登录由用户完成。安装位置、版本或启动原因无法确认时说明已知信息，不把启动失败统一说成未安装。
- **Chrome 未运行**：已有桥接配置时执行 `connect`，自动后台启动所选 profile 的正常 Chrome 并等待通信就绪。启动进程不等于扩展已连通。首次/修复配对可能短暂打开一个初始化页，完成后自行关闭；日常连接和任务不需要保留插件页。
- **profile 未选择、已不存在或元数据无法读取**：复用用户已选定的 profile；需要选择时运行 `list-profiles`。多个 profile 且用户未指定时请用户选择，不逐个尝试登录，不创建或改写 profile。
- **扩展记录缺失、被禁用或 ID 可能不符**：在选定 profile 的 `chrome://extensions` 中核实来源、ID 和启用状态。已安装时复用并修正桥接配置；用户主动禁用时由用户决定是否恢复。只有确认缺失后才进入安装流程。
- **桥接未注册、文件缺失、配置过期或配对不匹配**：依据具体诊断检查桥接注册、host、launcher、Node.js 与配对。已有授权范围内可重新注册本工具的桥接；不覆盖无关文件。配置有效但未连接时执行 `connect`，不先重装。无法确认或恢复失败时给出具体错误类别与下面的手动步骤。
- **通信正常但元宝未登录或登录失效**：请用户在同一 Chrome profile 中登录，再执行 `status`。`LOGIN_CHECK_FAILED` 表示无法可靠检查登录；网络或响应失败不能当作未登录，也不通过重装处理。

恢复只发生在提交任务之前。解析或下载任务发出后若断连、超时，不自动重发；Chrome 下载可能仍在进行，应报告实际状态并引导检查扩展的下载记录。

## 首次安装与手动指引

Chrome 缺失且需要手动安装时，按 [Google 官方安装指引](https://support.google.com/chrome/answer/95346) 下载 Mac 安装包，打开磁盘映像，将 Google Chrome 拖入 Applications，再启动完成首次设置；随后重新诊断。已有 Chrome 的启动问题应按实际错误排查，避免重复安装。

确认缺少安装时，先准备包内 `assets/extension/` 的实际绝对目录和具体操作步骤，再取得安装与权限授权。说明插件可访问元宝和视频号站点、管理本项目的下载、为固定视频详情请求设置请求头，并通过 `nativeMessaging` 与本地桥接通信；`storage` 保存此 profile 的配对，`offscreen` 承接隐藏 iframe 与旧配对迁移，`alarms` 用于后台重连。首次配置后自动连接，无页面开关。桥接注册在当前用户的 Chrome NativeMessagingHosts，配置与 socket 仅当前用户可访问；Cookie 不交给桥接或 Agent。

授权可来自本次或仍有效的既有委托，对象与权限范围相同时不重复请求。授权后，有桌面操作工具就帮助在选定 profile 的 `chrome://extensions` 中启用开发者模式并加载包内扩展；没有该能力就提供目录和最短步骤。复用已经安装的本项目扩展时核对来源与权限，不重复安装。

列出 profile 只读取 Chrome 元数据：

```sh
node <skill-root>/scripts/cli.mjs list-profiles
```

使用用户已选定的 profile；有多个且用户未指定时请用户选择，不逐个尝试登录。取得扩展详情中的 ID 后执行：

```sh
node <skill-root>/scripts/cli.mjs install-bridge --extension-id <extension-id> --profile <directory-or-name>
node <skill-root>/scripts/cli.mjs connect
node <skill-root>/scripts/cli.mjs status
```

后台持有连接和任务，Chrome 启动或扩展重载后恢复此 profile 的配对；关闭、刷新或不打开插件页面均可使用 Skill。`connect` 复用已有连接，必要时启动 Chrome 或完成首次/修复配对；进程启动和配对保存后仍需等待桥接握手成功。已配置但未连接时直接连接，无需再次安装。旧页面 localStorage 配对自动迁移，配对不在 profile 之间共享。桥接程序升级或安装时使用的 Node.js 可执行文件位置变化后重新注册桥接。

安装失败或没有桌面代操作能力时，报告失败步骤与错误类别，并提供完整的手动指引：

1. 在选定 Chrome profile 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择上面给出的实际 `<skill-root>/assets/extension/` 绝对目录，确认扩展已启用。已有安装只核对来源、ID 与状态，避免重复加载。
3. 打开扩展详情，复制扩展 ID；运行上述 `install-bridge` 命令，填入该 ID 和选定 profile 的目录名。
4. 运行 `connect` 和 `status`。连接失败时运行 `diagnose`，按具体原因检查；元宝未登录时在同一 profile 登录再检查。

若系统策略、目录权限或工具审批阻止安装，明确说明阻止的是哪一步；不能通过 Cookie 提取、远程调试或其他入口绕过。

元宝未登录时，请用户在同一 Chrome profile 中登录，再检查状态。扫码、验证码和必须由用户完成的系统确认交给用户；工具允许代操作且已授权的普通安装步骤继续完成。

## 解析与下载

```sh
node <skill-root>/scripts/cli.mjs parse --url <share-link>
node <skill-root>/scripts/cli.mjs download --url <share-link> [--filename <relative-mp4-filename>]
```

分享链接格式为 `https://weixin.qq.com/sph/...`。下载采用共享核心的默认媒体版本，默认文件名为 `<title>.mp4`：扩展清理标题中的文件名非法字符并限制长度，重名时自动改名。用户没有指定名称时省略 `--filename`，不要另取通用文件名。文件名相对于 Chrome 下载目录，位置选择遵循 Chrome 下载设置。不要把用户的绝对保存路径直接传给 `--filename`；需要另存时，在下载完成后用宿主文件工具移动，并保留已有文件。

下载命令等待 Chrome 确认完成后返回最终路径与字节数。只据此报告保存成功；中断或超时报告错误，不把开始下载当作完成。用户要求可播放验收时，再用可用的播放器或媒体工具检查文件。

下载成功结果同时包含视频信息、`previewUrl` 和 `mediaVariants`，直接使用本次结果组织回复，不为展示链接再次解析或下载。

## 返回视频与下载链接

获取视频链接或完成下载后，在回复中嵌入视频，并列出 `mediaVariants` 中实际返回的各版本下载链接。链接使用返回的 `label`；没有具体码率数值时不猜测，也不把 H.264 / H.265 编码当作高低码率。

已下载时优先嵌入最终 `path` 指向的本地视频，并给出可点击的本地文件路径；仅解析时嵌入 `previewUrl`，不为了展示擅自下载。使用宿主支持的媒体展示方式；Codex 可用 `![视频标题](<绝对视频路径或预览URL>)`，含空格的本地路径用尖括号包裹，文件链接用 `[本地视频](<绝对视频路径>)`。宿主不能嵌入时给出预览链接，不通过另行下载规避显示限制。

回复保留标题、视频嵌入、各版本下载链接，以及下载完成时的最终路径和字节数。不要展开完整 JSON、Cookie、钥匙串凭据或内部 token/eid；临时媒体链接只用于本次预览和下载，不写入公共日志。

插件或桥接不可用时报告缺少的组件，不自行回退到 Cookie 提取或重新实现解析。宿主工具明确拒绝的操作不能通过桥接改道重试。
