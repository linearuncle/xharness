/* Mermaid 图渲染：主进程 marked 把 ```mermaid 围栏输出为 <pre class="mermaid"> 占位块
 * （见 main.js mermaidExt），段落定稿后这里懒加载 vendor 的 mermaid ESM 构建绘成 SVG。
 * 渲染失败保留代码块原样；深浅主题切换时按已存源码重渲。 */
(function () {
  let mermaidP = null; // 首次遇到占位块才加载（构建按图类型再懒加载各自 chunk）
  let seq = 0;
  let lastTheme = null;

  const isDark = () => document.documentElement.dataset.theme === "dark";
  // securityLevel strict：标签一律按纯文本处理，不引入额外 HTML 注入面。
  // htmlLabels 关闭：默认标签走 foreignObject 内嵌 HTML，会被 DOMPurify 的 svg
  // profile 剥掉导致节点无字；关掉后标签用纯 SVG <text> 渲染（flowchart.htmlLabels
  // 已废弃，须用全局开关）。
  const config = () => ({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark() ? "dark" : "default",
    htmlLabels: false,
  });

  function load() {
    if (!mermaidP) {
      mermaidP = import("./vendor/mermaid/mermaid.esm.min.mjs").then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize(config());
        lastTheme = document.documentElement.dataset.theme;
        return mermaid;
      });
    }
    return mermaidP;
  }

  // 返回消毒后的 SVG 字符串；失败返回 null
  async function draw(mermaid, src) {
    const id = `mmd-${Date.now()}-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      // mermaid 的样式内联在 SVG 内的 <style>，svg profile 需补 style 标签
      return DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ["style"],
      });
    } catch {
      document.getElementById(`d${id}`)?.remove(); // mermaid 失败时残留在 body 的错误节点
      return null;
    }
  }

  // 把 root 下所有占位块替换成 SVG；语法错误保留代码块并标记
  async function renderIn(root) {
    const blocks = root.querySelectorAll("pre.mermaid");
    if (!blocks.length) return;
    const mermaid = await load();
    for (const pre of blocks) {
      const src = pre.textContent;
      const svg = await draw(mermaid, src);
      if (svg === null) {
        pre.classList.add("mermaid-error");
        continue;
      }
      const div = document.createElement("div");
      div.className = "mermaid-diagram";
      div.dataset.mermaidSrc = src; // 主题切换重渲用
      div.innerHTML = svg;
      pre.replaceWith(div);
    }
  }

  // 深浅切换：重初始化主题并按已存源码重渲所有图
  new MutationObserver(() => {
    const theme = document.documentElement.dataset.theme;
    if (theme === lastTheme || !mermaidP) return;
    lastTheme = theme;
    const diagrams = document.querySelectorAll(".mermaid-diagram[data-mermaid-src]");
    if (!diagrams.length) return;
    mermaidP.then((mermaid) => {
      mermaid.initialize(config());
      diagrams.forEach(async (div) => {
        const svg = await draw(mermaid, div.dataset.mermaidSrc);
        if (svg !== null) div.innerHTML = svg;
      });
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  window.MermaidUI = { renderIn };
})();
