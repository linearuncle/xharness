/* 外观主题引擎：预设库 + 派生色计算 + 全局 CSS 变量应用
 * 一套主题只存三个基色（背景/前景/强调）+ 对比度，其余界面色一律由
 * mixColor(背景, 前景, t) 推导——任何预设/自定义配色天然同时支持浅深两向。 */

// 每个预设：浅/深两套 {accent, background, foreground}
const THEME_PRESETS = [
  { id: "codex", name: "Codex",
    light: { accent: "#2563eb", background: "#ffffff", foreground: "#1a1a1a" },
    dark: { accent: "#339cff", background: "#181818", foreground: "#ffffff" } },
  { id: "ayu", name: "Ayu",
    light: { accent: "#ffaa33", background: "#fcfcfc", foreground: "#5c6166" },
    dark: { accent: "#e6b450", background: "#0b0e14", foreground: "#bfbdb6" } },
  { id: "catppuccin", name: "Catppuccin",
    light: { accent: "#8839ef", background: "#eff1f5", foreground: "#4c4f69" },
    dark: { accent: "#cba6f7", background: "#1e1e2e", foreground: "#cdd6f4" } },
  { id: "dracula", name: "Dracula",
    light: { accent: "#9b59d0", background: "#f8f8f2", foreground: "#282a36" },
    dark: { accent: "#bd93f9", background: "#282a36", foreground: "#f8f8f2" } },
  { id: "everforest", name: "Everforest",
    light: { accent: "#8da101", background: "#fdf6e3", foreground: "#5c6a72" },
    dark: { accent: "#a7c080", background: "#2d353b", foreground: "#d3c6aa" } },
  { id: "github", name: "GitHub",
    light: { accent: "#0969da", background: "#ffffff", foreground: "#1f2328" },
    dark: { accent: "#4493f8", background: "#0d1117", foreground: "#e6edf3" } },
  { id: "gruvbox", name: "Gruvbox",
    light: { accent: "#d79921", background: "#fbf1c7", foreground: "#3c3836" },
    dark: { accent: "#fabd2f", background: "#282828", foreground: "#ebdbb2" } },
  { id: "linear", name: "Linear",
    light: { accent: "#5e6ad2", background: "#ffffff", foreground: "#282a30" },
    dark: { accent: "#7c85e0", background: "#191a23", foreground: "#eeeffc" } },
  { id: "nord", name: "Nord",
    light: { accent: "#5e81ac", background: "#eceff4", foreground: "#2e3440" },
    dark: { accent: "#88c0d0", background: "#2e3440", foreground: "#d8dee9" } },
  { id: "notion", name: "Notion",
    light: { accent: "#2eaadc", background: "#ffffff", foreground: "#37352f" },
    dark: { accent: "#529cca", background: "#191919", foreground: "#e6e6e5" } },
  { id: "one", name: "One",
    light: { accent: "#4078f2", background: "#fafafa", foreground: "#383a42" },
    dark: { accent: "#61afef", background: "#282c34", foreground: "#abb2bf" } },
  { id: "solarized", name: "Solarized",
    light: { accent: "#268bd2", background: "#fdf6e3", foreground: "#657b83" },
    dark: { accent: "#268bd2", background: "#002b36", foreground: "#93a1a1" } },
  { id: "tokyo-night", name: "Tokyo Night",
    light: { accent: "#2e7de9", background: "#e1e2e7", foreground: "#3760bf" },
    dark: { accent: "#7aa2f7", background: "#1a1b26", foreground: "#c0caf5" } },
];

const DEFAULT_UI_FONT = `-apple-system, "PingFang SC", "Helvetica Neue", sans-serif`;
const DEFAULT_CODE_FONT = `"SF Mono", ui-monospace, Menlo, Consolas, monospace`;

/* ---------- 颜色工具 ---------- */

function parseHex(hex) {
  const m = String(hex ?? "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) =>
  "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

// a 向 b 混合 t（0..1）
function mixColor(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  if (!pa || !pb) return a;
  return toHex(pa.map((v, i) => v + (pb[i] - v) * t));
}

function isDarkColor(hex) {
  const p = parseHex(hex);
  if (!p) return false;
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 128;
}

function rgba(hex, alpha) {
  const p = parseHex(hex);
  if (!p) return hex;
  return `rgba(${p[0]},${p[1]},${p[2]},${alpha})`;
}

/* ---------- 主题应用 ---------- */

function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// mode + 系统偏好 → 当前生效的变体名
function effectiveVariant(appearance) {
  if (appearance.mode === "light") return "light";
  if (appearance.mode === "dark") return "dark";
  return systemPrefersDark() ? "dark" : "light";
}

/** 由三基色 + 对比度推导全套界面变量并写到 :root。
 *  contrast（0-100，50 为基准）整体缩放次级文字/边框与背景的距离。 */
function applyTheme(t) {
  const bg = parseHex(t.background) ? t.background : "#ffffff";
  const fg = parseHex(t.foreground) ? t.foreground : "#1a1a1a";
  const accent = parseHex(t.accent) ? t.accent : "#2563eb";
  const dark = isDarkColor(bg);
  const k = (Number.isFinite(+t.contrast) ? +t.contrast : 50) / 100; // 0..1

  const v = {
    "--bg": bg,
    "--text": fg,
    "--accent": accent,
    "--text-2": mixColor(bg, fg, 0.52 + 0.3 * k),
    "--text-3": mixColor(bg, fg, 0.3 + 0.24 * k),
    "--border": mixColor(bg, fg, 0.06 + 0.09 * k),
    "--card-border": mixColor(bg, fg, 0.07 + 0.09 * k),
    "--hover": mixColor(bg, fg, 0.04 + 0.05 * k),
    "--active": mixColor(bg, fg, 0.07 + 0.07 * k),
    "--sb-bg": mixColor(bg, fg, dark ? 0.035 : 0.028),
    "--panel": dark ? mixColor(bg, fg, 0.05) : bg, // 浮层/卡片：深色下略抬升
    "--bubble": mixColor(bg, fg, 0.055 + 0.03 * k),
    "--code-bg": mixColor(bg, fg, dark ? 0.07 : 0.045),
    "--inline-code-bg": mixColor(bg, fg, 0.07 + 0.03 * k),
    "--btn-primary-bg": fg,
    "--btn-primary-fg": bg,
    "--link": accent,
    "--accent-soft": rgba(accent, dark ? 0.28 : 0.16),
    "--shadow": dark ? "rgba(0,0,0,.5)" : "rgba(0,0,0,.1)",
    "--font-ui": (t.uiFont ?? "").trim() || DEFAULT_UI_FONT,
    "--font-code": (t.codeFont ?? "").trim() || DEFAULT_CODE_FONT,
  };
  const root = document.documentElement;
  for (const [key, val] of Object.entries(v)) root.style.setProperty(key, val);
  root.dataset.theme = dark ? "dark" : "light";

  // 代码高亮：浅/深 hljs 主题二选一
  const lightCss = document.getElementById("hljs-light");
  const darkCss = document.getElementById("hljs-dark");
  if (lightCss && darkCss) {
    lightCss.disabled = dark;
    darkCss.disabled = !dark;
  }

  // 半透明侧栏：macOS vibrancy 透出桌面；主进程切 vibrancy，这里控制透明层
  const translucent = !!t.translucentSidebar;
  root.classList.toggle("translucent-sb", translucent);
  root.style.setProperty("--sb-bg-translucent", rgba(v["--sb-bg"], dark ? 0.55 : 0.6));
  window.api.setVibrancy?.(translucent);
}

/* ---------- 对外接口（appearance.js / app.js 使用） ---------- */

window.Theme = {
  PRESETS: THEME_PRESETS,
  DEFAULT_UI_FONT,
  DEFAULT_CODE_FONT,
  mixColor,
  isDarkColor,
  effectiveVariant,
  // 全量应用当前外观（含跟随系统的深浅切换）
  apply(appearance) {
    applyTheme(appearance[effectiveVariant(appearance)]);
  },
  // 监听系统深浅变化（mode=system 时实时切换）
  watchSystem(getAppearance) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const a = getAppearance();
      if (a.mode === "system") window.Theme.apply(a);
    });
  },
};
