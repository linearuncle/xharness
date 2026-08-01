/* xharness GUI renderer */
const $ = (id) => document.getElementById(id);

const S = {
  providers: [],
  envKeyPresent: false,
  efforts: [],
  sidebar: { pinned: [], projects: [] },
  activeProject: null, // dir
  activeConv: null, // id
  running: false,
  askPending: false,
  turn: null, // 当前流式回合的渲染状态
  meta: { providerId: null, model: "", effort: "" },
  settings: { activeProviderId: null, draft: null }, // 设置界面状态
};

const EFFORT_LABEL = { "": "默认", none: "关闭", low: "低", high: "高", max: "极高" };
const modelShort = (m) => (m ? m.replace(/^deepseek-/, "") : "未配置");

function defaultChoice() {
  const p = S.providers.find((x) => x.enabled && x.models?.length);
  return p ? { providerId: p.id, model: p.models[0].id } : { providerId: null, model: "" };
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
    row.className = "sb-project";
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
  m.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99;background:#fff;border:1px solid var(--card-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:4px;font-size:13px;`;
  const mk = (label, fn) => {
    const it = document.createElement("div");
    it.textContent = label;
    it.style.cssText = "padding:7px 14px;border-radius:7px;cursor:pointer;";
    it.onmouseenter = () => (it.style.background = "#f4f4f2");
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
  $("env-changes").textContent = `🗇 变更（${ctx.changes.length}）`;
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
    api.renderMarkdown(b.text).then((h) => (d.innerHTML = h));
    list.appendChild(d);
  } else if (b.kind === "tool") {
    list.appendChild(toolLineEl(b.summary, b.isError));
  } else if (b.kind === "notice") {
    list.appendChild(el(`<div class="notice">${esc(b.text)}</div>`));
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
  list.appendChild(el(`<div class="msg-user"><div class="bubble">${esc(text)}</div></div>`));
  beginTurn(list);
  setRunning(true);
  scrollBottom(true);
  api.send(S.activeConv, text);
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
  if (t.curTextEl && t.curText.trim()) {
    t.blocks.push({ kind: "assistant", text: t.curText });
    t.textSegs.push({ text: t.curText, el: t.curTextEl });
  }
  t.curTextEl = null;
  t.curText = "";
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
      t.curTextEl.querySelector(".stream-text").textContent = t.curText;
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

  // 最终 markdown 渲染
  for (const seg of t.textSegs) {
    api.renderMarkdown(seg.text).then((h) => (seg.el.innerHTML = h));
  }
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
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  S.envKeyPresent = st.envKeyPresent;
  S.efforts = st.efforts;
  S.sidebar = st.sidebar;
  S.meta = { ...defaultChoice(), effort: "" };
  $("username").textContent = st.username;
  $("avatar").textContent = st.username.slice(0, 1);
  updateModelLabel();
  renderSidebar();
  bindSettings();
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
  document.addEventListener("click", (e) => {
    if (!$("model-menu").contains(e.target) && e.target.id !== "model-label" && !$("model-label").contains(e.target))
      $("model-menu").classList.add("hidden");
  });
}

boot();

/* ---------------- 设置界面 ---------------- */

function bindSettings() {
  $("btn-settings").onclick = openSettings;
  $("btn-settings-back").onclick = closeSettings;
  $("btn-add-provider").onclick = () => {
    const id = `p${Date.now().toString(36)}`;
    S.settings.draft = {
      id, name: "", baseUrl: "", apiFormat: "anthropic",
      keyMode: "manual", apiKey: "", enabled: true, builtin: false, models: [],
    };
    S.settings.activeProviderId = id;
    renderProviderList();
    renderProviderDetail();
  };
  $("md-close").onclick = closeModelDialog;
  $("md-cancel").onclick = closeModelDialog;
}

function openSettings() {
  S.settings.activeProviderId = S.providers[0]?.id ?? null;
  S.settings.draft = null;
  document.body.classList.add("settings-open");
  $("settings-view").classList.remove("hidden");
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
  if (!stillValid) S.meta = { ...defaultChoice(), effort: S.meta.effort };
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
    const r = el(
      `<div class="prov-row${p.id === S.settings.activeProviderId ? " active" : ""}">🗄 <span>${esc(p.name || "未命名")}</span><span class="dot${p.enabled ? " on" : ""}"></span></div>`
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

function renderProviderDetail() {
  const box = $("prov-detail");
  const p = currentProvider();
  if (!p) { box.innerHTML = `<div class="notice">选择或添加一个供应商</div>`; return; }
  const isDraft = S.settings.draft?.id === p.id;
  const work = isDraft ? p : structuredClone(p); // 已存在的编辑基于副本，保存时落盘

  box.innerHTML = "";
  const header = el(`<div class="pd-header">
      <span class="pd-name">${esc(work.name || "新供应商")}</span>
      <span class="pd-badge${work.enabled ? " on" : ""}" id="pd-toggle">${work.enabled ? "已启用" : "已禁用"}</span>
      ${work.builtin ? "" : `<span class="icon-btn pd-del" id="pd-del" title="删除">🗑</span>`}
    </div>`);
  box.appendChild(header);
  header.querySelector("#pd-toggle").onclick = () => {
    work.enabled = !work.enabled;
    header.querySelector("#pd-toggle").className = `pd-badge${work.enabled ? " on" : ""}`;
    header.querySelector("#pd-toggle").textContent = work.enabled ? "已启用" : "已禁用";
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
    renderProviderDetail();
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

  // API Key：环境变量 / 手动
  box.appendChild(el(`<label>API Key</label>`));
  const seg = el(`<div class="seg">
      <span class="${work.keyMode === "env" ? "on" : ""}" data-m="env">环境变量</span>
      <span class="${work.keyMode === "manual" ? "on" : ""}" data-m="manual">手动填写</span>
    </div>`);
  box.appendChild(seg);
  const keyArea = el(`<div></div>`);
  box.appendChild(keyArea);
  const renderKeyArea = () => {
    if (work.keyMode === "env") {
      keyArea.innerHTML = `<div class="env-hint${S.envKeyPresent ? " ok" : ""}">
        使用环境变量 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY —— 当前${S.envKeyPresent ? "已检测到 ✓" : "未检测到，启动应用前请先设置"}</div>`;
    } else {
      keyArea.innerHTML = "";
      const row = el(`<div class="key-row">
          <input type="password" placeholder="输入 API Key" value="${esc(work.apiKey ?? "")}" />
          <span class="icon-btn" title="显示/隐藏">👁</span>
        </div>`);
      const inp = row.querySelector("input");
      inp.oninput = () => (work.apiKey = inp.value.trim());
      row.querySelector(".icon-btn").onclick = () => {
        inp.type = inp.type === "password" ? "text" : "password";
      };
      keyArea.appendChild(row);
    }
  };
  seg.querySelectorAll("span").forEach((sp) => {
    sp.onclick = () => {
      work.keyMode = sp.dataset.m;
      seg.querySelectorAll("span").forEach((x) => x.classList.toggle("on", x === sp));
      renderKeyArea();
    };
  });
  renderKeyArea();

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
