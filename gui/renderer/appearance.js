/* 设置 → 外观 页面：主题模式卡片 + 当前变体的主题编辑器
 * 数据流：所有修改先落 state（appearance 对象）→ Theme.apply 即时预览 → api.setAppearance 持久化 */

(() => {
  const $ = (id) => document.getElementById(id);
  const T = () => window.Theme;

  let A = null; // appearance state（boot 时注入）
  let onChanged = null;

  const esc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  async function save() {
    T().apply(A);
    await window.api.setAppearance(A);
    onChanged?.(A);
  }

  // 编辑器操作的变体：明确选浅/深就编辑那套；跟随系统时编辑当前生效的那套
  const editVariant = () => T().effectiveVariant(A);

  /* ---------- 主题模式预览卡 ---------- */

  // 迷你窗口 mockup：侧栏 + 内容线条；split 模式左深右浅
  function previewCard(kind, label) {
    const card = el(`<div class="ap-mode-card" data-mode="${kind}">
        <div class="ap-preview ${kind}">
          <div class="ap-pv-half light"><div class="ap-pv-sb"></div><div class="ap-pv-body">
            <i></i><i class="w2"></i><i></i><i class="w3"></i><i class="w2"></i></div></div>
          <div class="ap-pv-half dark"><div class="ap-pv-sb"></div><div class="ap-pv-body">
            <i></i><i class="w2"></i><i></i><i class="w3"></i><i class="w2"></i></div></div>
        </div>
        <div class="ap-mode-label">${esc(label)}</div>
      </div>`);
    card.onclick = async () => {
      A.mode = kind === "system" ? "system" : kind;
      await save();
      render(); // 生效变体可能变化，编辑器整体重绘
    };
    return card;
  }

  /* ---------- 预设下拉 ---------- */

  function presetName(id) {
    if (id === "custom") return "自定义";
    return T().PRESETS.find((p) => p.id === id)?.name ?? "自定义";
  }

  function presetMenu(anchor, variant) {
    document.querySelector(".ap-preset-menu")?.remove();
    const menu = el(`<div class="ap-preset-menu"></div>`);
    for (const p of T().PRESETS) {
      const c = p[variant];
      const row = el(`<div class="ap-preset-row">
          <span class="ap-aa" style="background:${esc(c.background)};color:${esc(c.accent)};border:1px solid ${esc(T().mixColor(c.background, c.foreground, 0.18))}">Aa</span>
          <span>${esc(p.name)}</span>
          <span class="ap-check">${A[variant].preset === p.id ? "✓" : ""}</span>
        </div>`);
      row.onclick = async () => {
        menu.remove();
        A[variant] = { ...A[variant], preset: p.id, ...p[variant] };
        await save();
        render();
      };
      menu.appendChild(row);
    }
    anchor.parentElement.appendChild(menu);
    setTimeout(() =>
      document.addEventListener("mousedown", function close(e) {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener("mousedown", close);
        }
      })
    );
  }

  /* ---------- 编辑器行 ---------- */

  function colorRow(label, variant, key) {
    const val = A[variant][key];
    const dark = T().isDarkColor(val);
    const row = el(`<div class="ap-row">
        <span class="ap-row-label">${esc(label)}</span>
        <span class="spacer"></span>
        <label class="ap-color-pill" style="background:${esc(val)};color:${dark ? "#fff" : "#1a1a1a"}">
          <input type="color" value="${esc(val)}" />
          <span class="ap-swatch"></span>
          <input type="text" class="ap-hex" value="${esc(val.toUpperCase())}" spellcheck="false" />
        </label>
      </div>`);
    const pill = row.querySelector(".ap-color-pill");
    const picker = row.querySelector(`input[type="color"]`);
    const hex = row.querySelector(".ap-hex");
    const commit = async (v) => {
      if (!/^#[0-9a-f]{6}$/i.test(v)) { hex.value = A[variant][key].toUpperCase(); return; }
      A[variant][key] = v.toLowerCase();
      A[variant].preset = "custom"; // 手动改色即脱离预设
      pill.style.background = v;
      pill.style.color = T().isDarkColor(v) ? "#fff" : "#1a1a1a";
      picker.value = v;
      hex.value = v.toUpperCase();
      await save();
      renderHeader(); // 预设名可能变为「自定义」
    };
    picker.oninput = () => commit(picker.value);
    hex.onchange = () => commit(hex.value.trim().startsWith("#") ? hex.value.trim() : "#" + hex.value.trim());
    return row;
  }

  function textRow(label, variant, key, placeholder) {
    const row = el(`<div class="ap-row">
        <span class="ap-row-label">${esc(label)}</span>
        <span class="spacer"></span>
        <input type="text" class="ap-text" placeholder="${esc(placeholder)}" value="${esc(A[variant][key] ?? "")}" spellcheck="false" />
      </div>`);
    const inp = row.querySelector("input");
    inp.onchange = async () => {
      A[variant][key] = inp.value.trim();
      await save();
    };
    return row;
  }

  function toggleRow(label, variant, key) {
    const on = !!A[variant][key];
    const row = el(`<div class="ap-row">
        <span class="ap-row-label">${esc(label)}</span>
        <span class="spacer"></span>
        <span class="ap-toggle${on ? " on" : ""}"><span class="knob"></span></span>
      </div>`);
    const t = row.querySelector(".ap-toggle");
    t.onclick = async () => {
      A[variant][key] = !A[variant][key];
      t.classList.toggle("on", A[variant][key]);
      await save();
    };
    return row;
  }

  function sliderRow(label, variant, key) {
    const val = A[variant][key] ?? 50;
    const row = el(`<div class="ap-row">
        <span class="ap-row-label">${esc(label)}</span>
        <span class="spacer"></span>
        <input type="range" class="ap-slider" min="0" max="100" step="1" value="${val}" />
        <span class="ap-slider-val">${val}</span>
      </div>`);
    const slider = row.querySelector("input");
    const valEl = row.querySelector(".ap-slider-val");
    const paint = () => slider.style.setProperty("--fill", slider.value + "%");
    paint();
    slider.oninput = () => {
      valEl.textContent = slider.value;
      paint();
      A[variant][key] = +slider.value;
      T().apply(A); // 拖动即时预览，松手才落盘
    };
    slider.onchange = async () => {
      A[variant][key] = +slider.value;
      await save();
    };
    return row;
  }

  /* ---------- 导入 / 复制 ---------- */

  const THEME_KEYS = ["accent", "background", "foreground", "uiFont", "codeFont", "translucentSidebar", "contrast"];

  async function copyTheme(variant, msgEl) {
    const out = {};
    for (const k of THEME_KEYS) out[k] = A[variant][k];
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    msgEl.textContent = "已复制 ✓";
    setTimeout(() => (msgEl.textContent = ""), 1600);
  }

  async function importTheme(variant, msgEl) {
    let obj;
    try {
      obj = JSON.parse(await navigator.clipboard.readText());
    } catch {
      msgEl.textContent = "剪贴板不是有效的主题 JSON";
      setTimeout(() => (msgEl.textContent = ""), 2400);
      return;
    }
    const next = { ...A[variant], preset: "custom" };
    for (const k of THEME_KEYS) if (obj[k] !== undefined) next[k] = obj[k];
    A[variant] = next;
    await save();
    render();
    msgEl.textContent = "已导入 ✓";
    setTimeout(() => (msgEl.textContent = ""), 1600);
  }

  /* ---------- 渲染 ---------- */

  function renderHeader() {
    const variant = editVariant();
    const head = $("ap-editor-head");
    if (!head) return;
    head.innerHTML = `
      <span class="ap-editor-title">${variant === "dark" ? "深色主题" : "浅色主题"}</span>
      <span class="spacer"></span>
      <span class="ap-msg" id="ap-msg"></span>
      <span class="ap-link" id="ap-import">导入</span>
      <span class="ap-link" id="ap-copy">复制主题</span>
      <span class="ap-preset-btn" id="ap-preset-btn">
        <span class="ap-aa" style="background:${esc(A[variant].background)};color:${esc(A[variant].accent)}">Aa</span>
        ${esc(presetName(A[variant].preset))} <span class="chev">▾</span>
      </span>`;
    $("ap-import").onclick = () => importTheme(variant, $("ap-msg"));
    $("ap-copy").onclick = () => copyTheme(variant, $("ap-msg"));
    $("ap-preset-btn").onclick = (e) => presetMenu(e.currentTarget, variant);
  }

  function render() {
    const page = $("set-page-appearance");
    if (!page || !A) return;
    page.innerHTML = `
      <h1>外观</h1>
      <div class="ap-section-label">主题</div>
      <div class="ap-mode-cards" id="ap-mode-cards"></div>
      <div class="ap-editor" id="ap-editor">
        <div class="ap-editor-head" id="ap-editor-head"></div>
        <div class="ap-editor-body" id="ap-editor-body"></div>
      </div>`;

    const cards = $("ap-mode-cards");
    for (const [kind, label] of [["system", "系统"], ["light", "浅色"], ["dark", "深色"]]) {
      const c = previewCard(kind, label);
      if (A.mode === kind) c.classList.add("active");
      cards.appendChild(c);
    }

    renderHeader();
    const variant = editVariant();
    const body = $("ap-editor-body");
    body.appendChild(colorRow("强调色", variant, "accent"));
    body.appendChild(colorRow("背景", variant, "background"));
    body.appendChild(colorRow("前景", variant, "foreground"));
    body.appendChild(textRow("UI 字体", variant, "uiFont", T().DEFAULT_UI_FONT));
    body.appendChild(textRow("代码字体", variant, "codeFont", T().DEFAULT_CODE_FONT));
    body.appendChild(toggleRow("半透明侧栏", variant, "translucentSidebar"));
    body.appendChild(sliderRow("对比度", variant, "contrast"));
  }

  window.Appearance = {
    init(appearance, changedCb) {
      A = appearance;
      onChanged = changedCb;
    },
    get: () => A,
    render,
  };
})();
