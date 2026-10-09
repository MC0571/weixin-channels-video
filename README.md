# weixin-channels-video

视频号分享链接解析与下载工具，通过共享解析核心提供自部署解析 API 和 Chrome 扩展。当前仓库包含 Node.js、Docker、Cloudflare Worker API 与手动使用的 Chrome 扩展；AI Skill 仍是未来目标。

需要 Node.js 24 或更新版本。安装依赖、运行合成响应测试并构建 Chrome 扩展：

```sh
npm ci
npm test
npm run build
```

构建后，在 Chrome `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，并选取 `dist/extension/`。更新源码后重新构建并在扩展页点击重新加载。扩展要求 Chrome 116 或更新版本。

## 共享解析核心

核心位于 `src/core.mjs`，导出 `parseShareLink(url, { request })`、`checkLogin(request)` 和 `ParseError`。核心通过 Fetch 风格的 `request(url, init)` 发起请求，不管理登录凭据或文件保存。解析会校验分享链接、检查登录态、提取 `playable_url` 中的 `token` 和 `eid`，再从视频详情中选择可用媒体地址并返回统一结果。错误码包括 `INVALID_URL`、`AUTH_EXPIRED`、`LOGIN_CHECK_FAILED`、`FEED_UNAVAILABLE` 和 `UPSTREAM_ERROR`。

## 自部署解析 API

服务只接受 `POST /parse`，调用者使用 `Authorization: Bearer <API_TOKEN>` 和 JSON 请求体：

```http
POST /parse
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"url":"https://weixin.qq.com/sph/你的分享链接"}
```

成功响应包含视频信息和媒体地址：

```json
{"data":{"sourceUrl":"https://weixin.qq.com/sph/example","title":"视频标题","author":"作者","coverUrl":"https://media.example/cover.jpg","previewUrl":"https://media.example/video.mp4","downloadUrl":"https://media.example/video.mp4","mediaVariants":[{"label":"H.264","downloadUrl":"https://media.example/video.mp4"}]}}
```

服务返回媒体链接，由调用者自行下载；服务不保存视频。`API_UNAUTHORIZED` 表示调用者的服务凭据无效，`AUTH_EXPIRED` 表示部署者的元宝登录态失效，两者均返回 HTTP 401。请求体上限为 8192 字节，服务不接受查询参数，也不作为任意网址代理。

### Docker

在仓库根目录创建 `.env` 并仅允许当前用户读取：

```dotenv
API_TOKEN=替换为随机的服务访问凭据
YUANBAO_COOKIE="替换为部署者自己的元宝Cookie"
```

```sh
chmod 600 .env
docker compose up --build -d
```

服务监听 3000 端口。也可将 `API_TOKEN` 与 `YUANBAO_COOKIE` 注入进程环境后运行 `npm start`；Node.js 不会自动读取 `.env`，也可使用 `node --env-file=.env server/index.mjs`。

### Cloudflare Worker

在 `worker/wrangler.toml` 中设置自己的 Worker 名称。先用 `npm run worker:build` 本地构建检查；部署时通过 Wrangler Secret 交互输入凭据：

```sh
npx wrangler login
npx wrangler secret put API_TOKEN --config worker/wrangler.toml
npx wrangler secret put YUANBAO_COOKIE --config worker/wrangler.toml
npm run worker:deploy
```

本地开发可在 `worker/.dev.vars` 中设置相同两项，再运行 `npm run worker:dev`。不要把真实凭据写入命令行参数或版本库。

Node、Docker 和 Worker 使用部署者提供的元宝 Cookie；它们不会继承本机 Chrome 登录态。上游登录可能过期，需要更新凭据。上游接口和媒体链接可能变化，返回的媒体地址应及时使用。测试使用合成响应，不访问真实上游服务或读取本机凭据。

## Chrome 扩展

在扩展所在的 Chrome profile 登录腾讯元宝，点击工具栏中的扩展图标，在页面粘贴视频号分享链接并选择“解析视频”。页面显示视频预览、封面、标题、作者和下载版本；点击所需版本即可通过 Chrome 下载 API 保存，重名时由 Chrome 自动改名。版本列表来自上游实际返回的媒体地址并按地址去重，首项为默认预览和下载版本。页面尝试读取媒体元数据展示分辨率；编码类别不等于清晰度，上游没有提供的画质不会生成。Chrome 下载 API 按浏览器规则向媒体主机发送该主机已有的 Cookie，扩展不能将其设置为 `credentials: omit`。

扩展在浏览器本地执行解析，不读取 Cookie 数据库，也不需要本地服务。元宝解析请求在隐藏 iframe 中使用浏览器会话；Chrome 的 SameSite 与第三方 Cookie 设置可能影响该登录态。视频详情由扩展 service worker 请求，临时添加一条精确匹配该请求的 Declarative Net Request session 规则，为请求设置视频号 `Origin` 和完整 `Referer`，结束后删除规则。规则只允许扩展页面发起的固定 API POST/XHR 请求，扩展不发送视频号 Cookie。

扩展需要 `downloads`、`declarativeNetRequestWithHostAccess` 权限，以及元宝和视频号站点访问权限。当前验证覆盖合成响应、请求限制、临时规则清理和下载状态；未在真实登录会话中验收上游请求，也未确认真实下载文件均可播放。接口、登录策略和媒体地址可能变化。

## 参考项目与许可

本仓库许可见 [LICENSE](LICENSE)。解析流程参考 [ltaoo/wx_channels_download](https://github.com/ltaoo/wx_channels_download) 的分享链接路线；参考项目采用 [MIT + Commons Clause](https://github.com/ltaoo/wx_channels_download/blob/main/LICENSE)，包含收费提供基于其功能的产品或服务的限制。复用其代码时须保留对应版权与许可声明；涉及收费产品或服务时，应按其许可取得授权。
