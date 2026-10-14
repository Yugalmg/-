/* =====================================================================
 * 数学符号编辑器 · 主逻辑
 * 依赖：symbols.js（符号数据）、lib/tex-mml-svg.js（MathJax 排版引擎）
 * ===================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  /* ------------------------------------------------------------------ */
  /* 0. MathJax 就绪检测                                                 */
  /* ------------------------------------------------------------------ */
  var mjxReady = false;
  var mjxNote = '';

  function bootMathJax() {
    if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
      window.MathJax.startup.promise.then(function () {
        mjxReady = true;
        mjxNote = '';
        renderNow();
        // 引擎就绪前先渲染过的面板，这里重新排版一次
        libRendered = false;
        renderLibrary();
        renderSnippets();
        renderHistory();
      })['catch'](function (e) {
        mjxNote = '排版引擎启动失败：' + e;
        renderNow();
      });
      return;
    }
    // 本地引擎缺失时，退回到在线 CDN（没有网络时仍然只有纯文本可用）
    mjxNote = '未找到本地排版引擎，正在尝试联网加载…';
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-svg.js';
    s.onload = function () { setTimeout(bootMathJax, 0); };
    s.onerror = function () {
      mjxNote = '排版引擎加载失败：请确认 lib/tex-mml-svg.js 文件存在（公式将以源码形式显示）。';
      renderNow();
    };
    document.head.appendChild(s);
  }

  /* ------------------------------------------------------------------ */
  /* 1. 通用小工具                                                       */
  /* ------------------------------------------------------------------ */
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2200);
  }

  function copyText(text, okMsg) {
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? (okMsg || '已复制') : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg || '已复制', 'ok');
      }, legacy);
    } else { legacy(); }
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function store(key, val) {
    try {
      if (val === undefined) { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* 无痕模式等情况下忽略 */ }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 2. 排版与预览                                                       */
  /* ------------------------------------------------------------------ */
  var EX_PX = 8;           // MathJax em/ex 选项换算成像素的基准
  var lastSVG = null;      // 最近一次成功排版的 <svg> 元素
  var lastTex = '';

  function renderNow() {
    var inputEl = $('#input'), previewEl = $('#preview'), errEl = $('#err');
    var tex = inputEl.value;

    if (!tex.trim()) {
      lastSVG = null; lastTex = '';
      previewEl.className = 'preview empty';
      previewEl.textContent = '在左侧点选符号，或直接在上面输入 LaTeX 公式，例如：\\int_0^1 x^2\\,\\mathrm{d}x';
      errEl.hidden = true;
      return;
    }
    if (!mjxReady) {
      previewEl.className = 'preview empty';
      previewEl.textContent = mjxNote || '排版引擎加载中…';
      errEl.hidden = true;
      return;
    }
    try {
      var node = window.MathJax.tex2svg(tex, { display: true, em: 16, ex: EX_PX });
      if (typeof node === 'string') {
        previewEl.innerHTML = node;
      } else {
        previewEl.replaceChildren(node);
      }
      previewEl.className = 'preview';
      lastSVG = previewEl.querySelector('svg');
      lastTex = tex;
      errEl.hidden = true;
    } catch (e) {
      // 少数情况（首次用到某个扩展包）需要异步重试
      if (window.MathJax.tex2svgPromise) {
        try {
          window.MathJax.tex2svgPromise(tex, { display: true, em: 16, ex: EX_PX }).then(function (n) {
            previewEl.replaceChildren(n);
            previewEl.className = 'preview';
            lastSVG = previewEl.querySelector('svg');
            lastTex = tex;
            errEl.hidden = true;
          }, function (e2) { showErr(e2); });
          return;
        } catch (e3) { /* 继续走下面的错误提示 */ }
      }
      showErr(e);
    }
  }

  function showErr(e) {
    var errEl = $('#err');
    lastSVG = null;
    var msg = (e && (e.message || e.toString())) || '未知错误';
    msg = msg.replace(/^MathJax:\s*/, '');
    errEl.hidden = false;
    errEl.textContent = '✗ 公式有语法错误：' + msg.split('\n')[0];
  }
  var renderSoon = debounce(renderNow, 140);

  /* 把公式排版成独立的 SVG 字符串（用于复制/导出） */
  function buildSVGData(scale) {
    if (!lastSVG) return null;
    var clone = lastSVG.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    var w = parseFloat(String(lastSVG.getAttribute('width')).replace('ex', ''));
    var h = parseFloat(String(lastSVG.getAttribute('height')).replace('ex', ''));
    if (!isFinite(w) || !isFinite(h)) {
      var r = lastSVG.getBoundingClientRect();
      w = r.width / EX_PX; h = r.height / EX_PX;
    }
    var pxW = Math.max(1, Math.round(w * EX_PX * scale));
    var pxH = Math.max(1, Math.round(h * EX_PX * scale));
    clone.setAttribute('width', pxW);
    clone.setAttribute('height', pxH);
    clone.removeAttribute('style');
    return { markup: new XMLSerializer().serializeToString(clone), w: pxW, h: pxH };
  }

  function svgToPngBlob(svgMarkup, pxW, pxH, cb) {
    var blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = pxW; c.height = pxH;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0, pxW, pxH);
      URL.revokeObjectURL(url);
      if (c.toBlob) { c.toBlob(function (b) { cb(b); }, 'image/png'); }
      else { cb(null); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  /* ------------------------------------------------------------------ */
  /* 3. 编辑器：插入 / 占位符 / 历史                                     */
  /* ------------------------------------------------------------------ */
  var inputEl, history = [], histIdx = -1, restoring = false;
  var marks = [], markIdx = 0, lastLen = 0;

  function snapshot() {
    if (restoring) return;
    var v = inputEl.value;
    if (histIdx >= 0 && history[histIdx] === v) return;
    history = history.slice(0, histIdx + 1);
    history.push(v);
    if (history.length > 200) history.shift();
    histIdx = history.length - 1;
    store('mse.lastInput', v);
  }

  function undo() {
    if (histIdx > 0) {
      histIdx--;
      restoring = true;
      inputEl.value = history[histIdx];
      restoring = false;
      marks = [];
      renderNow();
      store('mse.lastInput', inputEl.value);
    }
  }
  function redo() {
    if (histIdx < history.length - 1) {
      histIdx++;
      restoring = true;
      inputEl.value = history[histIdx];
      restoring = false;
      marks = [];
      renderNow();
      store('mse.lastInput', inputEl.value);
    }
  }

  /* 插入代码：支持 $1 $2 $3 占位符，可把选中内容放进第一个占位符 */
  function insertCode(tpl) {
    var replaceAll = $('#insertMode').value === 'replace';
    var value = inputEl.value;
    var start, end;

    if (replaceAll) { start = 0; end = value.length; }
    else { start = inputEl.selectionStart; end = inputEl.selectionEnd; }

    snapshot();

    var sel = value.slice(start, end);
    if (replaceAll) sel = '';
    // 拆出 $1 $2 … 占位符
    var out = '', last = 0, found = [], m;
    var re = /\$([1-9])/g;
    while ((m = re.exec(tpl)) !== null) {
      out += tpl.slice(last, m.index);
      found.push({ i: out.length, n: Number(m[1]) });
      last = re.lastIndex;
    }
    out += tpl.slice(last);

    if (sel && found.length) {
      var first = found[0];
      var wrapped = out.slice(0, first.i) + sel + out.slice(first.i);
      for (var k = 1; k < found.length; k++) found[k].i += sel.length;
      out = wrapped;
    }

    inputEl.value = value.slice(0, start) + out + value.slice(end);
    if (replaceAll) {
      inputEl.focus();
      inputEl.setSelectionRange(start + out.length, start + out.length);
      marks = [];
    } else if (found.length) {
      marks = found.map(function (f) { return start + f.i; });
      markIdx = 0;
      inputEl.focus();
      setCaret(marks[0]);
    } else {
      marks = [];
      inputEl.focus();
      setCaret(start + out.length);
    }
    lastLen = inputEl.value.length;
    renderSoon();
  }

  function setCaret(pos) {
    pos = Math.max(0, Math.min(inputEl.value.length, pos));
    inputEl.setSelectionRange(pos, pos);
  }

  function jumpMark(dir) {
    if (!marks.length) return false;
    var next = markIdx + dir;
    if (next < 0) return false;
    if (next >= marks.length) { marks = []; markIdx = 0; return false; }
    markIdx = next;
    setCaret(marks[markIdx]);
    return true;
  }

  /* 用户在框里打字后，让占位符位置跟着移动 */
  function syncMarks() {
    var now = inputEl.value.length;
    var delta = now - lastLen;
    if (delta !== 0 && marks.length) {
      var pos = inputEl.selectionStart;
      for (var i = 0; i < marks.length; i++) {
        if (marks[i] > pos) marks[i] += delta;
      }
    }
    lastLen = now;
  }

  /* ------------------------------------------------------------------ */
  /* 4. 智能转换：把随手输入的写法变成规范 LaTeX                          */
  /* ------------------------------------------------------------------ */
  var UNICODE_MAP = [
    ['×', '\\times '], ['÷', '\\div '], ['±', '\\pm '], ['∓', '\\mp '],
    ['≤', '\\le '], ['≥', '\\ge '], ['≠', '\\ne '], ['≈', '\\approx '],
    ['≡', '\\equiv '], ['∞', '\\infty '], ['→', '\\to '], ['←', '\\leftarrow '],
    ['↔', '\\leftrightarrow '], ['⇒', '\\Rightarrow '], ['⇔', '\\Leftrightarrow '],
    ['∈', '\\in '], ['∉', '\\notin '], ['⊂', '\\subset '], ['⊆', '\\subseteq '],
    ['∪', '\\cup '], ['∩', '\\cap '], ['∅', '\\emptyset '], ['√', '\\sqrt{}'],
    ['∑', '\\sum '], ['∏', '\\prod '], ['∫', '\\int '], ['∂', '\\partial '],
    ['∇', '\\nabla '], ['∀', '\\forall '], ['∃', '\\exists '], ['¬', '\\neg '],
    ['∴', '\\therefore '], ['∵', '\\because '], ['⋅', '\\cdot '], ['·', '\\cdot '],
    ['°', '^{\\circ}'], ['′', '^{\\prime}'], ['″', '^{\\prime\\prime}'],
    ['∠', '\\angle '], ['⊥', '\\perp '],
    ['π', '\\pi '], ['α', '\\alpha '], ['β', '\\beta '], ['γ', '\\gamma '],
    ['δ', '\\delta '], ['ε', '\\varepsilon '], ['θ', '\\theta '], ['λ', '\\lambda '],
    ['μ', '\\mu '], ['σ', '\\sigma '], ['φ', '\\varphi '], ['ω', '\\omega '],
    ['Δ', '\\Delta '], ['Σ', '\\Sigma '], ['Ω', '\\Omega '], ['Γ', '\\Gamma '],
    ['²', '^{2}'], ['³', '^{3}'], ['¹', '^{1}'], ['⁰', '^{0}'],
    ['₀', '_{0}'], ['₁', '_{1}'], ['₂', '_{2}'], ['₃', '_{3}'], ['ₙ', '_{n}'],
    ['（', '('], ['）', ')'], ['　', ' ']
  ];
  var FUNC_NAMES = ['arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos',
    'tan', 'cot', 'sec', 'csc', 'ln', 'lg', 'log', 'exp', 'lim', 'max', 'min',
    'sup', 'inf', 'det', 'dim', 'ker', 'gcd', 'arg'];
  var GREEK_NAMES = ['varepsilon', 'vartheta', 'varphi', 'varsigma', 'varpi', 'varrho',
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota',
    'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
    'phi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi',
    'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'];

  function smartConvert(text) {
    var s = text;
    var i;
    var FN = 'arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|lg|log|exp';

    // 把 < > 尖括号等 HTML 敏感字符之外的 Unicode 数学符号换成 LaTeX
    for (i = 0; i < UNICODE_MAP.length; i++) {
      s = s.split(UNICODE_MAP[i][0]).join(UNICODE_MAP[i][1]);
    }
    // 常见键盘写法
    s = s.replace(/<=>|<->|=>|->|!=|<=|>=|\*\*/g, function (m) {
      return ({ '<=>': '\\iff ', '<->': '\\leftrightarrow ', '=>': '\\implies ',
        '->': '\\to ', '!=': '\\ne ', '<=': '\\le ', '>=': '\\ge ',
        '**': '^' })[m];
    });
    // 常见口语/英文词
    var WORD_MAP = [['because', '\\because '], ['therefore', '\\therefore '],
      ['forall', '\\forall '], ['exists', '\\exists '], ['iff', '\\iff '],
      ['oo', '\\infty ']];
    for (i = 0; i < WORD_MAP.length; i++) {
      s = s.replace(new RegExp('(?<![\\\\A-Za-z])' + WORD_MAP[i][0] + '(?![A-Za-z])', 'gi'),
        WORD_MAP[i][1]);
    }
    // sinx / cosx / lnx 这类函数名紧贴着单个变量的写法
    s = s.replace(new RegExp('(?<![\\\\A-Za-z])(' + FN + ')(?=[xyztnuv](?![A-Za-z0-9]))', 'g'),
      function (m) { return '\\' + m + ' '; });
    // 函数名加反斜杠
    s = s.replace(new RegExp('(?<![\\\\A-Za-z])(' + FUNC_NAMES.join('|') + ')(?![A-Za-z])', 'g'),
      function (m) { return '\\' + m + ' '; });
    // 希腊字母名加反斜杠
    s = s.replace(new RegExp('(?<![\\\\A-Za-z])(' + GREEK_NAMES.join('|') + ')(?![A-Za-z])', 'g'),
      function (m) { return '\\' + m + ' '; });
    // sqrt(x) → \sqrt{x}
    s = s.replace(/(?<![\\A-Za-z])sqrt\s*\(([^()]*)\)/g, '\\sqrt{$1}');
    s = s.replace(/(?<![\\A-Za-z])sqrt\s*([A-Za-z0-9]+)/g, '\\sqrt{$1}');
    // a/b → \frac{a}{b}，sinx/x → \frac{\sin x}{x}（只做一轮，避免破坏已写好的结构）
    function strip(x) {
      return (x[0] === '(' && x.slice(-1) === ')') ? x.slice(1, -1) : x;
    }
    var FN_PREFIX = '\\\\(?:' + FN + ')\\s+';   // 形如 “\sin ” 的前缀
    s = s.replace(
      new RegExp('(?<![A-Za-z0-9])(' + FN_PREFIX + ')?(\\([^()]*\\)|[A-Za-z0-9]+)' +
        '\\s*\\/\\s*(\\([^()]*\\)|[A-Za-z0-9]+)(?![A-Za-z0-9(])', 'g'),
      function (m, fn, a, b) {
        if (a.indexOf('\\') >= 0 || b.indexOf('\\') >= 0) return m;
        return '\\frac{' + (fn || '') + strip(a) + '}{' + strip(b) + '}';
      });
    // dx / dy / dt → \mathrm{d}x（正体微分符号，更符合教材排版）
    s = s.replace(/(?<![\\A-Za-z{])d([xyzt])(?![A-Za-z])/g, '\\mathrm{d}$1');
    // e^-x、e^(-x^2)、a^10 这类写法补上花括号（不动 x^2y 这种本来就正确的写法）
    var ATOM = '(\\([^()]*\\)|[-+][A-Za-z0-9]+|\\d{2,})';
    s = s.replace(new RegExp('\\^' + ATOM, 'g'), '^{$1}');
    s = s.replace(new RegExp('_' + ATOM, 'g'), '_{$1}');
    // `...` → \cdots
    s = s.replace(/\.\.\./g, '\\cdots ');
    // 收拾多余空格与标点前的空格
    s = s.replace(/[ \t]{2,}/g, ' ')
         .replace(/\s+([,;.\)\]])/g, '$1')
         .replace(/\s*\n\s*/g, '\n');
    return s.trim();
  }

  /* ------------------------------------------------------------------ */
  /* 5. 复制的几种形态                                                   */
  /* ------------------------------------------------------------------ */
  function currentTex() { return inputEl.value.trim(); }

  function copyLatex() {
    var t = currentTex();
    if (!t) { toast('还没有内容', 'err'); return; }
    copyText(t, '已复制 LaTeX 源码');
    pushHistoryItem(t);
  }

  function copyInline() {
    var t = currentTex();
    if (!t) { toast('还没有内容', 'err'); return; }
    copyText('$' + t.replace(/\n/g, ' ') + '$', '已复制 Markdown 行内公式 $…$');
  }

  function copyBlock() {
    var t = currentTex();
    if (!t) { toast('还没有内容', 'err'); return; }
    copyText('$$\n' + t + '\n$$', '已复制 Markdown 行间公式 $$…$$');
  }

  function copyMathML() {
    var t = currentTex();
    if (!t || !mjxReady) { toast('还没有可转换的公式', 'err'); return; }
    var mml;
    try { mml = window.MathJax.tex2mml(t, { display: true }); }
    catch (e) { toast('MathML 转换失败：' + e.message, 'err'); return; }
    var html = '<html><body>' + mml + '</body></html>';
    if (navigator.clipboard && window.ClipboardItem) {
      var item = new ClipboardItem({
        'text/plain': new Blob([mml], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' })
      });
      navigator.clipboard.write([item]).then(function () {
        toast('已复制 MathML，可直接粘进 Word / WPS', 'ok');
        pushHistoryItem(t);
      }, function () { copyText(mml, '已复制 MathML（纯文本）'); });
    } else {
      copyText(mml, '已复制 MathML');
    }
  }

  function copyImage() {
    if (!lastSVG) { toast('还没有渲染好的公式', 'err'); return; }
    var d = buildSVGData(3);
    svgToPngBlob(d.markup, d.w, d.h, function (blob) {
      if (!blob) { toast('图片生成失败', 'err'); return; }
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () {
          toast('已复制公式图片，可直接粘贴到 Word / PPT', 'ok');
        }, function () {
          download(blob, 'math-formula.png');
          toast('浏览器不允许直接复制图片，已改为下载 PNG', 'ok');
        });
      } else {
        download(blob, 'math-formula.png');
      }
    });
  }

  function exportSVG() {
    if (!lastSVG) { toast('还没有渲染好的公式', 'err'); return; }
    var d = buildSVGData(2);
    download(new Blob([d.markup], { type: 'image/svg+xml;charset=utf-8' }), 'math-formula.svg');
    toast('已导出 SVG', 'ok');
  }

  function exportPNG() {
    if (!lastSVG) { toast('还没有渲染好的公式', 'err'); return; }
    var scale = Number($('#pngScale').value) || 4;
    var d = buildSVGData(scale);
    svgToPngBlob(d.markup, d.w, d.h, function (blob) {
      if (!blob) { toast('图片生成失败', 'err'); return; }
      download(blob, 'math-formula@' + scale + 'x.png');
      toast('已导出 PNG（' + scale + ' 倍分辨率）', 'ok');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 6. 符号面板                                                         */
  /* ------------------------------------------------------------------ */
  function buildPalette() {
    var body = $('#paletteBody');
    var chips = $('#chips');
    var frag = document.createDocumentFragment();
    var chipFrag = document.createDocumentFragment();

    window.SYMBOL_GROUPS.forEach(function (g, gi) {
      var sec = document.createElement('section');
      sec.className = 'group';
      sec.dataset.group = gi;

      var head = document.createElement('h3');
      head.textContent = g.name;
      sec.appendChild(head);

      var box = document.createElement('div');
      box.className = 'symbox';
      g.items.forEach(function (it) {
        var tex = it[0], label = it[1], keys = it[2] || '';
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'sym' + (label.length > 2 ? ' wide' : '');
        b.textContent = label;
        b.title = tex + (keys ? '  ——  ' + keys : '');
        b.dataset.tex = tex;
        b.dataset.keys = (keys + ' ' + tex).toLowerCase();
        b.addEventListener('click', function () { insertCode(tex); });
        box.appendChild(b);
      });
      sec.appendChild(box);
      frag.appendChild(sec);

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = g.name;
      chip.addEventListener('click', function () {
        sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
      chipFrag.appendChild(chip);
    });
    body.appendChild(frag);
    chips.appendChild(chipFrag);
  }

  function filterPalette(q) {
    q = q.trim().toLowerCase();
    var groups = $('#paletteBody').querySelectorAll('.group');
    var total = 0;
    Array.prototype.forEach.call(groups, function (sec) {
      var shown = 0;
      var btns = sec.querySelectorAll('.sym');
      Array.prototype.forEach.call(btns, function (b) {
        var hit = !q || b.dataset.keys.indexOf(q) >= 0 || b.textContent.toLowerCase().indexOf(q) >= 0;
        b.hidden = !hit;
        if (hit) shown++;
      });
      sec.hidden = shown === 0;
      total += shown;
    });
    $('#paletteTip').textContent = q ? ('匹配到 ' + total + ' 个符号') : '';
  }

  /* ------------------------------------------------------------------ */
  /* 7. 公式库 / 收藏 / 历史                                             */
  /* ------------------------------------------------------------------ */
  var libRendered = false;

  function miniRender(host, tex) {
    if (!mjxReady) { host.textContent = tex; return; }
    try {
      var node = window.MathJax.tex2svg(tex, { display: false, em: 16, ex: EX_PX });
      if (typeof node === 'string') host.innerHTML = node; else host.replaceChildren(node);
    } catch (e) { host.textContent = tex; }
  }

  function makeItem(name, tex, onDelete) {
    var card = document.createElement('div');
    card.className = 'card';
    card.title = '点击：载入到编辑器　|　Shift+点击：插入到光标处\n' + tex;

    var head = document.createElement('div');
    head.className = 'card-head';
    var title = document.createElement('span');
    title.className = 'card-name';
    title.textContent = name;
    head.appendChild(title);
    if (onDelete) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除';
      del.addEventListener('click', function (ev) { ev.stopPropagation(); onDelete(); });
      head.appendChild(del);
    }
    card.appendChild(head);

    var view = document.createElement('div');
    view.className = 'card-body';
    card.appendChild(view);

    card.addEventListener('click', function (ev) {
      if (ev.shiftKey) { insertCode(tex); }
      else {
        snapshot();
        inputEl.value = tex;
        inputEl.focus();
        marks = [];
        lastLen = tex.length;
        renderNow();
        store('mse.lastInput', tex);
      }
    });
    card._render = function () { miniRender(view, tex); };
    return card;
  }

  function renderLibrary() {
    if (libRendered) return;
    libRendered = true;
    var host = $('#libList');
    var q = ($('#libSearch').value || '').trim().toLowerCase();
    host.innerHTML = '';
    var cats = {};
    var order = [];
    window.FORMULA_LIB.forEach(function (f) {
      if (q && (f.name + ' ' + f.cat + ' ' + f.tex).toLowerCase().indexOf(q) < 0) return;
      if (!cats[f.cat]) { cats[f.cat] = []; order.push(f.cat); }
      cats[f.cat].push(f);
    });
    if (!order.length) { host.innerHTML = '<p class="muted">没有匹配的公式</p>'; return; }
    var cards = [];
    order.forEach(function (c) {
      var h = document.createElement('h3');
      h.textContent = c;
      host.appendChild(h);
      cats[c].forEach(function (f) {
        var card = makeItem(f.name, f.tex, null);
        host.appendChild(card);
        cards.push(card);
      });
    });
    // 分批渲染，避免一次性排版太多公式造成卡顿
    var idx = 0;
    (function step() {
      var end = Math.min(idx + 6, cards.length);
      for (; idx < end; idx++) cards[idx]._render();
      if (idx < cards.length) requestAnimationFrame(step);
    })();
  }

  function snippets() { return store('mse.snippets') || []; }
  function saveSnippets(list) { store('mse.snippets', list); renderSnippets(); }

  function renderSnippets() {
    var host = $('#favList');
    var list = snippets();
    host.innerHTML = '';
    if (!list.length) {
      host.innerHTML = '<p class="muted">还没有收藏。写好一个公式后点上面的「☆ 收藏当前公式」。</p>';
      return;
    }
    var cards = list.map(function (item, i) {
      var card = makeItem(item.name, item.tex, function () {
        var l = snippets();
        l.splice(i, 1);
        saveSnippets(l);
        toast('已删除');
      });
      host.appendChild(card);
      return card;
    });
    var idx = 0;
    (function step() {
      var end = Math.min(idx + 6, cards.length);
      for (; idx < end; idx++) cards[idx]._render();
      if (idx < cards.length) requestAnimationFrame(step);
    })();
  }

  function addFavorite() {
    var t = currentTex();
    if (!t) { toast('还没有内容', 'err'); return; }
    var list = snippets();
    if (list.some(function (x) { return x.tex === t; })) { toast('这个公式已经收藏过了'); return; }
    var name = window.prompt('给这个公式起个名字（方便以后查找）：', t.replace(/\s+/g, ' ').slice(0, 20));
    if (name === null) return;
    list.unshift({ name: name.trim() || '未命名公式', tex: t });
    saveSnippets(list);
    toast('已加入收藏', 'ok');
    switchTab('fav');
  }

  function pushHistoryItem(tex) {
    if (!tex) return;
    var list = store('mse.history') || [];
    if (list[0] === tex) return;
    list = list.filter(function (x) { return x !== tex; });
    list.unshift(tex);
    if (list.length > 40) list.length = 40;
    store('mse.history', list);
    renderHistory();
  }

  function renderHistory() {
    var host = $('#histList');
    if (!host) return;
    var list = store('mse.history') || [];
    host.innerHTML = '';
    if (!list.length) { host.innerHTML = '<p class="muted">复制过的公式会自动出现在这里。</p>'; return; }
    var cards = list.map(function (tex) {
      var card = makeItem(tex.replace(/\s+/g, ' ').slice(0, 26) + (tex.length > 26 ? '…' : ''), tex, null);
      host.appendChild(card);
      return card;
    });
    var idx = 0;
    (function step() {
      var end = Math.min(idx + 6, cards.length);
      for (; idx < end; idx++) cards[idx]._render();
      if (idx < cards.length) requestAnimationFrame(step);
    })();
  }

  function switchTab(which) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.tab === which);
    });
    $('#panel-lib').hidden = which !== 'lib';
    $('#panel-fav').hidden = which !== 'fav';
    $('#panel-hist').hidden = which !== 'hist';
    if (which === 'lib') renderLibrary();
    if (which === 'fav') renderSnippets();
    if (which === 'hist') renderHistory();
  }

  /* ------------------------------------------------------------------ */
  /* 8. 初始化                                                            */
  /* ------------------------------------------------------------------ */
  function init() {
    inputEl = $('#input');

    var savedTheme = store('mse.theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;

    var savedZoom = store('mse.zoom') || 130;
    $('#zoom').value = savedZoom;
    $('#preview').style.fontSize = (savedZoom / 100 * 16) + 'px';

    var savedMode = store('mse.insertMode');
    if (savedMode) $('#insertMode').value = savedMode;

    buildPalette();
    filterPalette('');

    var lastInput = store('mse.lastInput');
    inputEl.value = lastInput || '';
    history = [inputEl.value];
    histIdx = 0;
    lastLen = inputEl.value.length;

    // 输入
    inputEl.addEventListener('input', function () {
      syncMarks();
      renderSoon();
      debounce(snapshot, 700)();
    });
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && marks.length) {
        if (jumpMark(e.shiftKey ? -1 : 1)) { e.preventDefault(); }
        else { e.preventDefault(); marks = []; toast('占位符已跳完'); }
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); renderNow(); copyLatex(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    });

    // 搜索
    $('#search').addEventListener('input', function (e) { filterPalette(e.target.value); });
    $('#libSearch').addEventListener('input', function () { libRendered = false; renderLibrary(); });

    // 按钮
    $('#insertMode').addEventListener('change', function (e) { store('mse.insertMode', e.target.value); });
    $('#zoom').addEventListener('change', function (e) {
      var z = Number(e.target.value);
      $('#preview').style.fontSize = (z / 100 * 16) + 'px';
      store('mse.zoom', z);
    });
    $('#btnClear').addEventListener('click', function () {
      snapshot();
      inputEl.value = '';
      marks = [];
      lastLen = 0;
      renderNow();
      inputEl.focus();
    });
    $('#btnUndo').addEventListener('click', undo);
    $('#btnSmart').addEventListener('click', function () {
      var before = inputEl.value;
      var after = smartConvert(before);
      if (after === before.trim()) { toast('已经是规范的 LaTeX 了'); return; }
      snapshot();
      inputEl.value = after;
      marks = [];
      lastLen = after.length;
      renderNow();
      pushHistoryItem(after);
      toast('已智能转换为 LaTeX（Ctrl+Z 可撤销）', 'ok');
    });
    $('#btnFav').addEventListener('click', addFavorite);
    $('#btnCopyLatex').addEventListener('click', copyLatex);
    $('#btnCopyInline').addEventListener('click', copyInline);
    $('#btnCopyBlock').addEventListener('click', copyBlock);
    $('#btnCopyMathML').addEventListener('click', copyMathML);
    $('#btnCopyImg').addEventListener('click', copyImage);
    $('#btnSvg').addEventListener('click', exportSVG);
    $('#btnPng').addEventListener('click', exportPNG);
    $('#btnTheme').addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store('mse.theme', next);
    });
    $('#btnHelp').addEventListener('click', function () { $('#modal').hidden = false; });
    $('#modalClose').addEventListener('click', function () { $('#modal').hidden = true; });
    $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') $('#modal').hidden = true; });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal').hidden) $('#modal').hidden = true;
    });
    $('#btnExportFav').addEventListener('click', function () {
      download(new Blob([JSON.stringify(snippets(), null, 2)], { type: 'application/json' }), 'math-snippets.json');
    });
    $('#btnImportFav').addEventListener('click', function () { $('#favFile').click(); });
    $('#favFile').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(String(r.result));
          if (!Array.isArray(data)) throw new Error('格式不对');
          var list = snippets();
          data.forEach(function (d) {
            if (d && d.tex) list.push({ name: d.name || '导入的公式', tex: d.tex });
          });
          saveSnippets(list);
          toast('已导入 ' + data.length + ' 条收藏', 'ok');
          switchTab('fav');
        } catch (err) { toast('导入失败：' + err.message, 'err'); }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });

    switchTab('lib');
    bootMathJax();
    renderNow();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* 供自动化测试与外部脚本调用 */
  window.__mathEditor = {
    isReady: function () { return mjxReady; },
    note: function () { return mjxNote; },
    tex2svg: function (t) { return window.MathJax.tex2svg(t, { display: true, em: 16, ex: EX_PX }); },
    svgInfo: function () { return lastSVG; },
    buildSVGData: buildSVGData,
    svgToPngBlob: svgToPngBlob,
    smartConvert: smartConvert,
    setInput: function (t) { inputEl.value = t; lastLen = t.length; renderNow(); return inputEl.value; },
    getInput: function () { return inputEl.value; }
  };
})();
