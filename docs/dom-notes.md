# 页面结构与保存机制

记录脚本依赖的 DOM 结构。改选择器前先按这里确认，超星改版后优先看真实的页面而不是本文。

## 三类页面

| 场景 | URL 特征 | 说明 |
| --- | --- | --- |
| 作业已提交（看答案） | `/mooc-ans/mooc2/work/view` | 有正确答案节点 |
| 作业作答 | `/mooc-ans/mooc2/work/dowork` | 只有当前作答 |
| 考试整卷预览 | `/exam-ans/mooc2/exam/preview` | 由考试页的「整卷预览」跳转 |
| 考试逐题 | `/exam-ans/exam/test/...` | 脚本不注入 |

## 题目容器

三种页面都是 `.questionLi[data="题目id"]`，`data` 就是题目 id，两个账号看到同一份作业/考试时 id 完全一致（实测 92/92、36/36 对应）。

题目顺序在两个账号之间是打乱的，选项顺序也是各自打乱的，所以：

- 题目用 `data` 对齐
- 选项目只能用文本匹配，字母不可信

## 题型

| 页面 | 题型来源 |
| --- | --- |
| 已提交页 | 没有 `typename` 属性，只在 `h3 .colorShallow` 里写 `(单选题)` |
| 作答页 | 有 `typename="单选题"` |
| 考试预览 | `typename="(多选题, 2.0 分)"`，带分值 |

## 选项

```html
<!-- 作答页 / 考试预览 -->
<div class="answerBg" onclick="saveSingleSelect(this,'{qid}')" role="radio">
  <span data="B" class="choice{qid} num_option fl">A</span>   <!-- 显示 A，题库字母 B -->
  <div class="answer_p"><p>选项正文</p></div>
</div>
```

- 显示字母在 `span.num_option` / `span.num_option_dx` 的文本里
- `span[data]` 是题库字母，和显示字母不一定相同
- 选中态：`span` 的 class 含 `check_answer`（单选/判断）或 `check_answer_dx`（多选）
- **`aria-checked` 不可信**：考试页切换选项后旧选项的 `aria-checked="true"` 不会被移除

已提交页的选项是纯文本列表 `ul.qtDetail li`，形如 `A. 选项正文`，没有 class 标记。

## 答案节点（已提交页）

```html
<div class="mark_answer">
  <span class="colorDeep"><i>我的答案:</i><span class="stuAnswerContent">BCD</span></span>
  <span class="colorGreen"><i>正确答案:</i><span class="rightAnswerContent">BCD</span></span>
</div>
```

- 单选/多选：`rightAnswerContent` 是字母串，如 `BCD`
- 判断题：`rightAnswerContent` 是「对 / 错」，不是字母
- 填空题：答案按空排布，常见写法是每个空一个 `<p>` 或 `<dd>`，带 `(1)` `(2)` 编号，编号必须剥离
- 简答题：`rightAnswerContent` 里的 `（1）…（2）…` 是正文内容，不能当空位编号拆

## 编辑器（填空 / 简答）

| 题型 | textarea id |
| --- | --- |
| 填空（第 n 空） | `answerEditor{qid}{n}` |
| 简答 | `answer{qid}` |

- 页面用 UEditor；`UE.getEditor(id, undefined, true)` 拿实例
- `ed.getContent()` 是 HTML（`<p>…</p>`），`getContentTxt()` 会丢掉段落分隔，不要用
- `ed.setContent(html, false)` 会立刻回写 textarea；`ed.sync()` 再同步一次
- 填空题服务端存的是纯文本；UEditor 会把内容包成 `<p>`，提交时又会被 `sync()` 回写，属于站点自身行为

## 考试页的保存

- 点选项 → `saveSingleSelect` / `saveMultiSelect` → `submitForm(true, 单题容器, 回调)`
- 每个主观空的旁边有「保存」按钮：`a#save_{dataStr}`，`onclick="saveQuestion('{qid}','{dataStr}')"`
  - `dataStr` = textarea id 去掉前缀 `answer` 或 `answerEditor`
- 交卷：`finalSubmit()` → `submitForm(false)`，提交整卷

### 连续操作会丢保存

```js
function lockSubmit(lock) {
  if (lock) { window.submitOnce = true; $('body').css('pointer-events', 'none') }
  else { window.submitOnce = false; $('body').css('pointer-events', 'auto') }
}

function submitForm(tempSave, quietSubmit, callBack) {
  if (tempSave && window.submitOnce) { return }   // 上一个请求没回来，直接丢弃
  ...
  // ajax complete 里调用 lockSubmit(false)
}
```

连续快速点击 5 道题实测只发出 1 个 POST，其余全部丢失。脚本因此逐题等待 `window.submitOnce` 变回 falsy，全部填完再整卷保存一次。

### 答题卡

- 右侧答题卡元素是 `#answerSheet{qid}`，已作答时带 `active` 类
- 更新由 `changeQuestionCardColor(qid)` 完成，保存成功的回调里调用
- 脚本填完后对每道题调用一次，让卡片和实际内容一致

## 脚本管理器沙箱

ScriptCat / Tampermonkey 在沙箱里跑用户脚本，`window` 不是页面 window，拿不到 `window.UE`。必须用 `unsafeWindow`：

```js
const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
const ed = w.UE.getEditor(id, undefined, true)
```

直接操作 DOM（`element.click()`）不受沙箱影响，所以客观题在没有这层处理时也能正常填，只有依赖页面全局对象的主观题会静默失败。
