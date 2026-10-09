# weixin-channels-video

视频号分享链接解析与下载工具，目标是通过共享解析核心提供 AI Skill、自部署解析 API 和 Chrome 扩展三种入口。

当前仓库只提供可导入的解析核心及合成响应测试；Skill、API 和扩展尚未包含，也没有可直接使用的下载入口。运行环境为 Node.js 24 或更新版本。当前命令只有：

```sh
npm ci
npm test
```

核心位于 `src/core.mjs`，导出 `parseShareLink(url, { request })`、`checkLogin(request)` 和 `ParseError`。核心通过调用者提供的 Fetch 风格 `request(url, init)` 发起请求，不管理登录凭据或文件保存。解析会校验分享链接、检查登录态、提取 `playable_url` 中的 `token` 和 `eid`，再从视频详情中选择可用媒体地址并返回统一结果。

核心错误包括 `INVALID_URL`、`AUTH_EXPIRED`、`LOGIN_CHECK_FAILED`、`FEED_UNAVAILABLE` 和 `UPSTREAM_ERROR`。测试使用合成响应，不访问真实上游服务或读取本机凭据。

后续目标入口：

- AI Skill：通过用户可用的浏览器会话解析并保存视频。
- 自部署 API：为调用者提供统一解析接口。
- Chrome 扩展：使用浏览器会话解析、预览和下载。

本仓库许可见 [LICENSE](LICENSE)。解析流程参考 [ltaoo/wx_channels_download](https://github.com/ltaoo/wx_channels_download) 的分享链接路线；参考项目采用 [MIT + Commons Clause](https://github.com/ltaoo/wx_channels_download/blob/main/LICENSE)，包含收费提供基于其功能的产品或服务的限制。复用其代码时须保留对应版权与许可声明；涉及收费产品或服务时，应按其许可取得授权。
