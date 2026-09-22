/*!
 * edcity-video.js — chapter / summary / mind-map panel for Kaltura players
 * that the host page has ALREADY embedded.
 * v3.0.2
 *
 * WHAT CHANGED FROM v2.4.0 — read this first
 * ------------------------------------------
 * v1 and v2 both required the client to paste a <div class="edcity-video">
 * into their page, and THIS library booted the Kaltura player itself.
 * v3 does neither.
 *
 *   • NO <div>, ever. The client's page is untouched.
 *   • The library does NOT create a player. It finds the players the page
 *     has already booted (kWidget / mwEmbed iframe embeds, or Playkit) and
 *     attaches a "Jump to section" button directly underneath each one.
 *   • All content — title, summary, chapters, mind map — arrives as a JSON
 *     file fetched at runtime. One JSON per video per language.
 *
 * The client integrates ONCE, with one line in their template:
 *
 *   <script src="https://<their-host>/edcity-video.js"
 *           data-json="/ai/1_9y0e8yhx_en.json, /ai/1_gbb3po1d_en.json"
 *           defer></script>
 *
 * After that, a new video = a new JSON file on their server. No code change,
 * no redeploy of this library, no HTML edit.
 *
 * HOW A JSON FINDS ITS PLAYER
 * ---------------------------
 * Every JSON carries a "target" block. Matching is tried in this order and
 * stops at the first hit:
 *
 *   1. target.player  — the DOM id of the player container on their page,
 *                       e.g. "kaltura_player_1774513917167".   ← most exact
 *   2. target.entry   — the Kaltura entry id, e.g. "1_9y0e8yhx". The library
 *                       asks each player what it is playing and matches.
 *                       ← most robust: survives a page rebuild
 *   3. target.index   — 0-based position of the player on the page.
 *   4. If the page has exactly one player and exactly one JSON, they pair.
 *
 * Supplying BOTH player and entry is recommended: player is exact, entry is
 * the fallback if their CMS ever regenerates the container id.
 *
 * JSON SHAPE (identical content model to v1/v2 — only the wrapper is new):
 *
 *   {
 *     "target":  { "player": "kaltura_player_1774513917167",
 *                  "entry":  "1_9y0e8yhx" },
 *     "lang":    "en",                       // en | zh-hant | zh-hans | auto
 *     "title":   "...",                      // optional, shown above the button
 *     "summary": "...",
 *     "mindmap": "graph LR\n ...",           // Mermaid source, optional
 *     "chapters": [ { "label": "...", "t": "00:01:45", "brief": "...",
 *                     "children": [ { "label": "...", "t": "00:01:58" } ] } ],
 *     "options": { "closeOnSeek": true }     // optional per-video overrides
 *   }
 *
 * SUPPORTED PLAYERS
 * -----------------
 *   • kWidget / mwEmbed iframe embeds  (what hkedcity.net runs today:
 *     div.kWidgetIframeContainer#kaltura_player_<ts> with sendNotification/
 *     evaluate/kBind on the element)
 *   • Kaltura Playkit V7 (window.KalturaPlayer.getPlayers())
 *   • Plain <video> as a last resort
 *
 * No build step, no dependencies, safe to load more than once, safe to load
 * before or after the players boot.
 */
(function () {
  'use strict';

  if (window.EdCityVideo && window.EdCityVideo.__loaded) return; // idempotent

  // ===================================================================
  // Defaults — override globally by defining window.EDCITY_VIDEO_DEFAULTS
  // before this script, or per-video with an "options" block inside the JSON.
  // ===================================================================
  var DEFAULTS = {
    // v3 does NOT boot a player, so there is no partnerId / uiConfId here.
    // Those belong to the host page's own embed code.
    playerWaitMs: 12000,    // how long to wait for the page's players to become drivable
    autoplayOnSeek: true,   // start playing when a chapter is clicked
    scrollIntoView: true,   // bring the player into view on seek
    expandDepth: 1,         // 1 = chapters closed, 2 = sub-segments visible
    highlight: true,        // highlight the chapter currently playing
    deepLink: false,        // reflect the current chapter in the URL hash
    autoDark: false,        // true = follow the visitor's OS dark-mode setting
    drawerOpen: false,      // true = the panel starts open on load
    closeOnSeek: true,      // true = clicking a chapter/mind-map node closes the panel
    drawerWidth: 400,       // px width of the panel on desktop
    drawerBreakpoint: 680,  // px viewport width below which the panel goes full-screen
    drawerResizable: true,  // true = the visitor can drag the panel's left edge to resize it
    drawerMinWidth: 280,    // px — how narrow a visitor can drag the panel
    drawerMaxWidth: 900,    // px — how wide a visitor can drag the panel
    mindmapHeight: 620,     // px height of the scrollable mind-map viewport
    mindmapMinZoom: 0.15,   // furthest OUT the mind map can ever be zoomed (x natural size) — an absolute floor
    // v2.4 — the zoom-IN ceiling is no longer a fixed multiple of the diagram's natural size
    // (that made the +/- buttons feel unpredictable: how many clicks that took to actually
    // reach depended entirely on how small "Fit" happened to compute for a given diagram/
    // screen). It's now defined relative to whatever "Fit" currently shows: a fixed number of
    // + clicks (mindmapZoomSteps) above the fit size, each click multiplying by mindmapZoomStep.
    // Re-fitting (the Fit button, opening the tab, or entering/exiting full-screen) recomputes
    // both "fit" and the max from it, so full-screen — where fit is naturally bigger — gets a
    // bigger max too, without the cap ever taking more or fewer than mindmapZoomSteps clicks.
    mindmapZoomStep: 1.6,   // how much each +/- click multiplies the current zoom by
    mindmapZoomSteps: 3,    // how many + clicks past "Fit" reaches the zoom-in cap
    // Only fetched when an embed actually supplies a "mindmap". Point this at a
    // self-hosted copy if your network blocks the CDN.
    mermaidUrl: 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
    lang: 'auto'            // 'auto' | 'en' | 'zh-hant' | 'zh-hans'
  };

  var UI = {
    'en': {
      jump: 'Jump to section', summary: 'Summary', expand: 'Expand all', collapse: 'Collapse all',
      loading: 'Loading player…', error: 'This video could not be loaded.',
      tabChapters: 'Chapters', tabMindmap: 'Mind map', drawing: 'Drawing mind map…',
      mmError: 'The mind map could not be drawn.', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
      zoomReset: 'Fit', full: 'Full screen', exitFull: 'Exit full screen',
      hint: 'Click any node with a timestamp to jump there.',
      unit: 'chapters', unit1: 'chapter', close: 'Close',
      resize: 'Drag to resize the panel',
      zoomMaxed: 'Maximum zoom reached', zoomMinned: 'Minimum zoom reached'
    },
    'zh-hant': {
      jump: '跳至章節', summary: '內容摘要', expand: '全部展開', collapse: '全部收起',
      loading: '正在載入播放器…', error: '無法載入此影片。',
      tabChapters: '章節', tabMindmap: '腦圖', drawing: '正在繪製腦圖…',
      mmError: '無法繪製腦圖。', zoomIn: '放大', zoomOut: '縮小',
      zoomReset: '適應寬度', full: '全螢幕', exitFull: '退出全螢幕',
      hint: '點擊帶時間碼的節點即可跳至該處。',
      unit: '章節', unit1: '章節', close: '關閉',
      resize: '拖曳以調整面板闊度',
      zoomMaxed: '已達最大縮放', zoomMinned: '已達最小縮放'
    },
    'zh-hans': {
      jump: '跳至章节', summary: '内容摘要', expand: '全部展开', collapse: '全部收起',
      loading: '正在载入播放器…', error: '无法载入此视频。',
      tabChapters: '章节', tabMindmap: '思维导图', drawing: '正在绘制思维导图…',
      mmError: '无法绘制思维导图。', zoomIn: '放大', zoomOut: '缩小',
      zoomReset: '适应宽度', full: '全屏', exitFull: '退出全屏',
      hint: '点击带时间码的节点即可跳至该处。',
      unit: '章节', unit1: '章节', close: '关闭',
      resize: '拖动以调整面板宽度',
      zoomMaxed: '已达最大缩放', zoomMinned: '已达最小缩放'
    }
  };

  var cfg = merge(DEFAULTS, window.EDCITY_VIDEO_DEFAULTS || {});
  var scriptPromises = {};
  var instances = [];
  var seq = 0;
  var lockCount = 0; // how many drawers are currently open (for the body scroll lock)

  // ===================================================================
  // Helpers
  // ===================================================================
  function merge(a, b) {
    var out = {}, k;
    for (k in a) if (has(a, k)) out[k] = a[k];
    for (k in b) if (has(b, k)) out[k] = b[k];
    return out;
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Characters that exist in only one of the two written forms. Counting them
  // is enough to tell Hong Kong/Taiwan Traditional from Mainland Simplified.
  var TRAD = '們個這學習語講點數為與時體證現觀題開關聲書寫讀聽說話錯過應該無電腦網絡機構經濟業務員專還會東龍車馬鳥魚門長風飛見貝頁韋齊齒龜實對樣種類難隨陽陰際離雜靜願顯驗導總結標準級織緊縮續練輕轉軟輪較輸農遠適選遞邊達違遲遷郵鄉鄰醫釋鐘鑑閉問聞閱陣險陸雞雙靈韓駕騎驚';
  var SIMP = '们个这学习语讲点数为与时体证现观题开关声书写读听说话错过应该无电脑网络机构经济业务员专还会东龙车马鸟鱼门长风飞见贝页韦齐齿龟实对样种类难随阳阴际离杂静愿显验导总结标准级织紧缩续练轻转软轮较输农远适选递边达违迟迁邮乡邻医释钟鉴闭问闻阅阵险陆鸡双灵韩驾骑惊';

  /** Which UI language does this embed's OWN content read as? */
  function detectLang(data) {
    var text = [data.title, data.summary, data.mindmap].join(' ');
    (function walk(list) {
      (list || []).forEach(function (c) {
        text += ' ' + (c.label || '') + ' ' + (c.brief || '');
        walk(c.children);
      });
    })(data.chapters);

    var cjk = text.match(/[㐀-䶿一-鿿豈-﫿]/g);
    if (!cjk || !cjk.length) return 'en';   // no Han characters at all

    var trad = 0, simp = 0;
    for (var i = 0; i < text.length; i++) {
      if (TRAD.indexOf(text[i]) > -1) trad++;
      else if (SIMP.indexOf(text[i]) > -1) simp++;
    }
    return simp > trad ? 'zh-hans' : 'zh-hant';   // tie favours Traditional
  }

  /**
   * UI language, most explicit wins:
   *   1. data-lang on the embed
   *   2. EDCITY_VIDEO_DEFAULTS.lang, if it is not 'auto'
   *   3. the embed's own content  <-- so an English video on a Chinese page,
   *                                  or the reverse, still labels correctly
   *   4. the page's <html lang>
   *   5. English
   */
  function strings(lang, data) {
    if (lang && lang !== 'auto' && UI[lang]) return UI[lang];
    if (data) {
      var byContent = detectLang(data);
      if (byContent) return UI[byContent];
    }
    var d = (document.documentElement.getAttribute('lang') || 'en').toLowerCase();
    if (d.indexOf('zh') === 0) {
      return (d.indexOf('hans') > -1 || d.indexOf('cn') > -1 || d.indexOf('sg') > -1) ? UI['zh-hans'] : UI['zh-hant'];
    }
    return UI.en;
  }

  /**
   * Accepts 90, "90", "1:30", "01:30", "00:01:30", "00:01:30,500", "00:01:30.500"
   * Returns seconds as a Number, or null if unparseable.
   */
  function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? v : null;
    var s = String(v).trim().replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var parts = s.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var n = parseFloat(parts[i]);
      if (!isFinite(n)) return null;
      total = total * 60 + n;
    }
    return total;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600),
        m = Math.floor((sec % 3600) / 60),
        s = sec % 60,
        pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function boolAttr(root, name, fallback) {
    var v = root.getAttribute(name);
    if (v == null) return fallback;
    v = v.toLowerCase();
    return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
  }

  function loadScript(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  }

  function lockScroll() {
    lockCount++;
    if (lockCount === 1) document.documentElement.classList.add('edc-drawer-lock');
  }
  function unlockScroll() {
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) document.documentElement.classList.remove('edc-drawer-lock');
  }

  // Remembers a visitor's dragged panel width across page loads, site-wide.
  // Wrapped in try/catch: some browsers throw just for touching localStorage
  // (locked-down privacy modes), and that must never break the embed.
  var WIDTH_KEY = 'edcityVideoDrawerWidth';
  function loadSavedWidth() {
    try {
      var v = window.localStorage && window.localStorage.getItem(WIDTH_KEY);
      var n = v ? parseInt(v, 10) : NaN;
      return isFinite(n) && n > 0 ? n : null;
    } catch (e) { return null; }
  }
  function saveWidth(px) {
    try { if (window.localStorage) window.localStorage.setItem(WIDTH_KEY, String(Math.round(px))); }
    catch (e) { /* private browsing, storage disabled, quota — harmless to skip */ }
  }

  /** Every focusable element currently inside a container, in DOM order. */
  function focusables(container) {
    var sel = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea';
    return Array.prototype.slice.call(container.querySelectorAll(sel))
      .filter(function (n) { return n.offsetParent !== null; });
  }


  /**
   * Normalises whatever shape the data arrives in into:
   *   { title, summary, chapters:[ {label, start, end, brief, children:[...] } ] }
   * Tolerates several key spellings so the analysis output can be pasted
   * with minimal massaging: t/time/start/timeInSeconds, label/title/name,
   * children/sub/subs/segments/micro.
   */
  function normalise(data) {
    data = data || {};
    var list = data.chapters || data.timestamps || data.sections || data.items || [];
    if (!Array.isArray(list)) list = [];
    return {
      title: data.title || data.videoTitle || '',
      summary: data.summary || data.description || '',
      mindmap: typeof data.mindmap === 'string' ? data.mindmap
             : (data.mindmap && data.mindmap.code) ? data.mindmap.code : '',
      chapters: list.map(normChapter).filter(Boolean)
    };
  }

  function normChapter(c) {
    if (!c || typeof c !== 'object') return null;
    var start = parseTime(
      has(c, 't') ? c.t :
      has(c, 'time') ? c.time :
      has(c, 'start') ? c.start :
      has(c, 'timeInSeconds') ? c.timeInSeconds :
      has(c, 'seconds') ? c.seconds : null
    );
    if (start == null) return null;
    var kids = c.children || c.sub || c.subs || c.segments || c.micro || c.microSegments || [];
    if (!Array.isArray(kids)) kids = [];
    return {
      label: String(c.label || c.title || c.name || formatTime(start)),
      start: start,
      end: parseTime(has(c, 'end') ? c.end : (has(c, 'endTime') ? c.endTime : null)),
      brief: c.brief || c.note || c.description || '',
      children: kids.map(normChapter).filter(Boolean)
    };
  }

  /** Flattens the tree in playback order so we can resolve "what's playing now". */
  function flatten(chapters, out, depth) {
    out = out || []; depth = depth || 0;
    chapters.forEach(function (c) {
      out.push({ node: c, depth: depth });
      if (c.children.length) flatten(c.children, out, depth + 1);
    });
    return out;
  }

  // ===================================================================
  // Styles — injected once, all selectors namespaced .edc-*
  // Themeable from the host page via the CSS custom properties below.
  // ===================================================================
  var CSS = [
    '.edc{--edc-accent:#2563eb;--edc-accent-soft:#eff6ff;--edc-text:#1f2937;--edc-muted:#6b7280;',
    '--edc-border:#e5e7eb;--edc-bg:#fff;--edc-radius:10px;',
    'font-family:inherit;color:var(--edc-text);background:var(--edc-bg);border:1px solid var(--edc-border);',
    'border-radius:var(--edc-radius);overflow:hidden;margin:0 0 2rem;box-sizing:border-box}',
    '.edc *,.edc *:before,.edc *:after{box-sizing:inherit}',
    // v3: the strip injected under the host page's player is NOT a card. No
    // background, no border, no title — the page already frames the video and
    // prints its title. Just the button, sitting in their layout.
    '.edc.edc-mount{background:none;border:0;border-radius:0;overflow:visible;margin:0;padding:0}',
    '.edc-mount .edc-toolbar{margin:.625rem 0 1.25rem}',
    '.edc-title{margin:0;padding:1rem 1.25rem;font-size:1.0625rem;line-height:1.45;font-weight:700;',
    'border-bottom:1px solid var(--edc-border);background:#f9fafb}',
    '.edc-body{padding:1.25rem}',
    '.edc-stage{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden}',
    '.edc-stage>div{width:100%;height:100%}',
    '.edc-stage[data-state="loading"]:after{content:attr(data-msg);position:absolute;inset:0;display:flex;',
    'align-items:center;justify-content:center;color:#9ca3af;font-size:.875rem}',
    '.edc-note{margin:.75rem 0 0;font-size:.875rem;color:#b91c1c}',
    // ---- trigger bar, under the player ----
    '.edc-toolbar{display:flex;margin-top:.875rem}',
    '.edc-trigger{display:inline-flex;align-items:center;gap:.5rem;background:var(--edc-bg);',
    'border:1px solid var(--edc-border);border-radius:999px;padding:.5rem .5rem .5rem .875rem;',
    'font:inherit;font-size:.9375rem;font-weight:600;color:var(--edc-text);cursor:pointer;',
    'transition:background .12s ease,border-color .12s ease,color .12s ease}',
    '.edc-trigger:hover{color:var(--edc-accent);border-color:var(--edc-accent);background:var(--edc-accent-soft)}',
    '.edc-trigger:focus-visible{outline:2px solid var(--edc-accent);outline-offset:2px}',
    '.edc-trigger svg{flex:0 0 auto;width:1rem;height:1rem}',
    '.edc-trigger-count{background:var(--edc-accent-soft);color:var(--edc-accent);border-radius:999px;',
    'font-size:.8125rem;font-weight:700;padding:.125rem .5rem;line-height:1.4}',
    '.edc-trigger[aria-expanded="true"]{color:var(--edc-accent);border-color:var(--edc-accent)}',
    // ---- slide-out panel + backdrop (appended to <body>, not the embed) ----
    // Transparent on purpose (v2.3) — the client wants the page behind the panel to stay
    // visible, not dimmed. It still sits over the whole viewport and still catches a
    // click to close the panel; only its background is gone. Restore a dim look by
    // setting this to e.g. rgba(15,23,42,.45) if a future project wants it back.
    '.edc-drawer-backdrop{position:fixed;inset:0;background:transparent;',
    'pointer-events:none;z-index:999990}',
    '.edc-drawer-backdrop.edc-open{pointer-events:auto}',
    '.edc-drawer{position:fixed;top:0;right:0;height:100%;height:100dvh;width:400px;max-width:100vw;',
    'background:var(--edc-bg);color:var(--edc-text);box-shadow:-8px 0 28px rgba(15,23,42,.18);',
    'transform:translateX(100%);transition:transform .26s ease;z-index:999991;',
    'display:flex;flex-direction:column;font-family:inherit}',
    '.edc-drawer.edc-open{transform:translateX(0)}',
    '.edc-drawer.edc-full{width:100vw}',
    // ---- drag-to-resize handle on the panel's left edge (desktop only) ----
    '.edc-drawer-resize{position:absolute;left:-5px;top:0;bottom:0;width:11px;cursor:ew-resize;',
    'touch-action:none;z-index:1;background:transparent}',
    '.edc-drawer-resize:before{content:"";position:absolute;left:5px;top:0;bottom:0;width:2px;',
    'background:transparent;transition:background .12s ease}',
    '.edc-drawer-resize:hover:before,.edc-drawer-resize:focus-visible:before{background:var(--edc-accent)}',
    '.edc-drawer-resize:focus-visible{outline:0}',
    '.edc-drawer.edc-full .edc-drawer-resize{display:none}',
    'html.edc-resizing{cursor:ew-resize!important}',
    'html.edc-resizing,html.edc-resizing *{user-select:none!important}',
    '.edc-drawer-head{display:flex;align-items:flex-start;gap:.75rem;padding:1.125rem 1.125rem .875rem;',
    'border-bottom:1px solid var(--edc-border);flex:0 0 auto}',
    '.edc-drawer-title{flex:1 1 auto;font-size:1.0625rem;font-weight:700;line-height:1.4;margin:.1875rem 0 0}',
    '.edc-drawer-close{flex:0 0 auto;width:2.25rem;height:2.25rem;border-radius:8px;border:0;',
    'background:none;color:var(--edc-muted);font-size:1.25rem;line-height:1;cursor:pointer;',
    'display:flex;align-items:center;justify-content:center}',
    '.edc-drawer-close:hover{background:var(--edc-accent-soft);color:var(--edc-accent)}',
    '.edc-drawer-close:focus-visible{outline:2px solid var(--edc-accent);outline-offset:2px}',
    '.edc-drawer-tabs{display:flex;gap:.25rem;padding:.625rem 1.125rem 0;border-bottom:1px solid var(--edc-border);',
    'flex:0 0 auto;overflow-x:auto}',
    '.edc-tab{background:none;border:0;border-bottom:2px solid transparent;padding:.5rem .625rem;',
    'font:inherit;font-size:.875rem;font-weight:600;color:var(--edc-muted);cursor:pointer;',
    'white-space:nowrap;margin-bottom:-1px;border-radius:4px 4px 0 0}',
    '.edc-tab:hover{color:var(--edc-text);background:var(--edc-accent-soft)}',
    '.edc-tab[aria-selected="true"]{color:var(--edc-accent);border-bottom-color:var(--edc-accent)}',
    '.edc-drawer-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:1.125rem}',
    '.edc-tabpanel[hidden]{display:none}',
    // ---- summary panel ----
    '.edc-summary-text{font-size:.9375rem;line-height:1.75;color:var(--edc-text)}',
    '.edc-summary-text>p{margin:0 0 .875rem;text-align:justify}',
    '.edc-summary-text>p:last-child{margin-bottom:0}',
    // ---- mind map ----
    '.edc-mm{margin:0}',
    '.edc-mm-bar{display:flex;align-items:center;gap:.375rem;margin-bottom:.625rem;flex-wrap:wrap}',
    '.edc-mm-bar .edc-hint{flex:1 1 auto;font-size:.75rem;color:var(--edc-muted);min-width:8rem}',
    '.edc-zoom{background:none;border:1px solid var(--edc-border);border-radius:6px;width:1.75rem;',
    'height:1.75rem;line-height:1;font:inherit;font-size:.875rem;color:var(--edc-text);cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;padding:0}',
    '.edc-zoom.edc-wide{width:auto;padding:0 .5rem;font-size:.75rem}',
    '.edc-zoom:hover{background:var(--edc-accent-soft);border-color:var(--edc-accent);color:var(--edc-accent)}',
    // Deliberately much stronger than a faint opacity fade — a filled grey fill and a
    // "not-allowed" cursor read as "this does nothing" at a glance, on any page theme.
    '.edc-zoom:disabled,.edc-zoom[aria-disabled="true"]{opacity:1;background:var(--edc-border)!important;',
    'color:var(--edc-muted)!important;border-color:var(--edc-border)!important;cursor:not-allowed!important;',
    'pointer-events:none!important}',
    '.edc-mm-view{position:relative;overflow:auto;border:1px solid var(--edc-border);border-radius:8px;',
    'background:var(--edc-bg);-webkit-overflow-scrolling:touch}',
    '.edc-mm-view svg{display:block;height:auto!important;max-width:none}',
    '.edc-mm-view .edc-mm-msg{padding:2rem 1rem;text-align:center;font-size:.875rem;color:var(--edc-muted)}',
    // Full-screen targets the WHOLE .edc-mm wrapper (toolbar + view), so the
    // zoom controls travel into full-screen with the diagram instead of being
    // left behind, unreachable, on the page underneath.
    '.edc-mm:fullscreen{width:100%;height:100%;background:var(--edc-bg);display:flex;',
    'flex-direction:column;padding:1rem;box-sizing:border-box}',
    '.edc-mm:fullscreen .edc-mm-bar{flex:0 0 auto}',
    '.edc-mm:fullscreen .edc-mm-view{flex:1 1 auto;max-height:none!important}',
    '.edc-mm:fullscreen .edc-mm-view svg{margin:auto}',
    // clickable mind-map nodes
    '.edc-mm-view .edc-hit{cursor:pointer}',
    '.edc-mm-view .edc-hit rect,.edc-mm-view .edc-hit circle,.edc-mm-view .edc-hit polygon,',
    '.edc-mm-view .edc-hit path{transition:fill .12s ease,stroke .12s ease}',
    '.edc-mm-view .edc-hit:hover rect,.edc-mm-view .edc-hit:hover circle,',
    '.edc-mm-view .edc-hit:hover polygon{fill:var(--edc-accent)!important;stroke:var(--edc-accent)!important}',
    '.edc-mm-view .edc-hit:hover text,.edc-mm-view .edc-hit:hover span{fill:#fff!important;color:#fff!important}',
    '.edc-mm-view .edc-hit.edc-mm-live rect,.edc-mm-view .edc-hit.edc-mm-live circle,',
    '.edc-mm-view .edc-hit.edc-mm-live polygon{stroke:var(--edc-accent)!important;stroke-width:2.5px!important}',
    // ---- chapter tree (inside the panel) ----
    '.edc-nav-head{display:flex;align-items:center;justify-content:flex-end;margin:0 0 .5rem}',
    '.edc-toggle-all{background:none;border:0;padding:.25rem;font:inherit;font-size:.8125rem;',
    'color:var(--edc-accent);cursor:pointer;border-radius:4px}',
    '.edc-toggle-all:hover{text-decoration:underline}',
    '.edc-list,.edc-list ul{list-style:none;margin:0;padding:0}',
    '.edc-list ul{margin:.25rem 0 .25rem 1.5rem;padding-left:.75rem;border-left:1px solid var(--edc-border);display:none}',
    '.edc-list li.edc-open>ul{display:block}',
    '.edc-row{display:flex;align-items:flex-start;gap:.375rem;margin:.125rem 0}',
    '.edc-caret{flex:0 0 auto;width:1.375rem;height:1.75rem;display:flex;align-items:center;justify-content:center;',
    'background:none;border:0;padding:0;cursor:pointer;color:var(--edc-muted);border-radius:4px;font:inherit}',
    '.edc-caret:hover{background:var(--edc-accent-soft);color:var(--edc-accent)}',
    '.edc-caret svg{width:.75rem;height:.75rem;transition:transform .15s ease}',
    'li.edc-open>.edc-row>.edc-caret svg{transform:rotate(90deg)}',
    '.edc-caret-spacer{flex:0 0 auto;width:1.375rem}',
    '.edc-seek{flex:1 1 auto;display:flex;align-items:baseline;gap:.5rem;text-align:left;width:100%;',
    'background:none;border:0;padding:.3125rem .5rem;border-radius:6px;cursor:pointer;font:inherit;',
    'font-size:.875rem;line-height:1.5;color:var(--edc-text);transition:background .12s ease,color .12s ease}',
    '.edc-seek:hover{background:var(--edc-accent-soft);color:var(--edc-accent)}',
    '.edc-seek:focus-visible{outline:2px solid var(--edc-accent);outline-offset:1px}',
    '.edc-seek[aria-current="true"]{background:var(--edc-accent);color:#fff;font-weight:600}',
    '.edc-seek[aria-current="true"] .edc-t{color:rgba(255,255,255,.85)}',
    '.edc-t{flex:0 0 auto;font-variant-numeric:tabular-nums;font-size:.8125rem;color:var(--edc-accent);',
    'font-weight:600;min-width:3.25rem}',
    '.edc-l{flex:1 1 auto}',
    '.edc-depth1>.edc-row>.edc-seek{font-weight:600}',
    '.edc-depth2>.edc-row>.edc-seek{font-size:.8125rem;color:var(--edc-muted)}',
    '.edc-depth2>.edc-row>.edc-seek:hover{color:var(--edc-accent)}',
    '.edc-brief{margin:.125rem 0 .5rem 2.25rem;font-size:.8125rem;line-height:1.55;color:var(--edc-muted)}',
    '@media (max-width:520px){.edc-body{padding:1rem}.edc-title{padding:.875rem 1rem;font-size:1rem}',
    '.edc-t{min-width:2.75rem}}',
    // Body scroll lock while any panel is open
    'html.edc-drawer-lock{overflow:hidden}',
    // Dark mode is OPT-IN: add data-auto-dark="true", or set autoDark in
    // EDCITY_VIDEO_DEFAULTS, to follow the visitor's OS setting. Off by
    // default so the embed always matches a light page.
    '@media (prefers-color-scheme:dark){.edc-auto-dark.edc{--edc-text:#e5e7eb;--edc-muted:#9ca3af;',
    '--edc-border:#374151;--edc-bg:#111827;--edc-accent:#60a5fa;--edc-accent-soft:#1e3a5f}',
    '.edc-auto-dark .edc-title{background:#1f2937}}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('edcity-video-css')) return;
    var s = document.createElement('style');
    s.id = 'edcity-video-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var CARET_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
    '<path d="M4 2l5 4-5 4z" fill="currentColor"/></svg>';

  var TRIGGER_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    '<path d="M3 5h14M3 10h14M3 15h9" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" fill="none"/></svg>';

  // ===================================================================
  // Player discovery + adapters
  //
  // v3 never creates a player. It finds the ones the host page already
  // booted and drives them through a thin adapter, so the rest of the
  // library does not care which Kaltura generation is on the page.
  // ===================================================================

  var PLAYER_SELECTOR = [
    '[data-edcity-player]',              // explicit opt-in, wins over everything
    '.kWidgetIframeContainer',           // kWidget / mwEmbed  ← hkedcity.net today
    '.kWidgetPlayer',
    '[id^="kaltura_player"]',
    '.kaltura-player-container'          // Playkit V7
  ].join(',');

  /** Every player container on the page, in DOM order, outermost only. */
  function findPlayerNodes(scope) {
    var all = Array.prototype.slice.call((scope || document).querySelectorAll(PLAYER_SELECTOR));
    return all.filter(function (n) {
      if (n.getAttribute('data-edc-host')) return false;
      // drop anything nested inside another match (the iframe inside its container)
      for (var i = 0; i < all.length; i++) {
        if (all[i] !== n && all[i].contains(n)) return false;
      }
      return true;
    });
  }

  /**
   * One uniform interface over the Kaltura generations:
   *   .ready(cb)   called once the player can answer questions
   *   .entryId()   the entry currently loaded, or null
   *   .seek(sec)   jump, and play if asked
   *   .onTime(cb)  playhead updates, for chapter highlighting
   */
  function Adapter(node) {
    this.node = node;
    this.kind = null;
    this.pk = null;          // Playkit instance, when that is what we found
    this._readyCbs = [];
    this._resolved = false;
    this._detect();
  }

  Adapter.prototype._detect = function () {
    var n = this.node, self = this;

    // --- kWidget / mwEmbed: the API lives on the container element itself
    if (typeof n.sendNotification === 'function' && typeof n.evaluate === 'function') {
      this.kind = 'mwembed';
      this._resolve();
      return;
    }

    // --- Playkit V7
    if (window.KalturaPlayer && typeof window.KalturaPlayer.getPlayers === 'function') {
      var players = window.KalturaPlayer.getPlayers() || {};
      for (var id in players) {
        if (!has(players, id)) continue;
        var el0 = document.getElementById(id);
        if (el0 && (el0 === n || n.contains(el0))) {
          this.kind = 'playkit'; this.pk = players[id]; this._resolve(); return;
        }
      }
    }

    // --- plain <video>
    var v = n.tagName === 'VIDEO' ? n : n.querySelector('video');
    if (v) { this.kind = 'video'; this.video = v; this._resolve(); return; }

    // --- not booted yet. kWidget tells us when it is; poll as a safety net.
    if (window.kWidget && typeof window.kWidget.addReadyCallback === 'function') {
      try {
        window.kWidget.addReadyCallback(function (playerId) {
          if (playerId === n.id || n.id.indexOf(playerId) === 0) self._detect();
        });
      } catch (e) {}
    }
    if (!this._pollTimer) {
      var tries = 0;
      this._pollTimer = setInterval(function () {
        if (self._resolved) { clearInterval(self._pollTimer); return; }
        if (++tries > 60) { clearInterval(self._pollTimer); return; } // ~30s then give up
        self._detect();
      }, 500);
    }
  };

  Adapter.prototype._resolve = function () {
    if (this._resolved) return;
    this._resolved = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    var cbs = this._readyCbs; this._readyCbs = [];
    var self = this;
    cbs.forEach(function (cb) { try { cb(self); } catch (e) {} });
  };

  Adapter.prototype.ready = function (cb) {
    if (this._resolved) { try { cb(this); } catch (e) {} } else this._readyCbs.push(cb);
  };
  Adapter.prototype.isReady = function () { return this._resolved; };

  Adapter.prototype.entryId = function () {
    try {
      if (this.kind === 'mwembed') return this.node.evaluate('{mediaProxy.entry.id}') || null;
      if (this.kind === 'playkit') {
        var s = this.pk.getMediaInfo && this.pk.getMediaInfo();
        return (s && s.entryId) || (this.pk.sources && this.pk.sources.id) || null;
      }
    } catch (e) {}
    return null;
  };

  Adapter.prototype.seek = function (sec, play) {
    try {
      if (this.kind === 'mwembed') {
        this.node.sendNotification('doSeek', sec);
        if (play) this.node.sendNotification('doPlay');
        return true;
      }
      if (this.kind === 'playkit') {
        this.pk.currentTime = sec;
        if (play) { var r = this.pk.play(); if (r && r.catch) r.catch(function () {}); }
        return true;
      }
      if (this.kind === 'video') {
        this.video.currentTime = sec;
        if (play) { var r2 = this.video.play(); if (r2 && r2.catch) r2.catch(function () {}); }
        return true;
      }
    } catch (e) {
      console.warn('[edcity-video] seek failed:', e.message);
    }
    return false;
  };

  Adapter.prototype.onTime = function (cb) {
    var self = this;
    try {
      if (this.kind === 'mwembed' && typeof this.node.kBind === 'function') {
        this.node.kBind('playerUpdatePlayhead', function (t) { cb(Number(t) || 0); });
        return;
      }
      if (this.kind === 'playkit') {
        this.pk.addEventListener('timeupdate', function () { cb(self.pk.currentTime || 0); });
        return;
      }
      if (this.kind === 'video') {
        this.video.addEventListener('timeupdate', function () { cb(self.video.currentTime || 0); });
        return;
      }
    } catch (e) {}
    // fallback: poll whatever we can read
    setInterval(function () {
      try {
        if (self.kind === 'mwembed') cb(Number(self.node.evaluate('{video.player.currentTime}')) || 0);
      } catch (e) {}
    }, 1000);
  };

  // ===================================================================
  // Where the JSON files come from
  // ===================================================================

  /** The <script> tag that loaded this file, so we can read its data-*. */
  function ownScript() {
    if (document.currentScript) return document.currentScript;
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/edcity-video(\.min)?\.js/.test(all[i].src || '')) return all[i];
    }
    return null;
  }

  /**
   * Splits a list of urls. Commas first, whitespace only as a fallback:
   * a path may legitimately contain spaces ("/ai/01 - lesson/x.json"), and
   * splitting on whitespace first quietly shreds it into four broken urls.
   * Each entry is trimmed, including the newlines a multi-line attribute
   * carries in from the HTML.
   */
  function splitList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.slice();
    var s = String(v);
    var parts = s.indexOf(',') > -1 ? s.split(',') : s.split(/\s+/);
    return parts.map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /** Every JSON url we have been pointed at, from any of the three channels. */
  function configuredSources() {
    var s = ownScript();
    var out = [];
    if (s) {
      out = out.concat(splitList(s.getAttribute('data-json')));
      out = out.concat(splitList(s.getAttribute('data-src')));   // alias
    }
    out = out.concat(splitList(window.EDCITY_VIDEO_SOURCES));
    // de-dupe, preserve order
    var seen = {}, uniq = [];
    out.forEach(function (u) { if (!seen[u]) { seen[u] = 1; uniq.push(u); } });
    return uniq;
  }

  /**
   * Optional convention mode: data-base="/ai/" data-lang-suffix="_en"
   * → the library asks each player for its entry id and fetches
   *   /ai/1_9y0e8yhx_en.json by itself. Nothing to list per page.
   */
  function baseConfig() {
    var s = ownScript();
    if (!s) return null;
    var base = s.getAttribute('data-base');
    if (!base) return null;
    return {
      base: base.replace(/\/*$/, '/'),
      suffix: s.getAttribute('data-lang-suffix') || ''
    };
  }

  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }

  /**
   * The element to hang our strip off. Climbs out of absolutely-positioned
   * and zero-height wrappers so the button always ends up in the page's
   * normal flow, directly below the player box the visitor can see.
   */
  function flowAnchor(node) {
    var n = node, guard = 0;
    while (n && n.parentElement && guard++ < 6) {
      var cs;
      try { cs = getComputedStyle(n); } catch (e) { break; }
      if (cs.position === 'absolute' || cs.position === 'fixed') { n = n.parentElement; continue; }
      if (n.getBoundingClientRect().height < 4) { n = n.parentElement; continue; }
      break;
    }
    return n || node;
  }

  // ===================================================================
  // Embed — one per (player, JSON) pair
  //
  // v3 owns only the strip it injects directly under the player, plus the
  // slide-out panel (which lives on <body>). The player element itself is
  // the client's, and is never modified.
  // ===================================================================
  function Embed(host, json, adapter) {
    this.host = host;              // the client's player container
    this.adapter = adapter;
    this.id = 'edc-' + (++seq);
    this.source = json.__url || '';

    this.data = normalise(json);
    this.mindmapSrc = json.mindmapSrc || json.mindmap_src || '';
    this.entryId = (json.target && (json.target.entry || json.target.entryId)) ||
                   json.entry || json.entryId || adapter.entryId() || '';

    this.lang = json.lang || cfg.lang;
    this.t = strings(this.lang, this.data);

    this.opts = merge(cfg, json.options || {});
    // a couple of spellings people reach for
    if (has(json, 'closeOnSeek')) this.opts.closeOnSeek = !!json.closeOnSeek;
    if (has(json, 'drawerWidth')) this.opts.drawerWidth = parseInt(json.drawerWidth, 10) || cfg.drawerWidth;
    var remembered = loadSavedWidth();
    if (remembered && !(json.options && has(json.options, 'drawerWidth'))) {
      this.opts.drawerWidth = parseInt(remembered, 10) || this.opts.drawerWidth;
    }
    this.currentWidth = this.opts.drawerWidth;

    this.pending = null;
    this.buttons = [];
    this.activeIdx = -1;
    this.mmDrawn = false;
    this.mmHits = [];
    this.mmActive = -1;
    this.mmScale = 1;
    this.mmLevels = null;
    this.mmLevelIdx = 0;
    this.mmNatural = 0;
    this.drawerIsOpen = false;
    this.activeTab = null;

    this.build();
    this.boot();
  }

  // -------------------------------------------------------------------
  // Layout: a single strip injected immediately AFTER the client's player
  // element — optional title line + the trigger button. The panel and its
  // backdrop go on <body> so they overlay the viewport regardless of the
  // host page's CSS.
  // -------------------------------------------------------------------
  Embed.prototype.build = function () {
    var self = this;

    this.root = el('div', 'edc edc-mount');
    this.root.setAttribute('data-edc-for', this.entryId || this.host.id || '');
    if (cfg.autoDark) this.root.classList.add('edc-auto-dark');

    // the player element doubles as "the stage" for scroll-into-view on seek
    this.stage = this.host;

    // The title is never rendered into the host page — it would duplicate the
    // heading their CMS already prints above the player. It still travels in
    // the JSON and is shown at the top of the slide-out panel.
    this.titleEl = el('h2', 'edc-title');   // off-DOM; renderMeta still writes to it

    var toolbar = el('div', 'edc-toolbar');
    this.trigger = el('button', 'edc-trigger');
    this.trigger.type = 'button';
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', this.id + '-drawer');
    this.trigger.innerHTML = TRIGGER_SVG;
    this.triggerLabel = el('span', null, this.t.jump);
    this.triggerCount = el('span', 'edc-trigger-count', '');
    this.trigger.appendChild(this.triggerLabel);
    this.trigger.appendChild(this.triggerCount);
    toolbar.appendChild(this.trigger);
    this.root.appendChild(toolbar);

    // Insert under the player. NOT simply after the player container: on
    // hkedcity.net that container is position:absolute inside a sized
    // wrapper, so a sibling inserted after it lands UNDERNEATH the player
    // and is invisible. Walk up to the nearest ancestor that is actually in
    // normal flow and has real height, and insert after that instead.
    var anchor = flowAnchor(this.host);
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(this.root, anchor.nextSibling);
    } else {
      document.body.appendChild(this.root);
    }
    this.host.setAttribute('data-edc-host', '1');

    this.buildDrawer(cfg.autoDark);
    this.trigger.addEventListener('click', function () { self.openDrawer(); });
    this.renderMeta();
  };

  Embed.prototype.buildDrawer = function (autoDark) {
    var self = this;

    this.backdrop = el('div', 'edc-drawer-backdrop');
    this.backdrop.hidden = true;

    this.drawer = el('div', 'edc' + (autoDark ? ' edc-auto-dark' : '') + ' edc-drawer');
    this.drawer.id = this.id + '-drawer';
    this.drawer.hidden = true;
    this.drawer.setAttribute('role', 'dialog');
    this.drawer.setAttribute('aria-modal', 'true');
    this.drawer.tabIndex = -1;
    this.drawer.style.width = this.currentWidth + 'px';

    if (this.opts.drawerResizable) {
      this.resizeHandle = el('div', 'edc-drawer-resize');
      this.resizeHandle.setAttribute('role', 'separator');
      this.resizeHandle.setAttribute('aria-orientation', 'vertical');
      this.resizeHandle.setAttribute('aria-label', this.t.resize);
      this.resizeHandle.tabIndex = 0;
      this.drawer.appendChild(this.resizeHandle);
    }

    var head = el('div', 'edc-drawer-head');
    this.drawerTitle = el('div', 'edc-drawer-title');
    this.closeBtn = el('button', 'edc-drawer-close', '×');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', this.t.close);
    head.appendChild(this.drawerTitle);
    head.appendChild(this.closeBtn);

    this.tabs = el('div', 'edc-drawer-tabs');
    this.tabs.setAttribute('role', 'tablist');
    this.tabSummary = el('button', 'edc-tab', this.t.summary);
    this.tabChapters = el('button', 'edc-tab', this.t.tabChapters);
    this.tabMindmap = el('button', 'edc-tab', this.t.tabMindmap);
    [this.tabSummary, this.tabChapters, this.tabMindmap].forEach(function (b) {
      b.type = 'button';
      b.setAttribute('role', 'tab');
    });
    this.tabs.appendChild(this.tabSummary);
    this.tabs.appendChild(this.tabChapters);
    this.tabs.appendChild(this.tabMindmap);

    var dbody = el('div', 'edc-drawer-body');
    this.panelSummary = el('div', 'edc-tabpanel');
    this.panelSummary.setAttribute('role', 'tabpanel');
    this.summaryText = el('div', 'edc-summary-text');
    this.panelSummary.appendChild(this.summaryText);

    this.panelChapters = el('div', 'edc-tabpanel');
    this.panelChapters.setAttribute('role', 'tabpanel');
    this.nav = el('div');
    this.panelChapters.appendChild(this.nav);

    this.panelMindmap = el('div', 'edc-tabpanel');
    this.panelMindmap.setAttribute('role', 'tabpanel');

    dbody.appendChild(this.panelSummary);
    dbody.appendChild(this.panelChapters);
    dbody.appendChild(this.panelMindmap);

    this.drawer.appendChild(head);
    this.drawer.appendChild(this.tabs);
    this.drawer.appendChild(dbody);

    document.body.appendChild(this.backdrop);
    document.body.appendChild(this.drawer);

    this.tabSummary.addEventListener('click', function () { self.setActiveTab('summary'); });
    this.tabChapters.addEventListener('click', function () { self.setActiveTab('chapters'); });
    this.tabMindmap.addEventListener('click', function () { self.setActiveTab('mindmap'); });
    this.closeBtn.addEventListener('click', function () { self.closeDrawer(); });
    this.backdrop.addEventListener('click', function () { self.closeDrawer(); });
    this.drawer.addEventListener('keydown', function (e) { self.onDrawerKeydown(e); });

    // On mobile the panel is forced full-screen by CSS (.edc-full { width:100vw }).
    // On desktop the inline pixel width — the default, or whatever the visitor
    // last dragged it to — applies. Inline style always wins over a class, so
    // switching modes means adding/removing the inline width, not just the class.
    var applyBreakpoint = function () {
      var full = window.innerWidth < self.opts.drawerBreakpoint;
      self.drawer.classList.toggle('edc-full', full);
      self.drawer.style.width = full ? '' : (self.currentWidth + 'px');
    };
    applyBreakpoint();
    window.addEventListener('resize', applyBreakpoint);

    if (this.opts.drawerResizable) this.wireResize();
  };

  /** Lets the visitor drag the panel's left edge (mouse, touch or pen) to resize it. */
  Embed.prototype.wireResize = function () {
    var self = this;
    var handle = this.resizeHandle;
    var dragging = false, startX = 0, startWidth = 0;

    function clampWidth(w) {
      var max = Math.min(self.opts.drawerMaxWidth, window.innerWidth - 48);
      return Math.max(self.opts.drawerMinWidth, Math.min(max, w));
    }
    function setWidth(w) {
      self.currentWidth = clampWidth(w);
      self.drawer.style.width = self.currentWidth + 'px';
    }
    function onMove(e) {
      if (!dragging) return;
      var x = e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;
      setWidth(startWidth + (startX - x)); // dragging left = wider panel
      e.preventDefault();
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.documentElement.classList.remove('edc-resizing');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      saveWidth(self.currentWidth);
    }

    handle.addEventListener('pointerdown', function (e) {
      if (self.drawer.classList.contains('edc-full')) return; // no dragging in mobile full-screen
      dragging = true;
      startX = e.clientX;
      startWidth = self.drawer.getBoundingClientRect().width;
      document.documentElement.classList.add('edc-resizing');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      e.preventDefault();
    });

    // Keyboard equivalent: focus the handle (Shift+Tab from the close button
    // reaches it), then use the arrow keys. Left = wider, Right = narrower.
    handle.addEventListener('keydown', function (e) {
      if (self.drawer.classList.contains('edc-full')) return;
      var step = e.shiftKey ? 60 : 20;
      if (e.key === 'ArrowLeft') setWidth(self.currentWidth + step);
      else if (e.key === 'ArrowRight') setWidth(self.currentWidth - step);
      else return;
      e.preventDefault();
      saveWidth(self.currentWidth);
    });
  };

  Embed.prototype.onDrawerKeydown = function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      // If the mind map is full-screen, Esc's job is to exit that first — the
      // browser handles that itself regardless of preventDefault, so just
      // don't also close the whole panel on the same keypress.
      if (document.fullscreenElement) return;
      e.stopPropagation();
      this.closeDrawer();
      return;
    }
    if (e.key !== 'Tab') return;
    var f = focusables(this.drawer);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };

  Embed.prototype.openDrawer = function () {
    if (this.drawerIsOpen) return;
    // Only one panel visible on screen at a time.
    for (var i = 0; i < instances.length; i++) {
      if (instances[i] !== this && instances[i].drawerIsOpen) instances[i].closeDrawer();
    }
    this.drawerIsOpen = true;
    this.lastFocused = document.activeElement;
    this.backdrop.hidden = false;
    this.drawer.hidden = false;
    var self = this;
    // rAF so the "hidden -> visible" change and the transform transition don't collapse into one frame
    requestAnimationFrame(function () {
      self.backdrop.classList.add('edc-open');
      self.drawer.classList.add('edc-open');
    });
    this.trigger.setAttribute('aria-expanded', 'true');
    lockScroll();
    if (!this.activeTab) this.setActiveTab(this.defaultTab());
    var target = this.closeBtn;
    setTimeout(function () { try { target.focus(); } catch (e) {} }, 30);
  };

  Embed.prototype.closeDrawer = function () {
    if (!this.drawerIsOpen) return;
    this.drawerIsOpen = false;
    this.backdrop.classList.remove('edc-open');
    this.drawer.classList.remove('edc-open');
    this.trigger.setAttribute('aria-expanded', 'false');
    unlockScroll();
    var self = this;
    var done = function () {
      if (self.drawerIsOpen) return; // reopened before the transition finished
      self.backdrop.hidden = true;
      self.drawer.hidden = true;
    };
    this.drawer.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 350); // fallback in case transitionend doesn't fire
    if (this.lastFocused && typeof this.lastFocused.focus === 'function') {
      try { this.lastFocused.focus(); } catch (e) {}
    } else {
      try { this.trigger.focus(); } catch (e) {}
    }
  };

  /** First tab that actually has content: Summary, then Chapters, then Mind map. */
  Embed.prototype.defaultTab = function () {
    if (this.data.summary) return 'summary';
    if (this.data.chapters.length) return 'chapters';
    return 'mindmap';
  };

  Embed.prototype.setActiveTab = function (which) {
    this.activeTab = which;
    var map = { summary: this.tabSummary, chapters: this.tabChapters, mindmap: this.tabMindmap };
    var panels = { summary: this.panelSummary, chapters: this.panelChapters, mindmap: this.panelMindmap };
    for (var k in map) {
      if (!has(map, k)) continue;
      map[k].setAttribute('aria-selected', String(k === which));
      panels[k].hidden = (k !== which);
    }
    if (which === 'mindmap') this.drawMindmap();
  };

  Embed.prototype.renderMeta = function () {
    // Title (header bar above the player)
    this.titleEl.textContent = this.data.title || '';
    this.titleEl.style.display = this.data.title ? '' : 'none';
    this.drawerTitle.textContent = this.data.title || this.t.jump;

    // Summary — paragraphs split on blank lines so long summaries stay readable
    this.summaryText.innerHTML = '';
    var hasSummary = !!this.data.summary;
    if (hasSummary) {
      String(this.data.summary).split(/\n\s*\n|\|\|/).forEach(function (para) {
        para = para.trim();
        if (para) this.summaryText.appendChild(el('p', null, para));
      }, this);
    }

    var hasChapters = !!this.data.chapters.length;
    var hasMM = !!(this.data.mindmap || this.mindmapSrc);

    // Show only the tabs that have something behind them.
    this.tabSummary.style.display = hasSummary ? '' : 'none';
    this.tabChapters.style.display = hasChapters ? '' : 'none';
    this.tabMindmap.style.display = hasMM ? '' : 'none';
    var visibleTabs = [hasSummary, hasChapters, hasMM].filter(Boolean).length;
    this.tabs.style.display = visibleTabs > 1 ? '' : 'none';

    // The button under the player only makes sense if there is something to show.
    this.trigger.style.display = (hasSummary || hasChapters || hasMM) ? '' : 'none';
    this.triggerCount.style.display = hasChapters ? '' : 'none';
    this.triggerCount.textContent = hasChapters ? String(this.data.chapters.length) : '';

    this.activeTab = null; // re-resolve the default next time the panel opens
    if (this.drawerIsOpen) this.setActiveTab(this.defaultTab());

    this.renderNav();
  };

  // ===================================================================
  // Mind map — Mermaid is fetched only if an embed supplies one, and only
  // when the tab is first opened. Nodes whose label contains a timestamp
  // become clickable seek targets.
  // ===================================================================
  Embed.prototype.drawMindmap = function () {
    if (this.mmDrawn || !(this.data.mindmap || this.mindmapSrc)) return;
    this.mmDrawn = true;

    var self = this;
    var wrap = el('div', 'edc-mm');

    var bar = el('div', 'edc-mm-bar');
    var mk = function (label, title, cls) {
      var b = el('button', 'edc-zoom' + (cls || ''), label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      return b;
    };
    var out = mk('−', this.t.zoomOut);
    var inn = mk('＋', this.t.zoomIn);
    var fit = mk(this.t.zoomReset, this.t.zoomReset, ' edc-wide');
    var full = mk('⛶', this.t.full);
    bar.appendChild(el('span', 'edc-hint', this.t.hint));
    [out, inn, fit, full].forEach(function (b) { bar.appendChild(b); });
    wrap.appendChild(bar);

    this.mmView = el('div', 'edc-mm-view');
    this.mmView.style.maxHeight = this.opts.mindmapHeight + 'px';
    this.mmView.appendChild(el('div', 'edc-mm-msg', this.t.drawing));
    wrap.appendChild(this.mmView);
    this.panelMindmap.appendChild(wrap);

    this.mmWrap = wrap;
    this.mmFullBtn = full;
    this.mmZoomOutBtn = out;
    this.mmZoomInBtn = inn;

    out.addEventListener('click', function () { self.zoom('out'); });
    inn.addEventListener('click', function () { self.zoom('in'); });
    fit.addEventListener('click', function () { self.zoom(null); });

    // Ctrl/Cmd + wheel (also what a trackpad pinch sends) zooms smoothly,
    // well past what the +/- buttons' fixed step gets you to in one go —
    // the fast way to get a small diagram big enough to read in full-screen.
    this.mmView.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return; // otherwise let the page/container scroll normally
      e.preventDefault();
      self.zoom(self.mmScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    full.addEventListener('click', function () {
      try {
        // Full-screen the WHOLE wrapper (toolbar + view), not just the view —
        // otherwise the zoom buttons stay behind on the page and are
        // unreachable while the map is full-screen.
        if (document.fullscreenElement === wrap) document.exitFullscreen();
        else if (wrap.requestFullscreen) wrap.requestFullscreen();
      } catch (e) { /* not permitted — harmless */ }
    });

    // The available width changes drastically on the way in and out of full-screen —
    // Fit (and the zoom-in cap computed from it, see zoom()/buildZoomLevels()) needs to
    // re-measure once the browser has actually resized the box. A flat delay after the
    // fullscreenchange event is a guess, but a short one is enough on ordinary browsers,
    // and it's the simplest thing that works — re-fitting is idempotent, so a delay that's
    // occasionally a little early just means Fit looks right a beat sooner or later.
    document.addEventListener('fullscreenchange', function () {
      var isFull = document.fullscreenElement === wrap;
      full.setAttribute('aria-label', isFull ? self.t.exitFull : self.t.full);
      full.title = isFull ? self.t.exitFull : self.t.full;
      setTimeout(function () { self.zoom(null); }, 60);
    });

    // The source is either inline in the JSON, or a .mmd file alongside the page.
    // A .mmd needs http(s) — fetch() is blocked on file:// URLs.
    var source = this.data.mindmap
      ? Promise.resolve(this.data.mindmap)
      : fetch(this.mindmapSrc, { credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });

    Promise.all([source, loadScript(this.opts.mermaidUrl)]).then(function (res) {
      self.data.mindmap = String(res[0]).trim();
      if (!self.data.mindmap) throw new Error('mind map source is empty');
      if (!window.mermaid) throw new Error('mermaid global not found');
      if (!window.__edcMermaidInit) {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          flowchart: { curve: 'basis', nodeSpacing: 16, rankSpacing: 56, padding: 7, htmlLabels: true, wrappingWidth: 340 },
          themeVariables: { fontFamily: 'inherit', fontSize: '14px' }
        });
        window.__edcMermaidInit = true;
      }
      return window.mermaid.render(self.id + '-mm', self.data.mindmap);
    }).then(function (res) {
      self.mmView.innerHTML = (res && res.svg) ? res.svg : String(res);
      self.wireMindmap();
      self.zoom(null);
    }).catch(function (e) {
      console.error('[edcity-video] mind map failed:', e && e.message ? e.message : e);
      self.mmView.innerHTML = '';
      self.mmView.appendChild(el('div', 'edc-mm-msg', self.t.mmError));
    });
  };

  /** Makes every mind-map node whose text carries a timestamp seek the video. */
  Embed.prototype.wireMindmap = function () {
    var self = this;
    this.mmHits = [];
    var svg = this.mmView.querySelector('svg');
    if (!svg) return;
    this.mmNatural = svg.getAttribute('width') ? parseFloat(svg.getAttribute('width')) : (svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 0);
    if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) this.mmNatural = svg.viewBox.baseVal.width;

    var nodes = svg.querySelectorAll('g.node, .node');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var txt = (n.textContent || '').replace(/\s+/g, ' ');
      // last time-like token in the label, e.g. "1:29" or "00:04:45"
      var m = txt.match(/(\d{1,2}:\d{2}(?::\d{2})?)(?!.*\d{1,2}:\d{2})/);
      if (!m) continue;
      var sec = parseTime(m[1]);
      if (sec == null) continue;
      n.classList.add('edc-hit');
      n.setAttribute('tabindex', '0');
      n.setAttribute('role', 'button');
      n.setAttribute('aria-label', txt);
      this.mmHits.push({ start: sec, el: n });
      (function (s, node) {
        node.addEventListener('click', function () { self.seekAndMaybeClose(s); });
        node.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.seekAndMaybeClose(s); }
        });
      })(sec, n);
    }
    this.mmHits.sort(function (a, b) { return a.start - b.start; });
  };

  function round3(n) { return Math.round(n * 1000) / 1000; }

  /**
   * v2.3 — the +/- buttons no longer step by multiplying/dividing a running
   * float (self.mmScale *= 1.3). That was the actual cause of the reported
   * "stuck at the cap" bug: each click was a fresh float multiplication, so
   * whether a click at the boundary counted as "still at the limit" depended
   * on a fraction-of-a-percent rounding comparison — reliable in testing, but
   * one bad rounding case on a real diagram/browser combination is enough to
   * make a click at the cap look like it did something when it didn't, or
   * need an extra click or two before it visibly moves.
   *
   * Every reachable zoom level is a fixed number, computed by buildZoomLevels()
   * whenever the view is (re)fit, and the +/- buttons just move an integer
   * index up or down that list. "At maximum zoom" is literally "index is the
   * last one in the array" — there is no float comparison left to get wrong,
   * and no amount of extra clicking on + past the last index can ever change
   * anything, because zoom('in') returns immediately once the index can't
   * move further. That check happens in the click handler's own logic, not
   * just via the button's disabled state, so it holds even if a host page's
   * CSS ever interferes with how a disabled <button> looks or behaves.
   *
   * v2.4 — the zoom-in ceiling is now anchored to "Fit" itself, not to a fixed
   * multiple of the diagram's natural size: exactly `mindmapZoomSteps` (default
   * 3) presses of + above whatever "Fit" currently computes, each multiplying
   * by `mindmapZoomStep` (default 1.6x). That's the whole point of rebuilding
   * this — "3 clicks from default to max, no more, no less" is now true by
   * construction (the level list literally has 3 entries above the fit index),
   * instead of depending on how small a particular diagram's fit ratio happens
   * to be. Re-fitting (Fit button, opening the tab, resizing, entering/exiting
   * full-screen) recomputes both fit and the levels around it, so full-screen
   * — where fit is naturally larger — gets a correspondingly larger max, while
   * it's still always exactly 3 clicks away.
   */
  Embed.prototype.buildZoomLevels = function (fit) {
    var step = this.opts.mindmapZoomStep, stepsUp = this.opts.mindmapZoomSteps;
    var min = round3(this.opts.mindmapMinZoom);
    fit = round3(Math.max(min, fit));

    // Below fit: same step ratio, down to the configured absolute floor.
    var down = [];
    var v = fit, guard = 0;
    while (v / step > min + 1e-9 && guard++ < 100) {
      v = v / step;
      down.unshift(round3(v));
    }
    if (!down.length || down[0] > min + 1e-9) down.unshift(min);

    // Fit itself, then exactly `stepsUp` steps above it — nothing past this
    // last entry exists, so + cannot do anything once the index reaches it.
    var up = [];
    var u = fit;
    for (var i = 0; i < stepsUp; i++) { u = round3(u * step); up.push(u); }

    this.mmLevels = down.concat([fit], up);
    this.mmFitIdx = down.length;
  };

  Embed.prototype.applyScale = function (scale) {
    var svg = this.mmView && this.mmView.querySelector('svg');
    if (!svg) return;
    this.mmScale = scale;
    if (this.mmNatural) svg.style.width = Math.round(this.mmNatural * this.mmScale) + 'px';
    this.updateZoomButtons();
  };

  /**
   * scale: 'in' / 'out' steps one discrete level (from the +/- buttons and
   * nothing else — this is the path that is guaranteed inert past the ends);
   * null re-fits the viewport width and rebuilds the level list around the
   * new fit; any number sets an exact scale within the current level range
   * (used by Ctrl/Cmd+wheel, which still zooms smoothly rather than in fixed
   * steps, but is clamped to the same min/max the buttons respect).
   */
  Embed.prototype.zoom = function (scale) {
    if (scale === 'in' || scale === 'out') {
      if (!this.mmLevels) return;
      var next = this.mmLevelIdx + (scale === 'in' ? 1 : -1);
      if (next < 0 || next > this.mmLevels.length - 1) return; // already at the end: do nothing, no matter how many more times this is clicked
      this.mmLevelIdx = next;
      this.applyScale(this.mmLevels[this.mmLevelIdx]);
      return;
    }

    if (scale == null) {
      var avail = this.mmView.clientWidth - 4;
      var fit = (this.mmNatural && avail > 0) ? Math.min(1, avail / this.mmNatural) : 1;
      this.buildZoomLevels(fit);
      this.mmLevelIdx = this.mmFitIdx;
      this.applyScale(this.mmLevels[this.mmLevelIdx]);
      return;
    }

    if (!this.mmLevels) this.buildZoomLevels(scale);
    var lo = this.mmLevels[0], hi = this.mmLevels[this.mmLevels.length - 1];
    var target = Math.max(lo, Math.min(hi, round3(scale)));
    var best = 0, bestDiff = Infinity;
    for (var i = 0; i < this.mmLevels.length; i++) {
      var d = Math.abs(this.mmLevels[i] - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    this.mmLevelIdx = best;
    this.applyScale(target);
  };

  /**
   * Disables +/- at the real min/max — and does it loudly. Belt-and-suspenders
   * against a host page's CSS overriding the disabled look: this sets inline
   * styles directly (which normal external CSS can't out-rank) in addition to
   * the .edc-zoom:disabled rule, plus a title/aria-label explaining why.
   */
  Embed.prototype.updateZoomButtons = function () {
    if (!this.mmZoomInBtn) return;
    var atMin = this.mmLevelIdx <= 0;
    var atMax = this.mmLevelIdx >= this.mmLevels.length - 1;
    setZoomBtnState(this.mmZoomOutBtn, atMin, this.t.zoomMinned, this.t.zoomOut);
    setZoomBtnState(this.mmZoomInBtn, atMax, this.t.zoomMaxed, this.t.zoomIn);
  };

  function setZoomBtnState(btn, disabled, offLabel, onLabel) {
    btn.disabled = disabled;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    btn.title = disabled ? offLabel : onLabel;
    btn.setAttribute('aria-label', disabled ? offLabel : onLabel);
    if (disabled) {
      btn.style.opacity = '1';
      btn.style.cursor = 'not-allowed';
      btn.style.pointerEvents = 'none';
    } else {
      btn.style.opacity = '';
      btn.style.cursor = '';
      btn.style.pointerEvents = '';
    }
  }

  Embed.prototype.renderNav = function () {
    var self = this;
    this.nav.innerHTML = '';
    this.buttons = [];
    this.activeIdx = -1;

    if (!this.data.chapters.length) return;

    var hasKids = this.data.chapters.some(function (c) { return c.children.length; });
    if (hasKids) {
      var head = el('div', 'edc-nav-head');
      var toggleAll = el('button', 'edc-toggle-all', this.t.expand);
      toggleAll.type = 'button';
      head.appendChild(toggleAll);
      this.nav.appendChild(head);

      var list = this.buildList(this.data.chapters, 1);
      list.className = 'edc-list';
      this.nav.appendChild(list);

      var open = this.opts.expandDepth >= 2;
      var apply = function (state) {
        var lis = list.querySelectorAll('li');
        for (var i = 0; i < lis.length; i++) {
          if (!lis[i].querySelector(':scope > ul')) continue;
          lis[i].classList.toggle('edc-open', state);
          var c = lis[i].querySelector(':scope > .edc-row > .edc-caret');
          if (c) c.setAttribute('aria-expanded', String(state));
        }
        toggleAll.textContent = state ? self.t.collapse : self.t.expand;
      };
      apply(open);
      toggleAll.addEventListener('click', function () { open = !open; apply(open); });
    } else {
      var flatList = this.buildList(this.data.chapters, 1);
      flatList.className = 'edc-list';
      this.nav.appendChild(flatList);
    }
  };

  Embed.prototype.buildList = function (chapters, depth) {
    var self = this;
    var ul = document.createElement('ul');
    chapters.forEach(function (c) {
      var li = el('li', 'edc-depth' + Math.min(depth, 2));
      var row = el('div', 'edc-row');

      if (c.children.length) {
        var caret = el('button', 'edc-caret');
        caret.type = 'button';
        caret.innerHTML = CARET_SVG;
        caret.setAttribute('aria-expanded', String(self.opts.expandDepth > depth));
        caret.setAttribute('aria-label', c.label);
        caret.addEventListener('click', function (e) {
          e.stopPropagation();
          var on = li.classList.toggle('edc-open');
          caret.setAttribute('aria-expanded', String(on));
        });
        row.appendChild(caret);
        if (self.opts.expandDepth > depth) li.classList.add('edc-open');
      } else {
        row.appendChild(el('span', 'edc-caret-spacer'));
      }

      var btn = el('button', 'edc-seek');
      btn.type = 'button';
      btn.appendChild(el('span', 'edc-t', formatTime(c.start)));
      btn.appendChild(el('span', 'edc-l', c.label));
      btn.addEventListener('click', function () { self.seekAndMaybeClose(c.start); });
      row.appendChild(btn);
      li.appendChild(row);

      self.buttons.push({ start: c.start, el: btn });

      if (c.brief) li.appendChild(el('p', 'edc-brief', c.brief));
      if (c.children.length) li.appendChild(self.buildList(c.children, depth + 1));
      ul.appendChild(li);
    });
    return ul;
  };

  /** Seeks the player, then closes the panel unless closeOnSeek is off. */
  Embed.prototype.seekAndMaybeClose = function (sec) {
    this.seek(sec);
    if (this.opts.closeOnSeek) this.closeDrawer();
  };

  Embed.prototype.boot = function () {
    var self = this;
    this.adapter.ready(function () {
      if (!self.entryId) self.entryId = self.adapter.entryId() || '';
      self.attachHighlight();
      if (self.pending != null) { var p = self.pending; self.pending = null; self.apply(p); }
      else self.applyUrlSeek();
    });
  };

  Embed.prototype.fail = function (msg) {
    console.error('[edcity-video] ' + msg, this.entryId || '');
  };

  Embed.prototype.attachHighlight = function () {
    if (!this.opts.highlight || !this.buttons.length) return;
    var self = this;
    var order = this.buttons.slice().sort(function (a, b) { return a.start - b.start; });
    this.adapter.onTime(function (now) {
      var idx = -1, i, k;
      for (i = 0; i < order.length; i++) {
        if (order[i].start <= now + 0.35) idx = i; else break;
      }
      if (idx !== self.activeIdx) {
        if (self.activeIdx > -1) order[self.activeIdx].el.removeAttribute('aria-current');
        self.activeIdx = idx;
        if (idx > -1) order[idx].el.setAttribute('aria-current', 'true');
      }
      // mirror the highlight onto the mind map, once it exists
      if (self.mmHits.length) {
        var j = -1;
        for (k = 0; k < self.mmHits.length; k++) {
          if (self.mmHits[k].start <= now + 0.35) j = k; else break;
        }
        if (j !== self.mmActive) {
          if (self.mmActive > -1 && self.mmHits[self.mmActive]) self.mmHits[self.mmActive].el.classList.remove('edc-mm-live');
          self.mmActive = j;
          if (j > -1) self.mmHits[j].el.classList.add('edc-mm-live');
        }
      }
    });
  };

  /** Public: jump to a time (number or "mm:ss"/"hh:mm:ss"). */
  Embed.prototype.seek = function (time) {
    var sec = parseTime(time);
    if (sec == null) return;
    if (!this.adapter.isReady()) { this.pending = sec; return; }
    this.apply(sec);
  };

  Embed.prototype.apply = function (sec) {
    if (!this.adapter.seek(sec, this.opts.autoplayOnSeek)) return;
    if (this.opts.scrollIntoView) {
      try { this.stage.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }
    if (this.opts.deepLink && this.entryId) {
      try {
        history.replaceState(null, '', '#' + encodeURIComponent(this.entryId) + '=' + Math.floor(sec));
      } catch (e) {}
    }
  };

  /** Supports #1_4ge4fe27=305 and ?entry=1_4ge4fe27&t=5:05 style deep links. */
  Embed.prototype.applyUrlSeek = function () {
    var hash = (location.hash || '').replace(/^#/, '');
    if (hash) {
      var m = hash.split('=');
      if (m.length === 2 && decodeURIComponent(m[0]) === this.entryId) {
        var s = parseTime(m[1]);
        if (s != null) { this.apply(s); return; }
      }
    }
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('entry') === this.entryId && q.get('t')) {
        var t = parseTime(q.get('t'));
        if (t != null) this.apply(t);
      }
    } catch (e) {}
  };

  // ===================================================================
  // Bootstrap
  //
  //   1. find every player the page already booted
  //   2. wait (briefly) for them to be able to say which entry they hold
  //   3. fetch the configured JSON files
  //   4. pair each JSON to a player: target.player → target.entry →
  //      target.index → the only-one-of-each shortcut
  // ===================================================================

  var hosts = [];   // { node, adapter, taken }

  function collectHosts(scope) {
    findPlayerNodes(scope).forEach(function (node) {
      if (node.getAttribute('data-edc-seen')) return;
      node.setAttribute('data-edc-seen', '1');
      hosts.push({ node: node, adapter: new Adapter(node), taken: false });
    });
    return hosts;
  }

  /** Resolves once every host can answer entryId(), or after `ms`. */
  function hostsReady(ms) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(hosts); } };
      var check = function () {
        for (var i = 0; i < hosts.length; i++) if (!hosts[i].adapter.isReady()) return;
        finish();
      };
      hosts.forEach(function (h) { h.adapter.ready(check); });
      check();
      setTimeout(finish, ms || 12000);
    });
  }

  function matchHost(json, jsonIndex, total) {
    var tgt = json.target || {};
    var wantPlayer = tgt.player || tgt.playerId || tgt.container || json.player || '';
    var wantEntry  = tgt.entry || tgt.entryId || json.entry || json.entryId || '';
    var i, h;

    if (wantPlayer) {
      for (i = 0; i < hosts.length; i++) {
        h = hosts[i];
        if (!h.taken && (h.node.id === wantPlayer || h.node.id.indexOf(wantPlayer) === 0)) return h;
      }
    }
    if (wantEntry) {
      for (i = 0; i < hosts.length; i++) {
        h = hosts[i];
        if (!h.taken && h.adapter.entryId() === wantEntry) return h;
      }
    }
    if (tgt.index != null && hosts[tgt.index] && !hosts[tgt.index].taken) return hosts[tgt.index];
    if (total === 1 && hosts.length === 1 && !hosts[0].taken) return hosts[0];
    if (total === hosts.length && hosts[jsonIndex] && !hosts[jsonIndex].taken) return hosts[jsonIndex];
    return null;
  }

  function mount(json) {
    var h = json.__host;
    h.taken = true;
    try {
      var inst = new Embed(h.node, json, h.adapter);
      instances.push(inst);
      if (inst.opts.drawerOpen) inst.openDrawer();
      return inst;
    } catch (e) {
      console.error('[edcity-video] mount failed:', e);
      return null;
    }
  }

  /** Load one JSON url and attach it. Returns a promise of the instance. */
  function load(url) {
    return fetchJSON(url).then(function (json) {
      json.__url = url;
      return attach(json, 0, 1);
    }).catch(function (e) {
      console.error('[edcity-video] ' + e.message);
      return null;
    });
  }

  function attach(json, idx, total) {
    var h = matchHost(json, idx, total);
    if (!h) {
      console.warn('[edcity-video] no player on this page matches',
        (json.target && (json.target.player || json.target.entry)) || json.__url || '(unnamed json)');
      return null;
    }
    json.__host = h;
    return mount(json);
  }

  function init(scope) {
    injectCSS();
    collectHosts(scope);
    if (!hosts.length) return instances;

    return hostsReady(cfg.playerWaitMs).then(function () {
      var urls = configuredSources();

      // convention mode: derive one url per player from its entry id
      var bc = baseConfig();
      if (bc && !urls.length) {
        hosts.forEach(function (h) {
          var e = h.adapter.entryId();
          if (e) urls.push(bc.base + e + bc.suffix + '.json');
        });
      }

      // data already inlined by the page (rare, but keeps testing simple)
      var inline = window.EDCITY_VIDEO_DATA;
      if (inline) {
        var arr = Array.isArray(inline) ? inline : [inline];
        arr.forEach(function (j, i) { attach(j, i, arr.length); });
      }

      if (!urls.length) return instances;

      return Promise.all(urls.map(fetchJSONSafe)).then(function (list) {
        var good = list.filter(Boolean);
        good.forEach(function (json, i) { attach(json, i, good.length); });
        return instances;
      });
    });
  }

  function fetchJSONSafe(url) {
    return fetchJSON(url).then(function (j) { j.__url = url; return j; })
      .catch(function (e) { console.error('[edcity-video] ' + e.message); return null; });
  }

  // Global Escape fallback, in case focus is somewhere outside the drawer.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (document.fullscreenElement) return; // let the mind map leave full-screen first
    for (var i = 0; i < instances.length; i++) {
      if (instances[i].drawerIsOpen) { instances[i].closeDrawer(); break; }
    }
  });

  var API = {
    __loaded: true,
    version: '3.0.2',
    defaults: cfg,
    init: init,
    instances: instances,
    hosts: hosts,
    /** Attach one JSON object by hand: EdCityVideo.add({target:{...}, chapters:[...]}) */
    add: function (json) { collectHosts(); return attach(json, 0, 1); },
    /** Attach one JSON url by hand: EdCityVideo.load('/ai/1_9y0e8yhx_en.json') */
    load: function (url) { collectHosts(); return load(url); },
    /** What players did we find, and what are they playing? (debugging aid) */
    players: function () {
      collectHosts();
      return hosts.map(function (h) {
        return { id: h.node.id, kind: h.adapter.kind, entry: h.adapter.entryId(), taken: h.taken };
      });
    },
    seek: function (entryId, time) {
      for (var i = 0; i < instances.length; i++) {
        if (instances[i].entryId === entryId) { instances[i].seek(time); return true; }
      }
      return false;
    },
    get: function (entryId) {
      for (var i = 0; i < instances.length; i++) if (instances[i].entryId === entryId) return instances[i];
      return null;
    },
    openPanel: function (entryId) {
      var e = API.get(entryId);
      if (e) { e.openDrawer(); return true; }
      return false;
    },
    closePanel: function (entryId) {
      var e = API.get(entryId);
      if (e) { e.closeDrawer(); return true; }
      return false;
    },
    parseTime: parseTime,
    formatTime: formatTime
  };
  window.EdCityVideo = API;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})();
