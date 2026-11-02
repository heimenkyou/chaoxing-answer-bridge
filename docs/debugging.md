# 本地调试

## 起两个互不干扰的浏览器

答案页和作答页要登录两个不同账号，用两个独立的 profile：

```powershell
$root = "$env:LOCALAPPDATA\cx-helper"
New-Item -ItemType Directory -Force "$root\chrome","$root\edge" | Out-Null

Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList `
  '--remote-debugging-port=9222', "--user-data-dir=$root\chrome", '--no-first-run', 'about:blank'

Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList `
  '--remote-debugging-port=9223', "--user-data-dir=$root\edge", '--no-first-run', 'about:blank'
```

两个窗口各自手动登录一次，登录态保存在 profile 目录里，之后重启不用再登。

## 连上去看页面

用 `tools/cdp.mjs`，不需要装 puppeteer：

```powershell
node tools/cdp.mjs list                       # 看两个端口上的页面
node tools/cdp.mjs eval 9223 dowork "return location.href"
node tools/cdp.mjs evaljs probe.js 9223 dowork result.json
```

`<目标>` 写序号或 URL 片段都行。JS 以函数体执行，用 `return` 返回结果。

## 在页面里试脚本

不用装脚本管理器也能验证逻辑：

```powershell
node tools/cdp.mjs evaljs chaoxing-answer-bridge.user.js 9223 dowork
```

注入后在控制台用 `window.__cxBridge()` 打开面板（正式环境里是脚本管理器的菜单项）。

注意：这样注入跑在页面主世界里，**没有沙箱**。要验证沙箱路径（`unsafeWindow`、页面全局对象是否可见），手动模拟一下：

```js
window.unsafeWindow = { UE: window.UE }   // 只通过 unsafeWindow 暴露 UE
```

## 验证是否真的保存成功

页面上的「已作答」只是本地状态，刷新会回退。用服务器渲染的 HTML 对比才可靠：

```js
const html = await fetch(location.href, { credentials: 'include' }).then(r => r.text())
const doc = new DOMParser().parseFromString(html, 'text/html')
// 在 doc 里按 .questionLi[data] / span[data].className 读服务端答案，和当前 document 比
```

填空题的 textarea 值在服务端可能已经被 `sync()` 成 `<p>…</p>`，比对时去掉标签再比较。

## 已经踩过的坑

- **连续操作丢保存**：考试页 `submitOnce` 为真时 `submitForm` 直接 return，必须串行等待。见 `dom-notes.md`。
- **沙箱**：`window.UE` 在脚本管理器沙箱里是 undefined，客观题照常工作，主观题静默留空。用 `unsafeWindow`。
- **选项字母**：两个账号的选项顺序不同，`span[data]` 的题库字母也不同，只能用文本匹配。
- **`aria-checked`**：考试页切换选项后旧值不清除，判断选中要用 `check_answer` 类名。
- **题干 key**：两个账号题号不同（同一题一个第 1 题、一个第 21 题），不要拿题干文本当主键，用 `data` 里的题目 id。
- **`(1)` 编号**：填空题正确答案按空带编号，直接当答案会判错。

## 测试会改到真实作答

在真实考试页里做验证会改动已保存的答案。改动前先记录原值，验证完恢复并用上面的方法从服务器核对一遍；恢复客观题时按选项文本前缀定位原选项。
