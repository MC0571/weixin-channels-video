# weixin-channels-video

视频号分享链接解析与下载工具，目标是通过共享解析核心提供 AI Skill、自部署解析 API 和 Chrome 扩展三种入口。当前仓库提供共享核心以及 Node.js、Docker 和 Cloudflare Worker 解析 API；Skill 与 Chrome 扩展仍是目标入口，尚未包含在仓库中。

需要 Node.js 24 或更新版本。安装依赖并运行合成响应测试：

```sh
npm ci
npm test
```

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

## 参考项目与许可

本仓库许可见 [LICENSE](LICENSE)。解析流程参考 [ltaoo/wx_channels_download](https://github.com/ltaoo/wx_channels_download) 的分享链接路线；参考项目采用 [MIT + Commons Clause](https://github.com/ltaoo/wx_channels_download/blob/main/LICENSE)，包含收费提供基于其功能的产品或服务的限制。复用其代码时须保留对应版权与许可声明；涉及收费产品或服务时，应按其许可取得授权。
