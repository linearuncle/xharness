/* xharness GUI renderer */
const $ = (id) => document.getElementById(id);

const S = {
  providers: [],
  efforts: [],
  sidebar: { pinned: [], projects: [] },
  activeProject: null, // dir
  activeConv: null, // id
  running: false,
  askPending: false,
  turn: null, // 当前流式回合的渲染状态
  meta: { providerId: null, model: "", effort: "" },
  settings: { activeProviderId: null, draft: null }, // 设置界面状态
  plugins: [], // 设置-插件页列表（主进程纯数据视图）
  activePluginRoot: null,
  attachments: [], // [{path,name,isImage}]
  appearance: null, // 外观设置（boot 时载入，theme.js 应用）
};

const DEFAULT_MODEL_ID = "deepseek-v4-flash";
const DEFAULT_EFFORT = "high";
const EFFORT_LABEL = { "": "默认", none: "关闭", low: "低", high: "高", max: "Max" };
const modelShort = (m) => (m ? m.replace(/^deepseek-/, "") : "未配置");

/** 是否已配置可用的 API Key（含已落盘 hasKey，或编辑中刚输入的 apiKey） */
function hasApiKey(p) {
  return !!(p?.hasKey || (typeof p?.apiKey === "string" && p.apiKey.trim()));
}

/** 设置页状态文案与样式类：已禁用 / 未配置(红) / 已启用(绿)
 *  模型列表仍按 enabled 展示；无 key 只影响此处状态，调用失败时按错误内容提示 */
function providerStatus(p) {
  if (!p?.enabled) return { cls: "", label: "已禁用", dot: "" };
  if (!hasApiKey(p)) return { cls: " err", label: "未配置", dot: " err" };
  return { cls: " on", label: "已启用", dot: " on" };
}

/** 空态/新会话默认：优先 deepseek-v4-flash + high；用户改过后写在会话 meta 里 */
function defaultChoice() {
  const p = S.providers.find((x) => x.enabled && x.models?.length);
  if (!p) return { providerId: null, model: "", effort: DEFAULT_EFFORT };
  const preferred = p.models.find((m) => m.id === DEFAULT_MODEL_ID);
  return {
    providerId: p.id,
    model: preferred?.id ?? p.models[0].id,
    effort: DEFAULT_EFFORT,
  };
}

/* ---------------- 侧栏 ---------------- */

function renderSidebar() {
  const sb = S.sidebar;
  const pinnedWrap = $("sb-pinned-section");
  const pinnedEl = $("sb-pinned");
  pinnedEl.innerHTML = "";
  if (sb.pinned.length) {
    pinnedWrap.classList.remove("hidden");
    for (const c of sb.pinned) pinnedEl.appendChild(convRow(c, true));
  } else pinnedWrap.classList.add("hidden");

  const wrap = $("sb-projects");
  wrap.innerHTML = "";
  for (const p of sb.projects) {
    const row = document.createElement("div");
    // 有当前对话时只高亮对话行；无对话（项目空态）才高亮项目
    const projectOn = p.dir === S.activeProject && !S.activeConv;
    row.className = "sb-project" + (projectOn ? " active" : "");
    row.innerHTML = `<span class="ic">🗂</span><span>${esc(p.name)}</span>`;
    row.onclick = () => selectProject(p.dir);
    wrap.appendChild(row);
    for (const c of p.conversations) wrap.appendChild(convRow(c, false));
  }
}

function convRow(c, pinned) {
  const el = document.createElement("div");
  el.className = "sb-conv" + (pinned ? " sb-pinned-conv" : "");
  if (c.id === S.activeConv) el.classList.add("active");
  el.innerHTML = `<span class="sb-conv-title">${esc(c.title)}</span>`;
  el.onclick = () => openConversation(c.id);
  el.oncontextmenu = (e) => {
    e.preventDefault();
    showConvMenu(e, c);
  };
  return el;
}

function showConvMenu(e, c) {
  document.querySelector(".ctx-menu")?.remove();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99;background:var(--panel);border:1px solid var(--card-border);border-radius:10px;box-shadow:0 8px 24px var(--shadow);padding:4px;font-size:13px;`;
  const mk = (label, fn) => {
    const it = document.createElement("div");
    it.textContent = label;
    it.style.cssText = "padding:7px 14px;border-radius:7px;cursor:pointer;";
    it.onmouseenter = () => (it.style.background = "var(--hover)");
    it.onmouseleave = () => (it.style.background = "");
    it.onclick = async () => { m.remove(); await fn(); };
    m.appendChild(it);
  };
  mk(c.pinned ? "取消置顶" : "置顶", async () => {
    S.sidebar = await api.pinConversation(c.id, !c.pinned);
    renderSidebar();
  });
  mk("删除", async () => {
    S.sidebar = await api.deleteConversation(c.id);
    if (S.activeConv === c.id) showEmpty();
    renderSidebar();
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }));
}

/* ---------------- 视图切换 ---------------- */

async function selectProject(dir) {
  S.activeProject = dir;
  S.activeConv = null;
  showEmpty();
  await refreshContext(dir);
  renderSidebar();
}

function showEmpty() {
  S.activeConv = null;
  $("empty-state").classList.remove("hidden");
  $("chat-scroll").classList.add("hidden");
  $("chat-header").classList.add("hidden");
  $("env-panel").classList.add("hidden");
}

async function refreshContext(dir) {
  const ctx = await api.getContext(dir);
  $("es-folder").textContent = ctx.folder;
  $("ctx-folder").textContent = ctx.folder;
  $("ctx-branch").textContent = ctx.branch ?? "—";
  $("ctx-branch-chip").style.display = ctx.branch ? "" : "none";
  $("env-branch").textContent = `⎇ ${ctx.branch ?? "—"}`;
  $("env-changes").innerHTML = `<span class="ic">◈</span>变更（${ctx.changes.length}）`;
  $("env-changes-list").textContent = ctx.changes.slice(0, 20).join("\n");
}

async function newConversation() {
  if (!S.activeProject) {
    await addProject();
    if (!S.activeProject) return;
  }
  const r = await api.newConversation(S.activeProject);
  S.sidebar = r.sidebar;
  await openConversation(r.id);
}

async function addProject() {
  S.sidebar = await api.addProject();
  renderSidebar();
  const last = S.sidebar.projects[S.sidebar.projects.length - 1];
  if (last && !S.activeProject) await selectProject(last.dir);
  else if (last) S.activeProject = last.dir;
}

async function openConversation(id) {
  const c = await api.openConversation(id);
  if (!c) return;
  S.activeConv = id;
  S.activeProject = c.projectDir;
  S.meta = c.meta;
  updateModelLabel();
  await refreshContext(c.projectDir);
  $("chat-title").textContent = c.title;
  $("empty-state").classList.add("hidden");
  $("chat-scroll").classList.remove("hidden");
  $("chat-header").classList.remove("hidden");
  const list = $("chat-list");
  list.innerHTML = "";
  for (const b of c.blocks) renderStoredBlock(list, b);
  renderSidebar();
  scrollBottom(true);
}

function renderStoredBlock(list, b) {
  if (b.kind === "user") {
    list.appendChild(el(`<div class="msg-user"><div class="bubble">${esc(b.text)}</div></div>`));
  } else if (b.kind === "divider") {
    list.appendChild(el(`<div class="turn-meta">已处理${b.elapsed ? " " + b.elapsed + "s" : ""}</div>`));
  } else if (b.kind === "assistant") {
    const d = el(`<div class="assistant"></div>`);
    api.renderMarkdown(b.text).then((h) => (d.innerHTML = DOMPurify.sanitize(h)));
    list.appendChild(d);
  } else if (b.kind === "tool") {
    list.appendChild(toolLineEl(b.summary, b.isError));
  } else if (b.kind === "notice") {
    list.appendChild(el(`<div class="notice">${esc(b.text)}</div>`));
  } else if (b.kind === "attachment") {
    const fn = b.fileName ?? (b.path ? b.path.split("/").pop() : null);
    if (b.type === "image" && fn) {
      const w = el(`<div class="msg-user"><img class="chat-img" src="xatt://a/${encodeURIComponent(fn)}" alt="${esc(b.name)}" /></div>`);
      w.querySelector("img").onerror = () => (w.innerHTML = `<div class="bubble">📎 ${esc(b.name)}</div>`);
      list.appendChild(w);
    } else {
      list.appendChild(el(`<div class="msg-user"><div class="bubble">📎 ${esc(b.name)}</div></div>`));
    }
  } else if (b.kind === "ask") {
    const d = el(
      `<div class="ask-block answered"><div class="ask-q">${esc(b.question)}</div><div class="notice">${esc(b.answer ?? "")}</div></div>`
    );
    list.appendChild(d);
  }
}

/* ---------------- 发送与流式渲染 ---------------- */

async function sendCurrent() {
  const input = $("input");
  const text = input.value.trim();
  if (S.askPending) {
    if (!text) return;
    input.value = "";
    autosize();
    api.answer(S.activeConv, text);
    return;
  }
  if (S.running) return;
  if (!text) return;
  if (!S.activeConv) await newConversation();
  if (!S.activeConv) return;
  // 把空态时选好的模型/推理强度应用到实际会话
  await api.setModelChoice(S.activeConv, S.activeProject, S.meta.providerId, S.meta.model);
  await api.setEffort(S.activeConv, S.activeProject, S.meta.effort ?? "");
  input.value = "";
  autosize();
  hidePopup();

  $("empty-state").classList.add("hidden");
  $("chat-scroll").classList.remove("hidden");
  $("chat-header").classList.remove("hidden");
  if ($("chat-title").textContent === "" || $("chat-title").textContent === "新对话")
    $("chat-title").textContent = text.slice(0, 16);

  const list = $("chat-list");
  for (const a of S.attachments) {
    if (a.isImage) {
      list.appendChild(el(`<div class="msg-user"><img class="chat-img" src="xatt://a/${encodeURIComponent(a.fileName ?? a.name)}" alt="${esc(a.name)}" /></div>`));
    } else {
      list.appendChild(el(`<div class="msg-user"><div class="bubble">📎 ${esc(a.name)}</div></div>`));
    }
  }
  list.appendChild(el(`<div class="msg-user"><div class="bubble">${esc(text)}</div></div>`));
  beginTurn(list);
  setRunning(true);
  scrollBottom(true);
  const paths = S.attachments.map((a) => a.path);
  S.attachments = [];
  renderAttachChips();
  api.send(S.activeConv, text, paths);
}

function beginTurn(list) {
  const metaEl = el(`<div class="turn-meta">已处理 0s</div>`);
  const container = el(`<div class="turn"></div>`);
  list.appendChild(metaEl);
  list.appendChild(container);
  const startTs = Date.now();
  const timer = setInterval(() => {
    metaEl.textContent = `已处理 ${Math.round((Date.now() - startTs) / 1000)}s`;
  }, 1000);
  S.turn = {
    container, metaEl, timer, startTs,
    curTextEl: null, curText: "",
    curRenderTimer: null, renderSeq: 0,
    thinkingEl: null, thinkingLabelEl: null, thinkingActive: false,
    textSegs: [], toolLines: new Map(), blocks: [{ kind: "divider" }],
    todoEl: null, askEl: null,
  };
}

function leaveThinking(t) {
  if (t.thinkingActive && t.thinkingEl) {
    t.thinkingEl.classList.add("collapsed");
    t.thinkingLabelEl.innerHTML = `<span class="thinking-toggle">已思考 ▸</span>`;
    t.thinkingLabelEl.querySelector(".thinking-toggle").onclick = () => {
      t.thinkingEl.classList.toggle("collapsed");
    };
  }
  t.thinkingActive = false;
}

function endTextSeg(t) {
  if (t.curRenderTimer) {
    clearTimeout(t.curRenderTimer);
    t.curRenderTimer = null;
  }
  if (t.curTextEl && t.curText.trim()) {
    t.blocks.push({ kind: "assistant", text: t.curText });
    t.textSegs.push({ text: t.curText, el: t.curTextEl });
    finalRenderSeg(t.curTextEl, t.curText); // 段落定稿：final 渲染（含代码语言自动检测）
  }
  t.curTextEl = null;
  t.curText = "";
  t.renderSeq++; // 使在途的流式渲染结果过期
}

// 用 morphdom 把新 HTML 以最小改动打进现有 DOM：未变化的前文节点原地不动
// （零重绘、选区不丢），只有尾部真正变化的节点被更新——流式渲染不闪的关键。
function morphHtml(container, html) {
  const tmp = document.createElement("span");
  tmp.innerHTML = html;
  morphdom(container, tmp, { childrenOnly: true });
}

// 段落定稿渲染（endTextSeg / 历史重放共用最终形态）
async function finalRenderSeg(segEl, text) {
  const html = DOMPurify.sanitize(await api.renderMarkdown(text, true));
  const stream = segEl.querySelector(".stream-text");
  if (stream) {
    stream.classList.add("rendered");
    morphHtml(stream, html);
  } else {
    segEl.innerHTML = html;
  }
}

// 渲染前修补未闭合的代码围栏：避免流到一半时后文被吞进代码块、闭合瞬间跳变
function stabilizeMarkdown(text) {
  const fences = text.match(/^ {0,3}(`{3,}|~{3,})/gm) || [];
  if (fences.length % 2 === 1) {
    const last = fences[fences.length - 1].trim();
    return text + "\n" + (last[0] === "~" ? "~~~" : "```");
  }
  return text;
}

// 流式 markdown 实时渲染：防抖合并，避免每个 token 都打一次 IPC
function scheduleSegRender(t) {
  if (t.curRenderTimer) return;
  t.curRenderTimer = setTimeout(() => {
    t.curRenderTimer = null;
    flushSegRender(t);
  }, 100);
}

async function flushSegRender(t) {
  const seq = ++t.renderSeq;
  const text = t.curText;
  // 流式期间 final=false：跳过代码语言自动检测（省 CPU、避免颜色中途换语言）
  const html = DOMPurify.sanitize(await api.renderMarkdown(stabilizeMarkdown(text), false));
  if (seq !== t.renderSeq) return; // 已有更新的渲染请求，丢弃过期结果
  const stream = t.curTextEl?.querySelector(".stream-text");
  if (stream) {
    if (!stream.classList.contains("rendered")) {
      stream.classList.add("rendered");
      stream.textContent = ""; // 清掉首屏纯文本，进入渲染态
    }
    morphHtml(stream, html); // 增量打补丁，前文不动
    scrollBottom();
  }
}

function onAgentEvent({ id, event }) {
  if (id !== S.activeConv) return; // 简化：只渲染当前会话
  const t = S.turn;
  if (!t) return;

  switch (event.type) {
    case "thinking_delta": {
      if (!t.thinkingActive) {
        endTextSeg(t);
        t.thinkingLabelEl = el(`<div class="thinking-label">正在思考</div>`);
        t.thinkingEl = el(`<div class="thinking"></div>`);
        t.container.appendChild(t.thinkingLabelEl);
        t.container.appendChild(t.thinkingEl);
        t.thinkingActive = true;
      }
      t.thinkingEl.textContent += event.text;
      break;
    }
    case "text_delta": {
      leaveThinking(t);
      if (!t.curTextEl) {
        t.curTextEl = el(`<div class="assistant"><span class="stream-text"></span></div>`);
        t.container.appendChild(t.curTextEl);
      }
      t.curText += event.text;
      const stream = t.curTextEl.querySelector(".stream-text");
      if (!stream.classList.contains("rendered")) {
        // 首个渲染快照到来前（≤100ms）：整段纯文本即时显示
        stream.textContent = t.curText;
      }
      // 渲染态下不直接动 DOM：等下一个 flush 以 morphdom 增量补丁更新（避免样式频闪）
      scheduleSegRender(t);
      break;
    }
    case "tool_start": {
      leaveThinking(t);
      endTextSeg(t);
      if (event.name === "TodoWrite" || event.name === "AskUserQuestion") break;
      const summary = toolSummary(event.name, event.input);
      const line = toolLineEl(summary, false, true);
      t.container.appendChild(line);
      t.toolLines.set(event.id, { line, summary });
      break;
    }
    case "tool_end": {
      const rec = t.toolLines.get(event.id);
      if (rec) {
        rec.line.querySelector(".t-ic").textContent = event.isError ? "✕" : "▸";
        if (event.isError) rec.line.classList.add("err");
        t.blocks.push({ kind: "tool", summary: rec.summary, isError: !!event.isError });
      }
      break;
    }
    case "todos": {
      if (!t.todoEl) {
        t.todoEl = el(`<div class="todo-block"></div>`);
        t.container.appendChild(t.todoEl);
      }
      const mark = { pending: "☐", in_progress: "■", completed: "✔" };
      t.todoEl.innerHTML = event.todos
        .map((x) => `<div>${mark[x.status] ?? "☐"} ${esc(x.content)}</div>`)
        .join("");
      break;
    }
    case "ask": {
      leaveThinking(t);
      endTextSeg(t);
      S.askPending = true;
      $("input").placeholder = "输入自由回答，或点击上方选项…";
      const d = el(`<div class="ask-block"><div class="ask-q">${esc(event.question)}</div></div>`);
      for (const o of event.options) {
        const opt = el(`<div class="ask-opt"><b>${esc(o.label)}</b><span>${esc(o.description)}</span></div>`);
        opt.onclick = () => {
          if (!S.askPending) return;
          opt.classList.add("picked");
          api.answer(S.activeConv, o.label);
        };
        d.appendChild(opt);
      }
      t.container.appendChild(d);
      t.askEl = { el: d, question: event.question };
      break;
    }
    case "notice": {
      leaveThinking(t);
      endTextSeg(t);
      t.container.appendChild(el(`<div class="notice">${esc(event.text)}</div>`));
      t.blocks.push({ kind: "notice", text: event.text });
      break;
    }
    case "error": {
      leaveThinking(t);
      endTextSeg(t);
      t.container.appendChild(el(`<div class="error-block">错误: ${esc(event.message)}</div>`));
      t.blocks.push({ kind: "notice", text: `错误: ${event.message}` });
      break;
    }
    case "cleared": {
      $("chat-list").innerHTML = "";
      finishTurn(null, true);
      return;
    }
    case "turn_end": {
      finishTurn(event.reason);
      return;
    }
  }
  if (S.askPending && event.type !== "ask") {
    // 回答已被消费（工具返回后继续），恢复输入语义
    S.askPending = false;
    $("input").placeholder = "随心输入";
    if (S.turn?.askEl) {
      S.turn.askEl.el.classList.add("answered");
      S.turn.blocks.push({ kind: "ask", question: S.turn.askEl.question, answer: "已作答" });
      S.turn.askEl = null;
    }
  }
  scrollBottom();
}

function finishTurn(reason, skipPersist = false) {
  const t = S.turn;
  if (!t) { setRunning(false); return; }
  clearInterval(t.timer);
  leaveThinking(t);
  endTextSeg(t);
  const elapsed = Math.round((Date.now() - t.startTs) / 1000);
  t.metaEl.textContent = `已处理 ${elapsed}s`;
  t.blocks[0] = { kind: "divider", elapsed };
  if (reason === "interrupted")
    t.container.appendChild(el(`<div class="notice">[回合已中断]</div>`));
  if (reason === "max_tool_calls")
    t.container.appendChild(el(`<div class="notice">[已达单回合工具调用上限]</div>`));

  // 最终 markdown 渲染已在各段 endTextSeg 时完成（finishTurn 前必经 endTextSeg）
  // 操作行（只保留可用的复制）
  const last = t.textSegs[t.textSegs.length - 1];
  if (last) {
    const row = el(`<div class="action-row"><span title="复制">⧉</span></div>`);
    row.children[0].onclick = () => navigator.clipboard.writeText(last.text);
    t.container.appendChild(row);
  }
  // 持久化本回合块
  if (!skipPersist && S.activeConv) {
    for (const b of t.blocks) api.appendBlock(S.activeConv, b);
  }
  S.turn = null;
  S.askPending = false;
  $("input").placeholder = "随心输入";
  setRunning(false);
  scrollBottom();
}

function toolSummary(name, input) {
  const i = input ?? {};
  switch (name) {
    case "Bash": return `已运行 ${i.command ?? ""}`;
    case "Read": return `已读取 ${short(i.file_path)}`;
    case "Write": return `已写入 ${short(i.file_path)}`;
    case "Edit": return `已编辑 ${short(i.file_path)}`;
    case "Grep": return `已搜索 ${i.pattern ?? ""}`;
    case "Glob": return `已匹配 ${i.pattern ?? ""}`;
    case "Skill": return `已调用技能 ${i.skill ?? ""}`;
    default: return `${name}`;
  }
}
const short = (p) => (typeof p === "string" ? p.split("/").slice(-3).join("/") : "");

function toolLineEl(summary, isError, running = false) {
  return el(
    `<div class="tool-line${isError ? " err" : ""}"><span class="t-ic">${isError ? "✕" : running ? "▹" : "▸"}</span><span class="t-text">${esc(summary)}</span></div>`
  );
}

function setRunning(v) {
  S.running = v;
  const btn = $("btn-send");
  if (v) {
    btn.textContent = "■";
    btn.classList.add("stop");
    btn.title = "停止";
  } else {
    btn.textContent = "↑";
    btn.classList.remove("stop");
    btn.title = "发送";
  }
}

/* ---------------- 弹层：/ 与 @ ---------------- */

let popupItems = [];
let popupSel = 0;
let popupApply = null;

function hidePopup() {
  $("popup").classList.add("hidden");
  popupItems = [];
  popupApply = null;
}

function showPopup(title, items, apply) {
  const p = $("popup");
  p.innerHTML = `<div class="popup-title">${esc(title)}</div>`;
  popupItems = items;
  popupSel = 0;
  popupApply = apply;
  items.forEach((it, idx) => {
    const row = el(
      `<div class="popup-item${idx === 0 ? " sel" : ""}"><span class="pi-name">${esc(it.name)}</span><span class="pi-desc">${esc(it.desc ?? "")}</span><span class="pi-tag">${esc(it.tag ?? "")}</span></div>`
    );
    row.onclick = () => { apply(it); hidePopup(); };
    p.appendChild(row);
  });
  if (items.length) p.classList.remove("hidden");
  else hidePopup();
}

function movePopupSel(d) {
  const rows = $("popup").querySelectorAll(".popup-item");
  if (!rows.length) return;
  rows[popupSel]?.classList.remove("sel");
  popupSel = (popupSel + d + rows.length) % rows.length;
  rows[popupSel].classList.add("sel");
  rows[popupSel].scrollIntoView({ block: "nearest" });
}

let fileSearchTimer = null;

async function updatePopup() {
  const input = $("input");
  const v = input.value;
  const caret = input.selectionStart;

  // 斜杠：仅当以 / 开头且无空格
  if (v.startsWith("/") && !v.includes(" ") && caret === v.length) {
    const q = v.slice(1).toLowerCase();
    const builtins = [
      { name: "/compact", desc: "手动压缩会话历史", tag: "内置" },
      { name: "/clear", desc: "清空会话历史与任务清单", tag: "内置" },
    ];
    const skills = S.activeProject ? await api.listSkills(S.activeProject) : [];
    const items = [
      ...builtins,
      ...skills.map((s) => ({ name: "/" + s.name, desc: s.description, tag: "技能" })),
    ].filter((it) => it.name.slice(1).toLowerCase().startsWith(q));
    showPopup("技能", items, (it) => {
      input.value = it.name + " ";
      input.focus();
      autosize();
    });
    return;
  }

  // @ 文件补全
  const before = v.slice(0, caret);
  const m = before.match(/@([\w\-./]*)$/);
  if (m && S.activeProject) {
    clearTimeout(fileSearchTimer);
    fileSearchTimer = setTimeout(async () => {
      const files = await api.searchFiles(S.activeProject, m[1]);
      showPopup(
        "文件",
        files.map((f) => {
          const parts = f.split("/");
          return { name: parts.pop(), desc: parts.join("/"), tag: "", full: f };
        }),
        (it) => {
          const start = caret - m[0].length;
          input.value = v.slice(0, start) + it.full + " " + v.slice(caret);
          input.focus();
          autosize();
        }
      );
    }, 120);
    return;
  }
  hidePopup();
}

/* ---------------- 模型菜单 ---------------- */

function updateModelLabel() {
  $("model-label").innerHTML = `${modelShort(S.meta.model)} ${EFFORT_LABEL[S.meta.effort ?? ""] ?? ""} <span class="chev">▾</span>`;
}

function toggleModelMenu(force) {
  const m = $("model-menu");
  const show = force ?? m.classList.contains("hidden");
  if (!show) { m.classList.add("hidden"); return; }
  renderModelMenuRoot();
  m.classList.remove("hidden");
}

function renderModelMenuRoot() {
  const m = $("model-menu");
  m.innerHTML = "";
  const row = (label, val, fn) => {
    const r = el(`<div class="mm-row">${label}<span class="mm-val">${esc(val)} <span class="chev">›</span></span></div>`);
    r.onclick = fn;
    m.appendChild(r);
  };
  row("模型", modelShort(S.meta.model), renderModelOptions);
  row("推理强度", EFFORT_LABEL[S.meta.effort ?? ""] ?? "默认", () =>
    renderModelMenuOptions("推理强度", S.efforts.map((x) => ({ label: x.label, value: x.value, cur: (S.meta.effort ?? "") === x.value })), async (v) => {
      if (S.activeConv) S.meta = await api.setEffort(S.activeConv, S.activeProject, v);
      else S.meta.effort = v;
      updateModelLabel();
    })
  );
}

// 模型选项：按供应商分组
function renderModelOptions() {
  const m = $("model-menu");
  m.innerHTML = `<div class="mm-row" id="mm-back">‹ 模型</div><div class="mm-sub"></div>`;
  $("mm-back").onclick = renderModelMenuRoot;
  const sub = m.querySelector(".mm-sub");
  const enabled = S.providers.filter((p) => p.enabled && p.models?.length);
  if (!enabled.length) {
    sub.appendChild(el(`<div class="mm-group">暂无可用供应商，请到设置中配置</div>`));
    return;
  }
  for (const p of enabled) {
    sub.appendChild(el(`<div class="mm-group">${esc(p.name)}</div>`));
    for (const mod of p.models) {
      const cur = p.id === S.meta.providerId && mod.id === S.meta.model;
      const r = el(`<div class="mm-opt">${esc(mod.id)}<span class="check">${cur ? "✓" : ""}</span></div>`);
      r.onclick = async () => {
        if (S.activeConv) {
          S.meta = await api.setModelChoice(S.activeConv, S.activeProject, p.id, mod.id);
        } else {
          S.meta.providerId = p.id;
          S.meta.model = mod.id;
        }
        updateModelLabel();
        toggleModelMenu(false);
      };
      sub.appendChild(r);
    }
  }
}

function renderModelMenuOptions(title, options, pick) {
  const m = $("model-menu");
  m.innerHTML = `<div class="mm-row" id="mm-back">‹ ${esc(title)}</div><div class="mm-sub"></div>`;
  $("mm-back").onclick = renderModelMenuRoot;
  const sub = m.querySelector(".mm-sub");
  for (const o of options) {
    const r = el(`<div class="mm-opt">${esc(o.label)}<span class="check">${o.cur ? "✓" : ""}</span></div>`);
    r.onclick = async () => { await pick(o.value); toggleModelMenu(false); };
    sub.appendChild(r);
  }
}

/* ---------------- 工具函数 ---------------- */

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function autosize() {
  const i = $("input");
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight, 180) + "px";
}
let stickBottom = true;
function scrollBottom(force) {
  const sc = $("chat-scroll");
  if (force || stickBottom) sc.scrollTop = sc.scrollHeight;
}

/* ---------------- 启动与事件绑定 ---------------- */

async function boot() {
  const st = await api.getState();
  S.providers = st.providers;
  S.efforts = st.efforts;
  S.sidebar = st.sidebar;
  S.meta = { ...defaultChoice() };
  // 外观：启动即应用，之后跟随系统深浅变化
  S.appearance = st.appearance;
  Appearance.init(S.appearance, (a) => (S.appearance = a));
  Theme.apply(S.appearance);
  Theme.watchSystem(() => S.appearance);
  $("username").textContent = "xharness";
  $("avatar").textContent = "x";
  updateModelLabel();
  renderSidebar();
  bindSettings();
  bindPlusMenu();
  maybeShowYoloModal(st.yoloAcked);

  // 全局快捷键：Cmd+N 新对话 / Cmd+O 添加项目
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "n") { e.preventDefault(); newConversation(); }
    else if (k === "o") { e.preventDefault(); addProject(); }
  });
  const first = S.sidebar.projects[0];
  if (first) await selectProject(first.dir);

  api.onAgentEvent(onAgentEvent);
  api.onSidebarUpdate((sb) => { S.sidebar = sb; renderSidebar(); });

  $("btn-new-conv").onclick = newConversation;
  $("btn-add-project").onclick = addProject;
  $("btn-send").onclick = () => {
    if (S.running && !S.askPending) api.stop(S.activeConv);
    else sendCurrent();
  };
  $("btn-env").onclick = async () => {
    await refreshContext(S.activeProject);
    $("env-panel").classList.toggle("hidden");
  };
  $("btn-env-close").onclick = () => $("env-panel").classList.add("hidden");
  $("model-label").onclick = () => toggleModelMenu();

  document.querySelectorAll(".es-card").forEach((c) => {
    c.onclick = () => {
      $("input").value = c.dataset.prompt;
      $("input").focus();
      autosize();
    };
  });

  const input = $("input");
  // 粘贴图片：截图后 Cmd+V 直接变成附件缩略图
  input.addEventListener("paste", async (e) => {
    const items = [...(e.clipboardData?.items ?? [])].filter((it) => it.type.startsWith("image/"));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items) {
      const file = it.getAsFile();
      if (!file) continue;
      const ext = (it.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const base64 = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1]);
        fr.readAsDataURL(file);
      });
      const saved = await api.savePastedImage(base64, ext);
      S.attachments.push({ ...saved, fileName: saved.name, isImage: true });
    }
    renderAttachChips();
  });
  input.addEventListener("input", () => { autosize(); updatePopup(); });
  input.addEventListener("keydown", (e) => {
    const popupOpen = !$("popup").classList.contains("hidden");
    if (popupOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePopupSel(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePopupSel(-1); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = popupItems[popupSel];
        if (it && popupApply) { popupApply(it); hidePopup(); }
        return;
      }
      if (e.key === "Escape") { hidePopup(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  $("chat-scroll").addEventListener("scroll", () => {
    const sc = $("chat-scroll");
    stickBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
  });
  // 用 mousedown 判定"点击菜单外关闭"：click 阶段菜单内容可能已被子菜单渲染替换，
  // 被点元素脱离 DOM 会让 contains() 误判为外部点击（导致子菜单打不开）
  document.addEventListener("mousedown", (e) => {
    if (!e.target.isConnected) return;
    if (!$("model-menu").contains(e.target) && e.target.id !== "model-label" && !$("model-label").contains(e.target))
      $("model-menu").classList.add("hidden");
  });
}

boot();

/* ---------------- 设置界面 ---------------- */

function switchSettingsPage(page) {
  $("set-nav-models").classList.toggle("active", page === "models");
  $("set-nav-appearance").classList.toggle("active", page === "appearance");
  $("set-nav-plugins").classList.toggle("active", page === "plugins");
  $("set-page-models").classList.toggle("hidden", page !== "models");
  $("set-page-appearance").classList.toggle("hidden", page !== "appearance");
  $("set-page-plugins").classList.toggle("hidden", page !== "plugins");
  if (page === "appearance") Appearance.render();
  if (page === "plugins") refreshPlugins();
}

function bindSettings() {
  $("btn-settings").onclick = openSettings;
  $("btn-settings-back").onclick = closeSettings;
  $("set-nav-models").onclick = () => switchSettingsPage("models");
  $("set-nav-appearance").onclick = () => switchSettingsPage("appearance");
  $("btn-add-provider").onclick = () => {
    const id = `p${Date.now().toString(36)}`;
    S.settings.draft = {
      id, name: "", baseUrl: "", apiFormat: "anthropic",
      apiKey: "", enabled: true, builtin: false, models: [],
    };
    S.settings.activeProviderId = id;
    renderProviderList();
    renderProviderDetail();
  };
  $("md-close").onclick = closeModelDialog;
  $("md-cancel").onclick = closeModelDialog;
  $("set-nav-plugins").onclick = () => switchSettingsPage("plugins");
  $("btn-add-plugin-github").onclick = openPluginDialog;
  $("btn-add-plugin-local").onclick = installPluginLocal;
  $("pg-close").onclick = closePluginDialog;
  $("pg-cancel").onclick = closePluginDialog;
}

function openSettings() {
  S.settings.activeProviderId = S.providers[0]?.id ?? null;
  S.settings.draft = null;
  document.body.classList.add("settings-open");
  $("settings-view").classList.remove("hidden");
  switchSettingsPage("models");
  renderProviderList();
  renderProviderDetail();
}

function closeSettings() {
  document.body.classList.remove("settings-open");
  $("settings-view").classList.add("hidden");
  // 供应商可能变化，校正当前选择
  const stillValid = S.providers.some(
    (p) => p.id === S.meta.providerId && p.enabled && p.models?.some((m) => m.id === S.meta.model)
  );
  if (!stillValid) S.meta = { ...defaultChoice(), effort: S.meta.effort || DEFAULT_EFFORT };
  updateModelLabel();
}

function currentProvider() {
  if (S.settings.draft && S.settings.draft.id === S.settings.activeProviderId)
    return S.settings.draft;
  return S.providers.find((p) => p.id === S.settings.activeProviderId) ?? null;
}

function renderProviderList() {
  const builtinEl = $("prov-builtin");
  const customEl = $("prov-custom");
  builtinEl.innerHTML = "";
  customEl.innerHTML = "";
  const rows = [...S.providers];
  if (S.settings.draft && !rows.some((p) => p.id === S.settings.draft.id))
    rows.push(S.settings.draft);
  for (const p of rows) {
    const st = providerStatus(p);
    const r = el(
      `<div class="prov-row${p.id === S.settings.activeProviderId ? " active" : ""}">🗄 <span>${esc(p.name || "未命名")}</span><span class="dot${st.dot}"></span></div>`
    );
    r.onclick = () => {
      if (S.settings.draft && p.id !== S.settings.draft.id) S.settings.draft = null;
      S.settings.activeProviderId = p.id;
      renderProviderList();
      renderProviderDetail();
    };
    (p.builtin ? builtinEl : customEl).appendChild(r);
  }
}

function applyProviderBadge(badgeEl, p) {
  const st = providerStatus(p);
  badgeEl.className = `pd-badge${st.cls}`;
  badgeEl.textContent = st.label;
}

async function renderProviderDetail() {
  const box = $("prov-detail");
  const p = currentProvider();
  if (!p) { box.innerHTML = `<div class="notice">选择或添加一个供应商</div>`; return; }
  const isDraft = S.settings.draft?.id === p.id;
  const work = isDraft ? p : structuredClone(p); // 已存在的编辑基于副本，保存时落盘
  const renderForId = work.id;

  // 列表 IPC 脱敏不带 key；编辑时单独取回并回填到输入框
  if (!isDraft && work.hasKey && !work.apiKey) {
    box.innerHTML = `<div class="notice">加载中…</div>`;
    try {
      work.apiKey = (await api.getProviderKey(work.id)) || "";
    } catch {
      work.apiKey = "";
    }
    // 切换供应商期间的竞态：已不是当前选中项则丢弃
    if (S.settings.activeProviderId !== renderForId) return;
  }

  box.innerHTML = "";
  const st0 = providerStatus(work);
  const header = el(`<div class="pd-header">
      <span class="pd-name">${esc(work.name || "新供应商")}</span>
      <span class="pd-badge${st0.cls}" id="pd-toggle">${st0.label}</span>
      ${work.builtin ? "" : `<span class="icon-btn pd-del" id="pd-del" title="删除">🗑</span>`}
    </div>`);
  box.appendChild(header);
  const badgeEl = header.querySelector("#pd-toggle");
  badgeEl.onclick = () => {
    work.enabled = !work.enabled;
    applyProviderBadge(badgeEl, work);
    if (isDraft) {
      // draft 本身就在列表数据源里，刷新圆点
      renderProviderList();
    }
  };
  const delBtn = header.querySelector("#pd-del");
  if (delBtn) delBtn.onclick = async () => {
    if (isDraft) { S.settings.draft = null; }
    else {
      const r = await api.deleteProvider(work.id);
      S.providers = r.providers;
    }
    S.settings.activeProviderId = S.providers[0]?.id ?? null;
    renderProviderList();
    await renderProviderDetail();
  };

  const field = (labelText, inputHtml) => {
    box.appendChild(el(`<label>${labelText}</label>`));
    const w = el(`<div>${inputHtml}</div>`);
    box.appendChild(w);
    return w.firstChild;
  };

  const nameInput = field("名称", `<input type="text" placeholder="如：DeepSeek" value="${esc(work.name)}" ${work.builtin ? "disabled" : ""} />`);
  nameInput.oninput = () => (work.name = nameInput.value.trim());

  const urlInput = field("Base URL", `<input type="text" placeholder="https://api.example.com/anthropic" value="${esc(work.baseUrl)}" />`);
  urlInput.oninput = () => (work.baseUrl = urlInput.value.trim());

  field("API 格式", `<select disabled><option>Anthropic Messages (/v1/messages)</option></select>`);

  // API Key：回填已保存值（password 默认隐藏，点眼睛可看明文）
  box.appendChild(el(`<label>API Key</label>`));
  const keyRow = el(`<div class="key-row">
      <input type="password" placeholder="输入 API Key" value="${esc(work.apiKey || "")}" />
      <span class="icon-btn" title="显示/隐藏">👁</span>
    </div>`);
  box.appendChild(keyRow);
  const keyInp = keyRow.querySelector("input");
  keyInp.oninput = () => {
    work.apiKey = keyInp.value.trim();
    applyProviderBadge(badgeEl, work);
    if (isDraft) renderProviderList();
  };
  keyRow.querySelector(".icon-btn").onclick = () => {
    keyInp.type = keyInp.type === "password" ? "text" : "password";
  };

  // 模型列表
  box.appendChild(el(`<label>模型列表</label>`));
  const modelList = el(`<div></div>`);
  box.appendChild(modelList);
  const renderModels = () => {
    modelList.innerHTML = "";
    for (const mod of work.models) {
      const r = el(`<div class="model-row">
          <span>${esc(mod.id)}</span>
          <span class="ctx-badge">${mod.contextWindow >= 1_000_000 ? (mod.contextWindow / 1_000_000) + "M" : Math.round(mod.contextWindow / 1000) + "K"}</span>
          <span class="icon-btn" title="删除">🗑</span>
        </div>`);
      r.querySelector(".icon-btn").onclick = () => {
        work.models = work.models.filter((x) => x !== mod);
        renderModels();
      };
      modelList.appendChild(r);
    }
  };
  renderModels();
  const addModelBtn = el(`<button class="btn">＋ 添加模型</button>`);
  box.appendChild(addModelBtn);
  addModelBtn.onclick = () => openModelDialog((id, ctx) => {
    if (work.models.some((x) => x.id === id)) return;
    work.models.push({ id, contextWindow: ctx });
    renderModels();
  });

  // 保存
  const saveRow = el(`<div class="pd-save-row"><button class="btn primary">保存</button><span class="env-hint" id="pd-msg"></span></div>`);
  box.appendChild(saveRow);
  saveRow.querySelector("button").onclick = async () => {
    if (!work.name || !work.baseUrl) {
      saveRow.querySelector("#pd-msg").textContent = "名称与 Base URL 必填";
      return;
    }
    const r = await api.upsertProvider(work);
    if (!r.ok) { saveRow.querySelector("#pd-msg").textContent = r.error; return; }
    S.providers = r.providers;
    S.settings.draft = null;
    S.settings.activeProviderId = work.id;
    renderProviderList();
    renderProviderDetail();
    const msg = box.querySelector("#pd-msg");
    if (msg) msg.textContent = "已保存 ✓";
  };
}

/* 添加模型弹窗 */
let modelDialogSave = null;
function openModelDialog(onSave) {
  modelDialogSave = onSave;
  $("md-model-id").value = "";
  $("md-context").value = "200000";
  $("modal-backdrop").classList.remove("hidden");
  $("md-model-id").focus();
  $("md-save").onclick = () => {
    const id = $("md-model-id").value.trim();
    const ctx = parseInt($("md-context").value, 10);
    if (!id || !Number.isFinite(ctx) || ctx <= 0) return;
    modelDialogSave?.(id, ctx);
    closeModelDialog();
  };
}
function closeModelDialog() {
  $("modal-backdrop").classList.add("hidden");
  modelDialogSave = null;
}

/* ---------------- 设置-插件管理 ---------------- */

async function refreshPlugins(list) {
  S.plugins = list ?? (await api.listPlugins());
  if (!S.plugins.some((p) => p.root === S.activePluginRoot))
    S.activePluginRoot = S.plugins[0]?.root ?? null;
  renderPluginList();
  await renderPluginDetail();
}

function renderPluginList() {
  const box = $("plugin-rows");
  box.innerHTML = "";
  for (const p of S.plugins) {
    const r = el(
      `<div class="prov-row${p.root === S.activePluginRoot ? " active" : ""}">🧩 <span>${esc(p.name)}</span><span class="dot${p.enabled ? " on" : ""}"></span></div>`
    );
    r.onclick = async () => {
      S.activePluginRoot = p.root;
      renderPluginList();
      await renderPluginDetail();
    };
    box.appendChild(r);
  }
}

async function renderPluginDetail(errorMsg) {
  const box = $("plugin-detail");
  const p = S.plugins.find((x) => x.root === S.activePluginRoot);
  if (!p) {
    box.innerHTML = `<div class="notice">${errorMsg ? esc(errorMsg) : "暂无插件，可从 GitHub 或本地目录安装"}</div>`;
    return;
  }
  const renderForRoot = p.root;
  box.innerHTML = "";

  const header = el(`<div class="pd-header">
      <span class="pd-name">${esc(p.name)}</span>
      <span class="pd-static-dim">v${esc(p.version)}</span>
      <span class="pd-badge${p.enabled ? " on" : ""}" id="plug-toggle">${p.enabled ? "已启用" : "已禁用"}</span>
      <span class="icon-btn pd-del" id="plug-del" title="删除">🗑</span>
    </div>`);
  box.appendChild(header);

  const msgEl = el(`<div class="env-hint" id="plugin-msg">${errorMsg ? esc(errorMsg) : ""}</div>`);
  box.appendChild(msgEl);
  const msg = (t) => (msgEl.textContent = t);

  header.querySelector("#plug-toggle").onclick = async () => {
    const r = await api.setPluginEnabled(p.root, !p.enabled);
    if (r.ok) await refreshPlugins(r.plugins);
    else msg(r.error);
  };
  // 删除两步确认：首击进入待确认态，再击执行
  const delBtn = header.querySelector("#plug-del");
  let armed = false;
  delBtn.onclick = async () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = "确认删除?";
      return;
    }
    const r = await api.removePlugin(p.root);
    if (r.ok) await refreshPlugins(r.plugins);
    else msg(r.error);
  };

  if (p.description)
    box.appendChild(el(`<div class="pd-static">${esc(p.description)}</div>`));
  box.appendChild(el(`<label>位置</label>`));
  box.appendChild(el(`<div class="pd-static">${esc(p.root)}</div>`));
  box.appendChild(el(`<label>Hooks</label>`));
  box.appendChild(el(`<div class="pd-static">preToolUse × ${p.hookCount}</div>`));

  // 清单编辑（改）：直接编辑 plugin.json，保存前主进程校验 JSON
  box.appendChild(el(`<label>plugin.json</label>`));
  const ta = el(`<textarea spellcheck="false"></textarea>`);
  box.appendChild(ta);
  const saveRow = el(
    `<div class="pd-save-row"><button class="btn primary">保存清单</button></div>`
  );
  box.appendChild(saveRow);
  saveRow.querySelector("button").onclick = async () => {
    const r = await api.savePluginManifest(p.root, ta.value);
    if (r.ok) {
      await refreshPlugins(r.plugins);
      msg("已保存 ✓");
    } else msg(`保存失败：${r.error}`);
  };

  const m = await api.getPluginManifest(p.root);
  if (S.activePluginRoot !== renderForRoot) return; // 切换期间的竞态：丢弃
  ta.value = m.ok ? m.text : `// 读取失败：${m.error}`;
}

function openPluginDialog() {
  $("pg-url").value = "";
  $("pg-msg").textContent = "";
  $("plugin-backdrop").classList.remove("hidden");
  $("pg-url").focus();
  $("pg-install").onclick = async () => {
    const url = $("pg-url").value.trim();
    if (!url) return;
    $("pg-msg").textContent = "安装中…";
    $("pg-install").disabled = true;
    const r = await api.installPluginFromGitHub(url);
    $("pg-install").disabled = false;
    if (!r.ok) {
      $("pg-msg").textContent = r.error;
      return;
    }
    closePluginDialog();
    S.activePluginRoot = r.plugins.find((x) => x.name === r.name)?.root ?? null;
    await refreshPlugins(r.plugins);
  };
}

function closePluginDialog() {
  $("plugin-backdrop").classList.add("hidden");
}

async function installPluginLocal() {
  const r = await api.installPluginFromLocal();
  if (r.canceled) return;
  if (!r.ok) {
    await renderPluginDetail(`安装失败：${r.error}`);
    return;
  }
  S.activePluginRoot = r.plugins.find((x) => x.name === r.name)?.root ?? null;
  await refreshPlugins(r.plugins);
}

/* ---------------- + 插入菜单与附件 ---------------- */

function bindPlusMenu() {
  const menu = $("plus-menu");
  $("btn-plus").onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  };
  document.addEventListener("mousedown", (e) => {
    if (!e.target.isConnected) return;
    if (!menu.contains(e.target) && e.target.id !== "btn-plus")
      menu.classList.add("hidden");
  });
  $("pm-attach").onclick = async () => {
    menu.classList.add("hidden");
    const files = await api.pickAttachments();
    for (const f of files) {
      if (S.attachments.some((a) => a.path === f.path)) continue;
      const ext = f.name.split(".").pop().toLowerCase();
      S.attachments.push({
        ...f,
        isImage: ["png", "jpg", "jpeg", "webp", "gif"].includes(ext),
      });
    }
    renderAttachChips();
  };
  $("pm-mention").onclick = () => {
    menu.classList.add("hidden");
    insertAtCaret("@");
  };
  $("pm-slash").onclick = () => {
    menu.classList.add("hidden");
    const input = $("input");
    input.value = "/" + input.value;
    input.focus();
    input.setSelectionRange(1, 1);
    updatePopup();
  };
}

function insertAtCaret(textToInsert) {
  const input = $("input");
  const pos = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, pos) + textToInsert + input.value.slice(pos);
  input.focus();
  input.setSelectionRange(pos + textToInsert.length, pos + textToInsert.length);
  updatePopup();
}

function renderAttachChips() {
  const box = $("attach-chips");
  box.innerHTML = "";
  if (!S.attachments.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  for (const a of S.attachments) {
    let chip;
    if (a.isImage) {
      chip = el(`<span class="attach-thumb"><img src="xatt://a/${encodeURIComponent(a.fileName ?? a.name)}" alt="${esc(a.name)}" /><span class="x" title="移除">✕</span></span>`);
    } else {
      chip = el(`<span class="attach-chip">📄<span>${esc(a.name)}</span><span class="x" title="移除">✕</span></span>`);
    }
    chip.querySelector(".x").onclick = () => {
      S.attachments = S.attachments.filter((x) => x !== a);
      renderAttachChips();
    };
    box.appendChild(chip);
  }
}

/* ---------------- 首启 YOLO 风险确认 ---------------- */
function maybeShowYoloModal(acked) {
  if (acked) return;
  const modal = $("yolo-modal");
  modal.classList.remove("hidden");
  const agree = $("ym-agree");
  const start = $("ym-start");
  agree.onchange = () => (start.disabled = !agree.checked);
  start.onclick = async () => {
    await api.yoloAck();
    modal.classList.add("hidden");
  };
}
