// CDP 调试客户端，零依赖（用 Node 22+ 自带的 fetch / WebSocket）。
// 用途：连上带 --remote-debugging-port 启动的浏览器，读写页面 DOM、截图。
//
// 用法：
//   node tools/cdp.mjs list                             列出 9222 / 9223 上的页面
//   node tools/cdp.mjs eval <port> <目标> <js>          在页面里执行 JS 并打印结果
//   node tools/cdp.mjs evaljs <port> <目标> <文件> [输出] 执行文件里的 JS，结果写入 JSON
//   node tools/cdp.mjs html <port> <目标> <输出文件>     保存页面 HTML
//   node tools/cdp.mjs shot <port> <目标> <输出文件>     截图
//   node tools/cdp.mjs front <port> <目标>               把页面切到前台（剪贴板 API 需要焦点）
//
// <目标> 可以是页面序号，也可以是 URL / 标题里的一段文字。
// JS 以函数体形式执行，用 return 返回 JSON 可序列化的结果。
import fs from 'node:fs'

const PORTS = [9222, 9223]

async function listPages(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const targets = await res.json()
    return targets.filter(t => t.type === 'page')
  } catch {
    return null
  }
}

async function connect(port, selector) {
  const pages = await listPages(port)
  if (!pages) throw new Error(`端口 ${port} 未启动`)
  const target = /^\d+$/.test(String(selector))
    ? pages[Number(selector)]
    : pages.find(t => t.url.includes(selector) || t.title.includes(selector))
  if (!target) throw new Error(`端口 ${port} 找不到页面：${selector}（共 ${pages.length} 个）`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    ws.onopen = ok
    ws.onerror = () => fail(new Error('WS 连接失败'))
  })

  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise(resolve => {
      const mid = ++id
      pending.set(mid, resolve)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  return { target, ws, send }
}

async function evaluate(port, selector, expression) {
  const { send, ws } = await connect(port, selector)
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{ ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  })
  ws.close()
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.exception?.description || 'eval error' }
  }
  return r.result?.result?.value
}

const [cmd, a, b, c] = process.argv.slice(2)

if (cmd === 'list') {
  for (const p of PORTS) {
    const pages = await listPages(p)
    if (!pages) {
      console.log(`${p}: 未启动`)
      continue
    }
    console.log(`${p}:`)
    pages.forEach((t, i) => console.log(`  [${i}] ${t.title} :: ${t.url}`))
  }
} else if (cmd === 'front') {
  const { send, ws } = await connect(Number(a), b)
  await send('Page.bringToFront')
  ws.close()
  console.log('ok')
} else if (cmd === 'evaljs') {
  const src = fs.readFileSync(a, 'utf8')
  const out = await evaluate(Number(b), c, src)
  fs.writeFileSync(process.argv[6] || 'out.json', JSON.stringify(out === undefined ? null : out, null, 2), 'utf8')
  console.log('ok')
} else if (cmd === 'eval') {
  const out = await evaluate(Number(a), b, c)
  console.log(JSON.stringify(out, null, 2))
} else if (cmd === 'html') {
  const out = await evaluate(Number(a), b, `document.documentElement.outerHTML`)
  fs.writeFileSync(c, out || '', 'utf8')
  console.log(`已写入 ${c} (${(out || '').length} 字符)`)
} else if (cmd === 'shot') {
  const { send, ws } = await connect(Number(a), b)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(c, Buffer.from(r.result.data, 'base64'))
  ws.close()
  console.log(`已写入 ${c}`)
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 14).join('\n'))
}
