---
name: weixin-channels-video
description: 通过本机 Chrome 插件解析视频号分享链接并下载视频；首次使用时协助安装插件与本地通信桥接。
---

# 视频号解析与下载

使用包内 `scripts/cli.mjs` 调用本项目 Chrome 插件。插件复用用户自己的元宝登录态，执行共享解析核心并下载视频；Skill 不操作上游页面、不读取 Cookie 或钥匙串，不依赖 Docker、远程解析服务或 Codex Chrome 插件。

## 检测与首次安装

需要 macOS、Node.js 24+ 和本机 Chrome 116+。先执行：

```sh
node <skill-root>/scripts/cli.mjs status
```

结果分开报告配置、连接和登录状态。只有插件已连接时才检查实际元宝登录；未连接不代表未登录，检查失败不代表登录失效。

缺少安装时，先准备包内 `assets/extension/` 目录和具体操作步骤，再取得安装与权限授权。说明插件可访问元宝和视频号站点、管理本项目的下载、为固定视频详情请求设置请求头，并通过 `nativeMessaging` 与本地桥接通信。桥接注册在当前用户的 Chrome NativeMessagingHosts，配置与 socket 仅当前用户可访问；Cookie 不交给桥接或 Agent。

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

用户可在插件主页面的“连接 AI 助手”区域直接开启、关闭和重新开启连接。默认关闭，手动解析与下载不受影响；关闭连接不会取消已接收的任务或已开始的下载。

`connect` 复用已有连接；未连接时在选定 profile 中打开插件主页面、初始化该 profile 的配对并自动开启连接，Chrome 由此启动本地桥接。配对保存在此 profile 的扩展内部；首次提示未配置时执行 `connect`，无需再次安装已注册的桥接。使用时保留主页面，关闭或刷新后会断开；不会打开元宝或视频号标签页。已配置但未连接时直接连接，无需再次安装。桥接程序升级或安装时使用的 Node.js 可执行文件位置变化后重新注册桥接。

元宝未登录时，请用户在同一 Chrome profile 中登录，再检查状态。扫码、验证码和必须由用户完成的系统确认交给用户；工具允许代操作且已授权的普通安装步骤继续完成。

## 解析与下载

```sh
node <skill-root>/scripts/cli.mjs parse --url <share-link>
node <skill-root>/scripts/cli.mjs download --url <share-link> [--filename <relative-mp4-filename>]
```

分享链接格式为 `https://weixin.qq.com/sph/...`。下载采用共享核心的默认媒体版本；文件名相对于 Chrome 下载目录，省略时根据标题生成。位置选择遵循 Chrome 下载设置，已有文件自动改名。不要把用户的绝对保存路径直接传给 `--filename`；需要另存时，在下载完成后用宿主文件工具移动，并保留已有文件。

下载命令等待 Chrome 确认完成后返回最终路径与字节数。只据此报告保存成功；中断或超时报告错误，不把开始下载当作完成。用户要求可播放验收时，再用可用的播放器或媒体工具检查文件。

只返回用户需要的视频信息、下载状态与本地文件路径。不要输出 Cookie、钥匙串凭据、内部 token/eid；解析结果中的媒体链接可能含临时访问参数，除非用户需要链接，不在对话或公共日志中展开完整结果。

插件或桥接不可用时报告缺少的组件，不自行回退到 Cookie 提取或重新实现解析。宿主工具明确拒绝的操作不能通过桥接改道重试。
