// ==UserScript==
// @name         超星作业答案桥
// @namespace    https://github.com/heimenkyou/chaoxing-answer-bridge
// @version      1.1.1
// @description  从作业或考试页提取答案，在另一账号按题目 id + 选项文本回填
// @author       heimenkyou
// @license      GPL-3.0
// @homepageURL  https://github.com/heimenkyou/chaoxing-answer-bridge
// @supportURL   https://github.com/heimenkyou/chaoxing-answer-bridge/issues
// @updateURL    https://raw.githubusercontent.com/heimenkyou/chaoxing-answer-bridge/main/chaoxing-answer-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/heimenkyou/chaoxing-answer-bridge/main/chaoxing-answer-bridge.user.js
// @match        *://*.chaoxing.com/*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

;(function () {
  'use strict'

  const NS = 'cx-ab'
  const PANEL_ID = NS + '-panel'
  const POS_KEY = NS + '-pos'

  // ============ 通用工具 ============

  /** 归一化文本：去全部空白（含 &nbsp; \u3000），用于跨页面比对 */
  function norm(s) {
    return (s || '').replace(/[\s\u00a0\u3000]+/g, '').trim()
  }

  /** 去标点后再比对，容忍「，」/「,」与括号差异 */
  function squash(s) {
    return norm(s).replace(/[，。、；：（）()【】\[\]「」“”"'《》<>!！?？,.;:]/g, '')
  }

  /** 判断题答案归一：对/正确/√/true → true */
  function judgeValue(s) {
    const t = norm(s).toLowerCase()
    if (/^(对|正确|是|√|true|t|y|yes)$/.test(t)) return true
    if (/^(错|错误|否|×|x|false|f|n|no)$/.test(t)) return false
    return null
  }

  function log(...args) {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    console.log('[答案桥]', line)
    if (window.__cxBridgeLog) window.__cxBridgeLog(line)
  }

  function store(key, value) {
    try {
      if (typeof GM_setValue === 'function') return GM_setValue(key, value)
      localStorage.setItem(NS + ':' + key, JSON.stringify(value))
    } catch (e) {
      /* 忽略存储失败 */
    }
  }

  function load(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback)
      const raw = localStorage.getItem(NS + ':' + key)
      return raw === null ? fallback : JSON.parse(raw)
    } catch (e) {
      return fallback
    }
  }

  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text)
        return true
      }
    } catch (e) {
      /* 降级到下面的方式 */
    }
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {
      /* 页面未获得焦点时会被拒绝 */
    }
    // 最后用临时 textarea 走 execCommand，兼容无安全上下文/无焦点的情况
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
    document.body.append(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (e) {
      ok = false
    }
    ta.remove()
    return ok
  }

  // ============ DOM 读取层 ============

  /** 找到页面上全部题目容器 */
  function allQuestions() {
    return [...document.querySelectorAll('.questionLi')].filter(q => q.querySelector('h3'))
  }

  /** 题干纯文本 */
  function questionText(q) {
    const h3 = q.querySelector('h3')
    return h3 ? norm(h3.textContent) : ''
  }

  /** 题干正文（去掉题号与题型标记），作为 id 缺失时的兜底 key */
  function questionKey(q) {
    const h3 = q.querySelector('h3')
    if (!h3) return ''
    let text = h3.textContent || ''
    text = text.replace(/^\s*\d+\s*[.、．]\s*/, '')
    text = text.replace(/[(（](单选题?|多选题?|判断题?|填空题?|简答题?|计算题?|名词解释|论述题?|资料题?|材料题?)[^)）]*[)）]/g, '')
    return squash(text)
  }

  /** 题型识别：优先 typename 属性，其次 h3 内题型标记，最后按选项特征推断 */
  function detectType(q) {
    const raw =
      (q.getAttribute('typename') || '') +
      (q.querySelector('h3 .colorShallow')?.textContent || '')
    if (/多选/.test(raw)) return 'multiple'
    if (/判断/.test(raw)) return 'judge'
    if (/填空/.test(raw)) return 'fill'
    if (/资料|材料/.test(raw)) return 'material'
    if (/简答|计算|名词解释|论述|分析|问答/.test(raw)) return 'essay'
    if (/单选/.test(raw)) return 'single'

    // 无题型标记时按结构推断
    if (q.querySelector('.stem_answer textarea')) return 'essay'
    const opts = q.querySelectorAll('.stem_answer .answerBg, ul.qtDetail li')
    if (opts.length === 2) {
      const texts = [...opts].map(o => norm(o.textContent).replace(/^[A-Z][.、．]?/, ''))
      if (texts.every(t => judgeValue(t) !== null)) return 'judge'
    }
    if (opts.length > 0) return 'single'
    return 'essay'
  }

  /** 读取选项：[{ key, text, el, checked }]，key 是该页面自己显示的字母 */
  function readOptions(q) {
    const nodes = [...q.querySelectorAll('.stem_answer .answerBg')]
    if (nodes.length) {
      const list = nodes.map(el => {
        const dataSpan = el.querySelector('span[data]')
        return {
          el,
          key: (el.querySelector('span.num_option, span.num_option_dx')?.textContent || '').trim(),
          bankKey: dataSpan?.getAttribute('data') || '',
          text: norm(el.querySelector('.answer_p')?.textContent || el.textContent),
          // 选中态的权威标记是选项字母上的 check_answer / check_answer_dx 类名
          byClass: /(^|\s)check_answer(_dx)?(\s|$)/.test(dataSpan?.className || ''),
          byAria: el.getAttribute('aria-checked') === 'true',
        }
      })
      // 页面上有 class 标记时以 class 为准：考试页切换选项后 aria-checked 会残留旧值
      const useClass = list.some(o => o.byClass)
      return list.map(o => ({ ...o, checked: useClass ? o.byClass : o.byAria }))
    }
    // 已提交页的选项是纯文本列表
    return [...q.querySelectorAll('ul.qtDetail li')].map(el => {
      const raw = el.textContent.trim()
      const m = raw.match(/^([A-Za-z])[.、．]\s*([\s\S]*)$/)
      return {
        el,
        key: m ? m[1].toUpperCase() : '',
        bankKey: '',
        text: norm(m ? m[2] : raw),
        checked: false,
      }
    })
  }

  /** 读取答案页"正确答案"节点 */
  function readCorrectNodes(q) {
    return [...q.querySelectorAll('.mark_answer .rightAnswerContent')]
  }

  /** 读取"我的答案"节点，即该账号自己的作答 */
  function readMyNodes(q) {
    return [...q.querySelectorAll('.mark_answer .stuAnswerContent')]
  }

  /** 页面真实 window：脚本管理器的沙箱里拿不到页面全局对象，需要 unsafeWindow */
  function pageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow
    } catch (e) {
      /* 非沙箱环境没有 unsafeWindow */
    }
    return window
  }

  /** 读取 UEditor 实例，拿不到返回 null */
  function getEditor(id) {
    const UE = pageWindow().UE
    if (!UE || typeof UE.getEditor !== 'function') return null
    try {
      const ed = UE.getEditor(id, undefined, true)
      if (ed) return ed
    } catch (e) {
      /* 编辑器尚未就绪 */
    }
    try {
      return UE.getEditor(id) || null
    } catch (e) {
      return null
    }
  }

  /** 该输入框旁边是否有 UEditor 容器（用来区分普通 textarea 与编辑器字段） */
  function hasEditorAround(ta) {
    return !!ta.parentElement?.querySelector('.edui-editor, [class*="edui-"]')
  }

  /** HTML 转纯文本，保留段落换行 */
  function htmlToText(html) {
    const div = document.createElement('div')
    div.innerHTML = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n')
    return (div.textContent || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  }

  /** 纯文本转 HTML，用于没有 HTML 来源时写入编辑器 */
  function textToHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
  }

  /** 主观题的输入框，按页面顺序即空位顺序 */
  function answerFields(q) {
    return [...q.querySelectorAll('textarea')].filter(t => /^answer/i.test(t.id || ''))
  }

  /** 读输入框当前内容：有编辑器取编辑器，否则取 textarea */
  function fieldHtml(ta) {
    const ed = getEditor(ta.id)
    if (ed && typeof ed.getContent === 'function') {
      try {
        return ed.getContent()
      } catch (e) {
        /* 编辑器尚未就绪时退回 textarea */
      }
    }
    return ta.value || ''
  }

  // ============ 提取 ============

  /**
   * 从作业页提取答案。
   * @param {'correct'|'mine'} source correct=正确答案（缺失时退回我的答案）；mine=只用本账号作答
   * 已提交页读 .mark_answer 的答案节点；未提交页读当前已选中的选项和编辑器内容。
   * 客观题同时保留原始字母和选项文本：字母在两个账号间会被各自打乱，只有文本可信。
   */
  function extractAnswers(source = 'correct') {
    const items = []
    for (const q of allQuestions()) {
      const type = detectType(q)
      const options = readOptions(q)
      const item = {
        id: q.getAttribute('data') || '',
        type,
        qtext: questionText(q),
        key: questionKey(q),
        options: options.map(o => ({ key: o.key, text: o.text })),
        letters: [],
        texts: [],
      }

      const pickNodes = () => {
        if (source === 'mine') return readMyNodes(q)
        const right = readCorrectNodes(q)
        return right.length ? right : readMyNodes(q)
      }

      if (type === 'single' || type === 'multiple' || type === 'judge') {
        const rightNodes = pickNodes()
        if (!rightNodes.length) {
          // 未提交的作答页：以当前页面已选中的选项为答案
          const checked = options.filter(o => o.checked)
          item.letters = checked.map(o => o.key)
          item.texts = checked.map(o => o.text)
          items.push(item)
          continue
        }
        const rightRaw = rightNodes.map(n => n.textContent.trim()).join(' ')

        if (type === 'judge') {
          const v = judgeValue(rightRaw)
          if (v !== null) item.texts = [v ? '对' : '错']
          item.letters = [rightRaw]
        } else {
          const letters = (rightRaw.match(/[A-Za-z]/g) || []).map(c => c.toUpperCase())
          item.letters = [...new Set(letters)]
          item.texts = item.letters
            .map(L => options.find(o => o.key === L)?.text || '')
            .filter(Boolean)
        }
      } else {
        // 主观题：按空收集答案；编辑器里的段落结构用 HTML 保留
        const nodes = pickNodes()
        if (nodes.length) {
          item.texts = nodes.map(n => richText(n))
          item.htmls = nodes.map(n => (n.innerHTML ? n.innerHTML.trim() : null))
        } else {
          item.htmls = []
          item.texts = answerFields(q).map(t => {
            const ed = getEditor(t.id)
            const html = ed ? ed.getContent() : t.value || ''
            item.htmls.push(html || null)
            return htmlToText(html)
          })
        }
      }
      items.push(item)
    }
    return items
  }

  /** 富文本取纯文本，保留段落换行 */
  function richText(el) {
    const paras = el.querySelectorAll('p')
    if (paras.length) {
      return [...paras].map(p => p.textContent.trim()).filter(Boolean).join('\n')
    }
    return (el.textContent || '').trim()
  }

  // ============ 填写（作答页） ============

  /** 供预演与执行共用：算出某题的匹配结果，不改动 DOM */
  function planQuestion(q, item) {
    const type = detectType(q)
    const plan = { q, item, type, actions: [], status: 'ok', notes: [] }

    if (type === 'single' || type === 'multiple' || type === 'judge') {
      const options = readOptions(q)
      if (!options.length) {
        plan.status = 'error'
        plan.notes.push('页面上找不到选项')
        return plan
      }
      const wanted = new Set()
      for (const text of item.texts) {
        const hit = matchOption(options, text, type)
        if (hit) wanted.add(hit)
        else plan.notes.push('未匹配选项文本：' + text.slice(0, 30))
      }
      if (!wanted.size) {
        plan.status = 'unmatched'
        return plan
      }
      if (type === 'multiple') {
        for (const o of options) {
          const should = wanted.has(o)
          if (should !== o.checked) plan.actions.push({ kind: 'click', el: o.el, want: should })
        }
      } else {
        // 单选/判断：点中目标即自动取消其余
        const target = [...wanted][0]
        const wrongChecked = options.some(o => o !== target && o.checked)
        if (!target.checked || wrongChecked) plan.actions.push({ kind: 'click', el: target.el, want: true })
      }
      if (plan.notes.length) plan.status = 'partial'
      return plan
    }

    // 主观题：答案按空顺序填入，空答案跳过但占位
    const blanks = answerFields(q)
    if (!blanks.length) {
      plan.status = 'error'
      plan.notes.push('找不到答题编辑器')
      return plan
    }
    const texts = item.texts || []
    if (!texts.some(t => (t || '').trim())) {
      plan.status = 'unmatched'
      plan.notes.push('答案为空')
      return plan
    }
    texts.forEach((text, i) => {
      if (!(text || '').trim()) return
      if (i >= blanks.length) {
        plan.notes.push(`第 ${i + 1} 空在本页没有对应输入框`)
        return
      }
      // 已经是目标内容就不用再写，便于回填后核验
      if (norm(htmlToText(fieldHtml(blanks[i]))) === norm(text)) return
      plan.actions.push({ kind: 'fill', el: blanks[i], text, html: item.htmls?.[i] || null })
    })
    if (plan.notes.length) plan.status = 'partial'
    return plan
  }

  /** 选项文本匹配：精确 → 去标点 → 互相包含 */
  function matchOption(options, text, type) {
    if (!text) return null
    if (type === 'judge') {
      const v = judgeValue(text)
      const hit = options.find(o => judgeValue(o.text) === v && v !== null)
      if (hit) return hit
    }
    const n = norm(text)
    const s = squash(text)
    return (
      options.find(o => o.text === n) ||
      options.find(o => squash(o.text) === s) ||
      options.find(o => s && (o.text.includes(n) || n.includes(o.text))) ||
      null
    )
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  /** 等页面自己的保存请求结束；页面保存期间会把 submitOnce 置为 true 并跳过后续保存 */
  async function waitSaveIdle(w = pageWindow(), timeout = 12000) {
    const start = Date.now()
    while (w && w.submitOnce === true) {
      if (Date.now() - start > timeout) return false
      await sleep(120)
    }
    return true
  }

  /** 主观题输入框旁边的「保存」按钮，id 形如 save_{dataStr} */
  function findSaveButton(ta) {
    const dataStr = (ta.id || '').replace(/^answer(Editor)?/, '')
    if (!dataStr) return null
    const byId = document.getElementById('save_' + dataStr)
    if (byId) return byId
    const q = ta.closest('.questionLi')
    if (!q) return null
    return [...q.querySelectorAll('a[onclick*="saveQuestion"]')].find(a =>
      (a.getAttribute('onclick') || '').includes("'" + dataStr + "'"),
    ) || null
  }

  /** 收尾：整卷保存一次，再刷新右侧答题卡 */
  async function flushSave() {
    const w = pageWindow()
    await waitSaveIdle(w)
    if (typeof w.submitForm === 'function') {
      try {
        w.submitForm(true)
      } catch (e) {
        log('整卷保存失败：' + e.message)
      }
      await waitSaveIdle(w)
    }
    if (typeof w.changeQuestionCardColor === 'function') {
      for (const q of allQuestions()) {
        const id = q.getAttribute('data')
        if (!id) continue
        try {
          w.changeQuestionCardColor(id)
        } catch (e) {
          /* 单题刷新失败不影响其他 */
        }
      }
    }
  }

  /** 执行单题的填写动作 */
  async function applyPlan(plan) {
    const w = pageWindow()
    for (const act of plan.actions) {
      try {
        await waitSaveIdle(w)
        if (act.kind === 'click') act.el.click()
        else if (act.kind === 'fill') {
          if (!fillBlank(act.el, act.text, act.html)) {
            plan.status = 'error'
            const note = '拿不到编辑器实例，内容未写入'
            if (!plan.notes.includes(note)) plan.notes.push(note)
            continue
          }
          // 主观题不点保存不会入库，和手动作答一样要点输入框旁的「保存」
          const saveBtn = findSaveButton(act.el)
          if (saveBtn) {
            await waitSaveIdle(w)
            saveBtn.click()
          }
        }
      } catch (e) {
        plan.status = 'error'
        plan.notes.push('执行失败：' + e.message)
      }
    }
    return plan
  }

  /**
   * 向 textarea 及其 UEditor 实例写入内容；html 用于保留段落结构。
   * @returns {boolean} 是否写入成功
   */
  function fillBlank(ta, text, html) {
    const ed = getEditor(ta.id)
    if (ed && typeof ed.setContent === 'function') {
      const content = html || textToHtml(text)
      ed.setContent(content, false)
      // setContent 一般不回写 textarea，而提交时读的是 textarea
      if (typeof ed.sync === 'function') ed.sync()
      ta.value = content
    } else if (hasEditorAround(ta)) {
      // 页面上有编辑器却拿不到实例：只改 textarea 会造成"看起来空白、提交内容也可能为空"，直接报错
      return false
    } else {
      ta.value = text
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new Event('change', { bubbles: true }))
    ta.dispatchEvent(new Event('blur', { bubbles: true }))
    return true
  }

  /** 按题目 id 对齐；id 缺失时退回题干文本 */
  function indexPage() {
    const byId = new Map()
    const byKey = new Map()
    for (const q of allQuestions()) {
      const id = q.getAttribute('data')
      if (id) byId.set(id, q)
      const key = questionKey(q)
      if (key && !byKey.has(key)) byKey.set(key, q)
    }
    return { byId, byKey }
  }

  function buildPlans(payload) {
    const { byId, byKey } = indexPage()
    return payload.items.map(item => {
      const q = (item.id && byId.get(item.id)) || byKey.get(item.key)
      if (!q) return { item, q: null, status: 'missing', type: item.type, notes: ['本页找不到这道题'], actions: [] }
      return planQuestion(q, item)
    })
  }

  // ============ 界面 ============

  const CSS = `
  #${PANEL_ID}{position:fixed;top:80px;right:16px;width:380px;max-width:calc(100vw - 20px);max-height:80vh;
    display:flex;flex-direction:column;
    background:#fff;border:1px solid #d7dde5;border-radius:10px;box-shadow:0 8px 28px rgba(15,23,42,.18);
    font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2937;z-index:2147483000}
  #${PANEL_ID} *{box-sizing:border-box}
  #${PANEL_ID} .h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #eef1f5;
    background:#f8fafc;border-radius:10px 10px 0 0;cursor:move;user-select:none}
  #${PANEL_ID} .h b{font-size:13px}
  #${PANEL_ID} .badge{font-size:11px;padding:1px 7px;border-radius:99px;background:#e8f0fe;color:#1a56db}
  #${PANEL_ID} .badge.warn{background:#fef3c7;color:#92400e}
  #${PANEL_ID} .h .sp{flex:1}
  #${PANEL_ID} .h button{border:0;background:transparent;font-size:15px;cursor:pointer;color:#64748b;padding:0 3px}
  #${PANEL_ID} .b{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px}
  #${PANEL_ID} textarea{width:100%;height:84px;resize:vertical;font:12px/1.45 ui-monospace,Consolas,monospace;
    padding:7px;border:1px solid #d7dde5;border-radius:6px;background:#fcfdff}
  #${PANEL_ID} .row{display:flex;gap:6px;flex-wrap:wrap}
  #${PANEL_ID} button.act{flex:1;min-width:92px;padding:6px 10px;border:1px solid #d7dde5;border-radius:6px;
    background:#fff;cursor:pointer;font-size:12px;color:#1f2937}
  #${PANEL_ID} button.act:hover{background:#f1f5f9}
  #${PANEL_ID} button.primary{background:#1a56db;border-color:#1a56db;color:#fff}
  #${PANEL_ID} button.primary:hover{background:#1546b4}
  #${PANEL_ID} button.linkbtn{align-self:flex-start;border:0;background:transparent;color:#1a56db;
    font-size:12px;cursor:pointer;padding:0}
  #${PANEL_ID} button.linkbtn:hover{text-decoration:underline}
  #${PANEL_ID} .stat{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:#475569}
  #${PANEL_ID} .stat span b{color:#0f172a}
  #${PANEL_ID} .list{max-height:230px;overflow:auto;border:1px solid #eef1f5;border-radius:6px}
  #${PANEL_ID} .it{padding:4px 8px;border-bottom:1px solid #f4f6f9;font-size:12px;display:flex;gap:6px;cursor:pointer}
  #${PANEL_ID} .it:hover{background:#f8fafc}
  #${PANEL_ID} .it .s{width:14px;flex:none;text-align:center}
  #${PANEL_ID} .it .t{color:#64748b;flex:none;min-width:34px}
  #${PANEL_ID} .it .m{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#475569}
  #${PANEL_ID} .ok .s{color:#16a34a}
  #${PANEL_ID} .partial .s{color:#d97706}
  #${PANEL_ID} .unmatched .s,#${PANEL_ID} .missing .s,#${PANEL_ID} .error .s{color:#dc2626}
  #${PANEL_ID} .tip{font-size:11px;color:#94a3b8}
  #${PANEL_ID}.min .b{display:none}
  #${PANEL_ID}.cx-hidden{display:none}
  .cx-ab-mark{outline:2px dashed #dc2626 !important;outline-offset:3px}
  `

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag)
    Object.assign(node, props)
    for (const c of [].concat(children)) node.append(c)
    return node
  }

  const state = {
    payload: null,
    plans: [],
    mode: 'extract',
  }

  function detectMode() {
    const p = location.pathname
    if (/\/work\/dowork/.test(p)) return 'fill'
    if (/\/work\/view/.test(p)) return 'extract'
    // 其他页面：能读到正确答案就当提取页
    if (document.querySelector('.mark_answer .colorGreen .rightAnswerContent')) return 'extract'
    return 'fill'
  }

  function buildPanel() {
    const mode = detectMode()
    state.mode = mode

    const title = el('b', { textContent: '答案桥' })
    const badge = el('span', { className: 'badge', textContent: mode === 'extract' ? '提取模式' : '填写模式' })
    const btnClose = el('button', { textContent: '×', title: '隐藏面板（点浏览器扩展图标的菜单可再次打开）' })
    const header = el('div', { className: 'h' }, [title, badge, el('span', { className: 'sp' }), btnClose])

    const body = el('div', { className: 'b' })
    const panel = el('div', { id: PANEL_ID }, [header, body])
    document.body.append(panel)

    const saved = load(POS_KEY, null)
    if (saved) {
      panel.style.left = saved.left
      panel.style.top = saved.top
      panel.style.right = 'auto'
    }

    btnClose.onclick = () => hidePanel()
    makeDraggable(panel, header)

    if (mode === 'extract') renderExtract(body, badge)
    else renderFill(body, badge)
  }

  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return
      dragging = true
      const r = panel.getBoundingClientRect()
      sx = e.clientX
      sy = e.clientY
      ox = r.left
      oy = r.top
      e.preventDefault()
    })
    document.addEventListener('mousemove', e => {
      if (!dragging) return
      panel.style.left = ox + e.clientX - sx + 'px'
      panel.style.top = oy + e.clientY - sy + 'px'
      panel.style.right = 'auto'
    })
    document.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      clampPanel()
      store(POS_KEY, { left: panel.style.left, top: panel.style.top })
    })
  }

  /** 按来源提取成可传输的 payload */
  function buildPayload(source) {
    const items = extractAnswers(source)
    const byType = items.reduce((m, it) => ((m[it.type] = (m[it.type] || 0) + 1), m), {})
    return {
      v: 2,
      meta: {
        title: document.title,
        url: location.href,
        workId: new URLSearchParams(location.search).get('workId') || '',
        source,
        extractedAt: new Date().toISOString(),
        total: items.length,
        byType,
        emptyCount: items.filter(it => !it.texts.length).length,
      },
      items,
    }
  }

  /** 写剪贴板，并在按钮上给出短反馈 */
  async function copyPayload(payload, btn) {
    const ok = await copyText(JSON.stringify(payload))
    const origin = btn.textContent
    btn.textContent = ok ? `已复制 ${payload.items.length} 题` : '复制失败'
    setTimeout(() => (btn.textContent = origin), 1500)
    return ok
  }

  // ---------- 提取模式 ----------

  function renderExtract(body, badge) {
    const copyCorrect = el('button', { className: 'act primary', textContent: '复制正确答案' })
    const copyMine = el('button', { className: 'act', textContent: '复制我的答案' })
    const stats = el('div', { className: 'stat' })
    const list = el('div', { className: 'list' })

    body.append(el('div', { className: 'row' }, [copyCorrect, copyMine]), stats, list,
      el('div', { className: 'tip', textContent: '复制后在作答页粘贴，点「预览匹配」。' }))

    /** 展示提取结果，供人工核对 */
    function render(payload) {
      const { items, meta } = payload
      state.payload = payload
      badge.textContent = `提取模式 · ${items.length} 题`
      badge.className = meta.emptyCount ? 'badge warn' : 'badge'
      stats.innerHTML = ''
      stats.append(
        el('span', { innerHTML: `题目 <b>${items.length}</b>` }),
        ...Object.entries(meta.byType).map(([k, v]) => el('span', { innerHTML: `${typeName(k)} <b>${v}</b>` })),
        el('span', { innerHTML: `无答案 <b>${meta.emptyCount}</b>` }),
        el('span', { innerHTML: `来源 <b>${meta.source === 'mine' ? '我的答案' : '正确答案'}</b>` }),
      )
      list.innerHTML = ''
      items.forEach((it, i) => {
        const row = el('div', { className: 'it ' + (it.texts.length ? 'ok' : 'missing') })
        row.append(
          el('span', { className: 's', textContent: it.texts.length ? '✓' : '!' }),
          el('span', { className: 't', textContent: typeName(it.type) }),
          el('span', { className: 'm', textContent: `${i + 1}. ${it.qtext.slice(0, 34)}` }),
          el('span', { className: 'm', textContent: it.texts.join(' / ').slice(0, 28) }),
        )
        list.append(row)
      })
    }

    /** 提取 + 写剪贴板 */
    async function copyWith(source, btn) {
      const payload = buildPayload(source)
      render(payload)
      await copyPayload(payload, btn)
      log(`复制${source === 'mine' ? '我的答案' : '正确答案'}：${payload.items.length} 题，无答案 ${payload.meta.emptyCount} 题`)
    }

    copyCorrect.onclick = () => copyWith('correct', copyCorrect)
    copyMine.onclick = () => copyWith('mine', copyMine)

    // 打开面板先按正确答案提取一份，方便直接核对题目和答案
    render(buildPayload('correct'))
  }

  // ---------- 填写模式 ----------

  function renderFill(body, badge) {
    const ta = el('textarea', { placeholder: '粘贴提取页复制的答案，点「预览匹配」' })
    const previewBtn = el('button', { className: 'act primary', textContent: '预览匹配' })
    const applyBtn = el('button', { className: 'act', textContent: '执行填写' })
    const exportBtn = el('button', { className: 'linkbtn', textContent: '复制本页当前作答' })
    const stats = el('div', { className: 'stat' })
    const list = el('div', { className: 'list' })
    // 面板隐藏后重新打开时，恢复上次粘贴的内容
    if (state.payload) ta.value = JSON.stringify(state.payload)

    body.append(ta, el('div', { className: 'row' }, [previewBtn, applyBtn]), exportBtn, stats, list,
      el('div', { className: 'tip', textContent: '预览不修改页面；执行后仍需自己点提交。' }))

    // 未提交的作答页也能当答案来源：导出本页已选中的选项
    exportBtn.onclick = async () => {
      const payload = buildPayload('mine')
      await copyPayload(payload, exportBtn)
      stats.innerHTML = ''
      stats.append(
        el('span', { innerHTML: `本页作答 <b>${payload.items.length}</b>` }),
        el('span', { innerHTML: `未作答 <b>${payload.meta.emptyCount}</b>` }),
      )
    }

    function loadPayload() {
      if (!ta.value.trim()) {
        // 没粘贴时用本机缓存
        if (state.payload) ta.value = JSON.stringify(state.payload)
        else return null
      }
      try {
        const p = JSON.parse(ta.value)
        state.payload = p
        return p
      } catch (e) {
        stats.innerHTML = `<span style="color:#dc2626">JSON 解析失败：${e.message}</span>`
        return null
      }
    }

    function renderPlans(plans) {
      const count = plans.reduce((m, p) => ((m[p.status] = (m[p.status] || 0) + 1), m), {})
      stats.innerHTML = ''
      stats.append(
        el('span', { innerHTML: `共 <b>${plans.length}</b>` }),
        el('span', { innerHTML: `可填 <b>${(count.ok || 0) + (count.partial || 0)}</b>` }),
        el('span', { innerHTML: `未匹配 <b>${(count.unmatched || 0) + (count.missing || 0)}</b>` }),
        el('span', { innerHTML: `出错 <b>${count.error || 0}</b>` }),
      )
      badge.textContent = `填写模式 · ${count.ok || 0}/${plans.length} 命中`
      badge.className = count.unmatched || count.missing || count.error ? 'badge warn' : 'badge'
      list.innerHTML = ''
      plans.forEach((p, i) => {
        const sign = { ok: '✓', partial: '~', unmatched: '!', missing: '?', error: '×' }[p.status] || '?'
        const row = el('div', { className: 'it ' + p.status })
        row.append(
          el('span', { className: 's', textContent: sign }),
          el('span', { className: 't', textContent: typeName(p.type) }),
          el('span', { className: 'm', textContent: `${i + 1}. ${(p.item.qtext || '').slice(0, 30)}` }),
          el('span', { className: 'm', textContent: p.notes.join('；').slice(0, 30) }),
        )
        if (p.q) row.onclick = () => p.q.scrollIntoView({ block: 'center', behavior: 'smooth' })
        list.append(row)
        if (p.q && p.status !== 'ok') p.q.classList.add('cx-ab-mark')
      })
    }

    previewBtn.onclick = () => {
      const payload = loadPayload()
      if (!payload) return
      state.plans = buildPlans(payload)
      document.querySelectorAll('.cx-ab-mark').forEach(e => e.classList.remove('cx-ab-mark'))
      renderPlans(state.plans)
    }

    applyBtn.onclick = async () => {
      const payload = loadPayload()
      if (!payload) return
      if (!state.plans.length) state.plans = buildPlans(payload)
      const previous = state.plans.slice()
      const total = state.plans.filter(p => p.q && p.actions.length).length
      let done = 0
      applyBtn.disabled = true
      try {
        for (const plan of state.plans) {
          if (!plan.q) continue
          if (plan.actions.length) {
            done++
            badge.textContent = `填写中 ${done}/${total}`
          }
          await applyPlan(plan)
        }
        badge.textContent = '保存中…'
        await flushSave()
      } finally {
        applyBtn.disabled = false
      }
      // 执行后重新核验页面状态，并把写入阶段的问题带过来
      state.plans = buildPlans(payload)
      state.plans.forEach((p, i) => {
        const prev = previous[i]
        if (prev && prev.status === 'error') {
          p.status = 'error'
          p.notes = prev.notes
        } else if (p.status === 'ok' && p.actions.length) {
          p.status = 'error'
          p.notes = ['写入后页面状态没有变化']
        }
      })
      renderPlans(state.plans)
      const bad = state.plans.filter(p => p.status !== 'ok')
      log(`填写完成：处理 ${done} 题，异常 ${bad.length} 题`)
    }
  }

  function typeName(t) {
    return { single: '单选', multiple: '多选', judge: '判断', fill: '填空', essay: '简答', material: '资料' }[t] || t
  }

  // ============ 启动 ============

  /** 拖动或窗口缩放后把面板拉回可视区域，避免缩窗口后跑到屏幕外 */
  function clampPanel() {
    const panel = document.getElementById(PANEL_ID)
    if (!panel || panel.classList.contains('cx-hidden')) return
    const r = panel.getBoundingClientRect()
    const left = Math.min(Math.max(0, r.left), Math.max(0, innerWidth - r.width - 4))
    const top = Math.min(Math.max(0, r.top), Math.max(0, innerHeight - r.height - 4))
    if (Math.abs(left - r.left) > 0.5 || Math.abs(top - r.top) > 0.5) {
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
      panel.style.right = 'auto'
      store(POS_KEY, { left: panel.style.left, top: panel.style.top })
    }
  }

  function isPanelOpen() {
    const panel = document.getElementById(PANEL_ID)
    return !!panel && !panel.classList.contains('cx-hidden')
  }

  /** 面板完全不显示，由扩展图标菜单的开关唤起 */
  function hidePanel() {
    const panel = document.getElementById(PANEL_ID)
    if (panel) panel.classList.add('cx-hidden')
  }

  function showPanel() {
    const panel = document.getElementById(PANEL_ID)
    if (!panel) buildPanel()
    else panel.classList.remove('cx-hidden')
    clampPanel()
  }

  function togglePanel() {
    if (isPanelOpen()) hidePanel()
    else showPanel()
  }

  function boot() {
    if (!document.querySelector('.questionLi')) return
    if (document.getElementById(PANEL_ID)) return
    // 逐题模式的考试页不处理，只支持整卷预览
    if (/\/exam\/test\//.test(location.pathname)) return

    document.head.append(el('style', { textContent: CSS }))

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('答案桥：显示 / 隐藏面板', togglePanel)
    }
    // 无 GM 环境（如手动注入调试）时的入口
    window.__cxBridge = togglePanel

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') hidePanel()
    })
    window.addEventListener('resize', clampPanel)
  }

  boot()
})()
