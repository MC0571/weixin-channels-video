---
name: weixin-channels-video
description: Parse a WeChat Channels share link and save its video locally using an available logged-in Yuanbao session.
---

# Weixin Channels video

Use this skill when the user asks to parse or download a WeChat Channels share link (`https://weixin.qq.com/sph/...`). This package already carries the shared parser in its built scripts. Use those scripts to choose a request source, use the selected local session, and save media; do not reimplement the parser.

## Choose how to make requests

Use the host's built-in browser when it is available, checking its Yuanbao login first. If it reports `anonymous`, try the local Chrome script. If a login check fails because of a network, response, or permission error, stop and report that failure; do not treat it as anonymous. If the user specifies a mode, use only that mode.

First identify the host's actual browser and script tools. A usable built-in mode needs access to both Yuanbao and Channels origins, shared-script execution, and local media saving. Detect Chrome from its local profile metadata without decrypting cookies. Follow the host's documented APIs; capability or permission gaps make the built-in candidate unavailable. The local CLI is the Chrome mode and is available directly for `list-profiles`, `check-login`, and `download`.

## Codex App built-in browser

The packaged `scripts/browser.mjs` is a self-contained ESM bundle of the shared core and the Codex adapter. Load it in the host's persistent JavaScript runtime with `const WXChannelsBuiltin = await import('file:///absolute/skill/root/scripts/browser.mjs')`, replacing the path with the installed skill location. This import has been tested in Codex App's `cua_repl`. Keep all parser/CDP response values in that runtime; print only login status, fixed error codes, or saved file paths.

1. Select the in-app browser using its documented entry point. Obtain a Yuanbao tab and a Channels tab, with each tab navigated to its own permitted origin. Read the advertised `cdp` capability documentation; do not assume access is granted merely because the capability exists. Never put a token-bearing feed URL into the conversation or tool output.
2. Bind `yuanbaoCdp = await yuanbaoTab.capabilities.get('cdp')`. Call `WXChannelsBuiltin.checkBrowserLogin(yuanbaoCdp)`. A known anonymous result allows default fallback to the Chrome CLI. A failed check is an error and must not be presented as logged out.
3. Only when both origins and media saving are available and Yuanbao is authenticated, call `WXChannelsBuiltin.parseInBrowser(shareUrl, {yuanbaoCdp, channelsCdp})`. The adapter keeps sensitive parameters in execution context and sends each request through its own origin's CDP handle.
4. Keep the result private in a runtime variable. Call `WXChannelsBuiltin.downloadInBrowser(result, yuanbaoTab)`; it creates and then removes a temporary media link and uses the host's `downloadMedia` capability. Return only the downloaded local path. Use the local CLI's `save-existing` command below to publish it at the requested destination without overwriting.

This adapter has controlled tests; its first complete live parse-and-save acceptance is still tracked by repository Issue #5. If the host cannot load the bundle, access the second origin, or save media, do not claim built-in support in that environment. Use the Chrome route when permitted and selected by the above rules. An explicit tool approval rejection is not a reason to reproduce the rejected access through another tool.

The bundle also exports `selectExecution({mode, builtin, chrome, checkLogin: WXChannelsBuiltin.checkLogin})` for hosts providing both request factories. Candidates use `{available, request}` or a lazy `{available, getRequest}`. The selector checks built-in first and never calls the Chrome factory after a valid built-in login. In a host that executes the Chrome CLI separately, follow the same sequence with the commands below rather than trying to run Cookie extraction inside a webpage.

## Local Chrome mode

The local runner needs Node.js, Python 3, and the exact Python dependency in `requirements.txt`. If the dependency is missing, give the user `python3 -m pip install -r <skill-root>/requirements.txt`; do not silently switch to another cookie reader.

Before a local command reads cookies, explain that the Python helper may call `/usr/bin/security` through `browser-cookie3` to request the Chrome Safe Storage secret from macOS Keychain if selected encrypted cookies need decryption. The system prompt authorizes access to Chrome Safe Storage itself; the application limits cookie matching to Yuanbao. “Allow” is a one-time choice; “Always Allow” persists. The user handles the system prompt.

Run the packaged `scripts/cli.mjs list-profiles`. If more than one profile exists, ask the user which one to use or pass `--profile <directory-or-name>` when they already specified it. Never search every profile for a valid session. Profile listing reads Chrome metadata only and does not request Keychain access.

The local commands are:

```text
node <skill-root>/scripts/cli.mjs check-login [--profile <directory-or-name>]
node <skill-root>/scripts/cli.mjs download --url <share-link> --output <file> [--profile <directory-or-name>]
node <skill-root>/scripts/cli.mjs save-existing <browser-downloaded-file> --output <file>
```

Chrome may need to be fully closed before local Cookie access. The helper requires a checkpointed Cookie database and refuses an active Chrome database or a pending WAL. This affects local Chrome mode only; use the built-in browser mode when it is available.

If no profile is specified, select it automatically only when Chrome reports exactly one profile. A failed login check is an error, not an anonymous result. Do not print, copy into chat, or log cookies, Keychain data, `generalToken`, or authenticated URLs.

## Parse and save

Call the shared `parseShareLink(url, { request })` with the chosen request adapter. Save its `downloadUrl` by streaming to a temporary file in the destination directory, then publish without replacing an existing file. Report the resulting local path. Reject failed HTTP responses and empty media; actual playability is outside this skill's local save check.

The build bundles the shared parser into the standalone Skill files. The installed `dist/weixin-channels-video` folder does not depend on a checkout of this repository and does not contain a second copy of parsing rules.
