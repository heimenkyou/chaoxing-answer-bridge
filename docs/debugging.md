# 调试

## 环境

两个账号需要独立 profile，避免登录态互相覆盖：

```powershell
$root = "$env:LOCALAPPDATA\cx-helper"
New-Item -ItemType Directory -Force "$root\chrome","$root\edge" | Out-Null

Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList `
  '--remote-debugging-port=9222', "--user-data-dir=$root\chrome", '--no-first-run', 'about:blank'

Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList `
  '--remote-debugging-port=9223', "--user-data-dir=$root\edge", '--no-first-run', 'about:blank'
```

登录态保存在 profile 目录，重启后无需重新登录。

## CDP 客户端

```powershell
node tools/cdp.mjs list
node tools/cdp.mjs eval 9223 dowork "return location.href"
node tools/cdp.mjs evaljs probe.js 9223 dowork result.json
```

目标支持页面序号或 URL / 标题片段。JS 以函数体执行，用 `return` 返回结果。

## 脚本注入

```powershell
node tools/cdp.mjs evaljs chaoxing-answer-bridge.user.js 9223 dowork
```

注入后调用 `window.__cxBridge()` 打开面板；正式环境为脚本管理器菜单项。

注入运行在页面主世界，不带沙箱。验证沙箱路径需手动模拟：

```js
window.unsafeWindow = { UE: window.UE }
```

## 保存核验

页面上的「已作答」只是本地状态，刷新可能回退。以服务端渲染结果为准：

```js
const html = await fetch(location.href, { credentials: 'include' }).then(r => r.text())
const doc = new DOMParser().parseFromString(html, 'text/html')
```

按 `.questionLi[data]` 与 `span[data].className` 读取服务端答案，与当前 document 比较。填空的 textarea 可能已被 `sync()` 改成 `<p>…</p>`，比较前去掉标签。

## 已知问题

| 问题 | 表现 | 处理 |
| --- | --- | --- |
| submitOnce 节流 | 连续操作只有首个保存生效 | 串行等待保存完成 |
| 脚本沙箱 | `window.UE` 为 undefined，主观题留空 | 用 `unsafeWindow` |
| 选项乱序 | 字母无法跨账号对应 | 按选项文本匹配 |
| `aria-checked` 残留 | 旧选项仍为 true | 用 `check_answer` 类名 |
| 题号不同 | 题干文本 key 匹配失败 | 用 `data` 题目 id |
| 填空答案带编号 | `(1)` 被写入答案 | 剥离空位编号 |
| 真实考试 | 测试会改动已保存答案 | 先记录原值，测后恢复并核验 |
