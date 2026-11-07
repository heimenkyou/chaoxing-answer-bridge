# 页面结构

脚本依赖的 DOM 结构。超星改版后以真实页面为准。

## 页面类型

| 场景 | URL 特征 | 用途 |
| --- | --- | --- |
| 作业详情 | `/mooc-ans/mooc2/work/view` | 读取正确答案 |
| 作业作答 | `/mooc-ans/mooc2/work/dowork` | 读取当前作答、写入 |
| 考试整卷预览 | `/exam-ans/mooc2/exam/preview` | 读取当前作答、写入 |
| 考试逐题 | `/exam-ans/exam/test/…` | 不支持，脚本不注入 |

考试整卷预览由考试页的「整卷预览」按钮跳转：`a.completeBtn` → `topreview()`。

## 标题

作业/考试名称在 `h2.mark_title`，如「作业三」。`document.title` 只有「作业详情」，不能当名字用。导出文件名取前者。

## 题目

### 容器

`.questionLi[data="{题目id}"]`。`data` 即题目 id，同一份作业或考试在两个账号下一致（实测 92/92、36/36 对应）。

### 顺序

题目顺序与选项顺序在两个账号间各自打乱。实测同一题在答案页为第 1 题、在作答页为第 21 题。

对齐规则：题目用 `data`，选项用文本，字母不参与匹配。

### 题型标记

| 页面 | 位置 | 示例 |
| --- | --- | --- |
| 作业详情 | `h3 .colorShallow` | `(单选题)` |
| 作业作答 | `typename` 属性 | `单选题` |
| 考试预览 | `typename` 属性 | `(多选题, 2.0 分)` |

作业详情页没有 `typename` 属性。

## 选项

### 结构

作业作答页与考试预览页：

```html
<div class="answerBg" onclick="saveSingleSelect(this,'{qid}')" role="radio">
  <span data="B" class="choice{qid} num_option fl">A</span>
  <div class="answer_p"><p>选项正文</p></div>
</div>
```

- `span.num_option` / `span.num_option_dx` 的文本是显示字母
- `span[data]` 是题库字母，与显示字母无对应关系
- `div.answer_p` 是选项正文

### 选中状态

| 题型 | 标记 |
| --- | --- |
| 单选、判断 | `span` 的 class 含 `check_answer` |
| 多选 | `span` 的 class 含 `check_answer_dx` |

`aria-checked` 在考试页切换选项后不会从旧选项移除，不能作为判断依据。

### 作业详情页

选项为纯文本列表 `ul.qtDetail li`，形如 `A. 选项正文`，无选中状态。

## 答案节点

仅在作业详情页存在：

```html
<div class="mark_answer">
  <span class="colorDeep"><i>我的答案:</i><span class="stuAnswerContent">BCD</span></span>
  <span class="colorGreen"><i>正确答案:</i><span class="rightAnswerContent">BCD</span></span>
</div>
```

| 题型 | 取值 |
| --- | --- |
| 单选、多选 | `rightAnswerContent` 的字母串，如 `BCD` |
| 判断 | `rightAnswerContent` 的「对 / 错」，非字母 |
| 填空 | 按空排布，通常带 `(1)` `(2)` 编号，编号需剥离 |
| 简答 | `rightAnswerContent` 内的 `（1）…（2）…` 属于正文，不能按空拆分 |

## 编辑器

| 题型 | textarea id |
| --- | --- |
| 填空第 n 空 | `answerEditor{qid}{n}` |
| 简答 | `answer{qid}` |

UEditor：

- `UE.getEditor(id, undefined, true)` 取实例
- `getContent()` 返回 HTML；`getContentTxt()` 会丢失段落分隔
- `setContent(html, false)` 立即回写 textarea，`sync()` 再次同步
- 填空内容提交时被包成 `<p>…</p>`，属站点自身行为

## 保存机制

考试预览页的保存路径：

| 操作 | 调用 |
| --- | --- |
| 点选项 | `saveSingleSelect` / `saveMultiSelect` → `submitForm(true, 单题容器, 回调)` |
| 主观空 | `a#save_{dataStr}` 的「保存」→ `saveQuestion(qid, dataStr)` |
| 交卷 | `finalSubmit()` → `submitForm(false)` |

`dataStr` 为 textarea id 去掉前缀 `answer` 或 `answerEditor`。

### submitOnce 节流

```js
function lockSubmit(lock) {
  if (lock) { window.submitOnce = true; $('body').css('pointer-events', 'none') }
  else { window.submitOnce = false; $('body').css('pointer-events', 'auto') }
}

function submitForm(tempSave, quietSubmit, callBack) {
  if (tempSave && window.submitOnce) { return }
  // ajax complete 中调用 lockSubmit(false)
}
```

保存请求未返回时，后续保存请求被直接丢弃。实测连续点击 5 道题仅发出 1 个 POST，其余只改了页面。

脚本处理：每次操作前等待 `window.submitOnce` 转假，全部完成后执行一次整卷保存。

### 答题卡

| 项 | 值 |
| --- | --- |
| 元素 | `#answerSheet{qid}` |
| 已作答标记 | class `active` |
| 更新函数 | `changeQuestionCardColor(qid)`，由保存回调调用 |

## 脚本管理器沙箱

ScriptCat 与 Tampermonkey 的沙箱中 `window` 不是页面 window，`window.UE` 不可用：

```js
const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window
const ed = w.UE.getEditor(id, undefined, true)
```

DOM 操作（`element.click()`）跨沙箱可用，因此客观题不受影响，只有依赖页面全局对象的主观题会静默失败。
