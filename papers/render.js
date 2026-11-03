/* render.js：Obsidian 风格 Markdown -> HTML 渲染管线（KaTeX 公式 + marked + highlight.js） */
(function () {
  'use strict';

  const MACROS = {
    '\\bm': '\\boldsymbol{#1}',
    '\\argmax': '\\operatorname*{arg\\,max}',
    '\\argmin': '\\operatorname*{arg\\,min}',
    '\\R': '\\mathbb{R}',
    '\\E': '\\mathbb{E}',
    '\\mathbbm': '\\mathbb{#1}',
    '\\dd': '\\mathrm{d}',
    '\\KL': '\\mathrm{KL}'
  };

  const mathCache = new Map();
  let bashGrammarEnhanced = false;

  function ensureEnhancedBashGrammar() {
    if (bashGrammarEnhanced || !window.hljs || !window.hljs.getLanguage) return;
    const origLang = window.hljs.getLanguage('bash');
    if (!origLang || typeof origLang.rawDefinition !== 'function') return;
    bashGrammarEnhanced = true;

    const origDef = origLang.rawDefinition;
    window.hljs.registerLanguage('bash', function (hljs) {
      const base = origDef(hljs);
      const extraBuiltins = [
        'python', 'python3', 'pip', 'pip3', 'uv', 'conda', 'mamba', 'micromamba', 'poetry', 'pipx', 'pytest',
        'torchrun', 'accelerate', 'deepspeed', 'vllm', 'sglang', 'uvicorn', 'gunicorn', 'gradio', 'streamlit',
        'tensorboard', 'wandb', 'huggingface-cli', 'hf', 'ollama', 'ray',
        'git', 'gh', 'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'tmux', 'screen', 'nohup',
        'curl', 'wget', 'ssh', 'scp', 'rsync', 'sftp', 'ping', 'nc', 'netstat', 'ss', 'ip', 'ifconfig', 'lsof',
        'find', 'grep', 'egrep', 'fgrep', 'rg', 'fd', 'ag', 'sed', 'awk', 'gawk', 'xargs', 'sort', 'uniq',
        'wc', 'cut', 'tr', 'paste', 'tee', 'head', 'tail', 'less', 'more', 'cat', 'tac', 'nl', 'diff', 'patch', 'jq', 'yq',
        'ls', 'll', 'la', 'tree', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln', 'touch', 'chmod', 'chown', 'chgrp',
        'file', 'realpath', 'dirname', 'basename', 'mktemp', 'du', 'df', 'free', 'top', 'htop', 'btop', 'ps',
        'pgrep', 'pkill', 'killall', 'watch', 'time', 'timeout', 'env', 'printenv', 'date', 'uname', 'hostname', 'whoami',
        'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz', '7z', 'zstd',
        'sudo', 'su', 'apt', 'apt-get', 'apt-cache', 'dpkg', 'yum', 'dnf', 'pacman', 'apk', 'brew',
        'systemctl', 'service', 'journalctl', 'crontab',
        'npm', 'npx', 'yarn', 'pnpm', 'bun', 'node', 'deno', 'tsx', 'tsc', 'hexo',
        'gcc', 'g++', 'clang', 'clang++', 'cc', 'c++', 'make', 'cmake', 'ninja', 'cargo', 'rustc', 'go',
        'nvcc', 'nvidia-smi', 'nsys', 'ncu', 'ffmpeg', 'ffprobe', 'vim', 'nvim', 'nano', 'code', 'open',
        'bash', 'sh', 'zsh', 'fish'
      ];
      const subcommands = [
        'install', 'uninstall', 'freeze', 'download', 'wheel',
        'create', 'activate', 'deactivate', 'remove',
        'serve', 'launch', 'train', 'predict',
        'clone', 'commit', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'pull', 'push', 'fetch', 'status', 'add', 'reset', 'stash', 'tag', 'remote',
        'run', 'build', 'compose', 'images', 'logs', 'stop', 'start', 'restart', 'reload',
        'update', 'upgrade', 'search', 'list', 'info', 'show', 'clean', 'init', 'new', 'generate', 'deploy'
      ];

      base.aliases = ['sh', 'zsh', 'shell'];
      base.keywords.built_in = Array.from(new Set([].concat(base.keywords.built_in || [], extraBuiltins)));
      base.keywords.literal = Array.from(new Set([].concat(base.keywords.literal || [], subcommands)));

      // 移除原本无样式的纯路径吞噬规则，改为带样式的路径/文件名与参数高亮
      base.contains = (base.contains || []).filter(function (c) {
        return !(c && c.match && String(c.match) === '/(\\/[a-z._-]+)+/');
      });

      base.contains.push(
        { className: 'string', match: /\b(?:git\+)?https?:\/\/[^\s"'<>]+/ },
        { className: 'variable', match: /\b[A-Z_][A-Z0-9_]*(?==)/ },
        { className: 'attr', match: /(?<=^|[ \t])(--?[a-zA-Z0-9][a-zA-Z0-9_-]*)(?=[ \t=]|$)/m },
        { className: 'number', match: /\bcuda:\d+\b/ },
        {
          className: 'symbol',
          match: /(?:~|\.{1,2}|<[A-Za-z0-9_.-]+>)?(?:\/[A-Za-z0-9._+-]+)+\/?|\b[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+\/?|\b[A-Za-z0-9._-]+\.(?:py|sh|zsh|bash|yaml|yml|json|jsonl|toml|cfg|ini|conf|md|txt|log|csv|tsv|pt|pth|ckpt|safetensors|onnx|bin|tar|gz|tgz|zip|whl|jpg|jpeg|png|webp|mp4|ply|obj|glb|gltf|cu|cpp|c|h|hpp|so)\b/
        },
        { className: 'number', match: /(?:==|>=|<=|~=|!=)?\b\d+(?:\.\d+)*(?:[eE][+-]?\d+)?(?:\.?post\d+|rc\d+|a\d+|b\d+|dev\d+|\+cu\d+)?\b/ },
        { className: 'operator', match: /\\$|\|\||&&|\||>>|2>&1|[<>]/m }
      );
      return base;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function renderMath(tex, display) {
    const key = (display ? 'D:' : 'I:') + tex;
    if (mathCache.has(key)) return mathCache.get(key);
    let html;
    try {
      html = window.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        trust: true,
        strict: 'ignore',
        output: 'htmlAndMathml',
        macros: Object.assign({}, MACROS)
      });
    } catch (e) {
      html = '<span class="math-error" title="' + escapeHtml(String(e.message || e)) + '">' + escapeHtml(tex) + '</span>';
    }
    if (mathCache.size > 6000) mathCache.clear();
    mathCache.set(key, html);
    return html;
  }

  function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    let curKey = null;
    m[1].split(/\r?\n/).forEach(function (line) {
      const li = line.match(/^\s+-\s+(.*)$/);
      if (li && curKey) {
        if (!Array.isArray(meta[curKey])) meta[curKey] = [];
        meta[curKey].push(li[1].trim().replace(/^["']|["']$/g, ''));
        return;
      }
      const kv = line.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5]+):\s*(.*)$/);
      if (kv) {
        curKey = kv[1];
        let v = kv[2].trim();
        if (v === '') { meta[curKey] = []; return; }
        if (v.startsWith('[') && v.endsWith(']')) {
          meta[curKey] = v.slice(1, -1).split(',').map(function (x) { return x.trim().replace(/^["']|["']$/g, ''); }).filter(Boolean);
        } else {
          meta[curKey] = v.replace(/^["']|["']$/g, '');
        }
      }
    });
    return { meta: meta, body: text.slice(m[0].length) };
  }

  /**
   * ctx: { docPath, resolveAsset(rawPath) -> url|null, resolveNote(rawTarget) -> path|null }
   */
  function render(source, ctx) {
    const fm = parseFrontmatter(source);
    let text = fm.body.replace(/\r\n?/g, '\n');

    /* 1) 保护代码块与行内代码 */
    const codeStash = [];
    const putCode = function (raw) { codeStash.push(raw); return '\u0003C' + (codeStash.length - 1) + '\u0004'; };
    text = text.replace(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, function (m, pre) {
      return pre + putCode(m.slice(pre.length));
    });
    text = text.replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, function (m) { return putCode(m); });

    /* 2) 提取公式 */
    const stash = [];
    const put = function (html) { stash.push(html); return '\u0001S' + (stash.length - 1) + '\u0002'; };
    const cleanQuote = function (s) { return s.replace(/^[ \t]*>[ \t]?/gm, '').trim(); };

    text = text.replace(/\$\$([\s\S]{1,8000}?)\$\$/g, function (m, tex) { return put(renderMath(cleanQuote(tex), true)); });
    text = text.replace(/\\\[([\s\S]{1,8000}?)\\\]/g, function (m, tex) { return put(renderMath(cleanQuote(tex), true)); });
    text = text.replace(/\\\(([\s\S]{1,2000}?)\\\)/g, function (m, tex) { return put(renderMath(tex.trim(), false)); });
    text = text.replace(/(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])*?(?:\\.|[^\s$\\]))\$(?!\d)/g, function (m, tex) {
      return put(renderMath(tex, false));
    });

    /* 3) Obsidian 语法 */
    text = text.replace(/%%[\s\S]*?%%/g, '');
    text = text.replace(/!\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\\?\|([^\]]*))?\]\]/g, function (m, target, opt) {
      target = target.trim();
      if (/\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(target)) {
        const info = ctx.resolveAssetInfo ? ctx.resolveAssetInfo(target) : { url: ctx.resolveAsset(target), relPath: target };
        const url = info && info.url;
        const relPath = (info && info.relPath) || target;
        if (!url) return put('<span class="img-missing" data-raw-target="' + escapeHtml(target) + '">未找到图片：' + escapeHtml(target) + '</span>');
        let style = '';
        const sz = opt && opt.trim().match(/^(\d+)(?:x(\d+))?$/);
        if (sz) style = ' style="width:' + sz[1] + 'px;max-width:100%"';
        return put('<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(target) + '" data-vault-path="' + escapeHtml(relPath) + '" data-raw-src="' + escapeHtml(target) + '" loading="lazy"' + style + '>');
      }
      if (/\.pdf$/i.test(target)) {
        const url = ctx.resolveAsset(target);
        return put(url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">PDF: ' + escapeHtml(target.split('/').pop()) + '</a>' : escapeHtml(target));
      }
      const p = ctx.resolveNote(target);
      return put('<a class="internal-link' + (p ? '' : ' missing') + '" data-path="' + escapeHtml(p || '') + '">嵌入笔记：' + escapeHtml(target) + '</a>');
    });
    text = text.replace(/\[\[([^\]\|#]*)(#[^\]\|]*)?(?:\\?\|([^\]]*))?\]\]/g, function (m, target, heading, alias) {
      target = (target || '').trim();
      const label = (alias && alias.trim()) || (target ? target.split('/').pop() : (heading || '').replace(/^#/, ''));
      if (/\.[A-Za-z0-9]{2,4}$/.test(target) && !/\.md$/i.test(target)) {
        const url = ctx.resolveAsset(target);
        return put(url ? '<a href="' + escapeHtml(url) + '" data-raw-wikilink="' + escapeHtml(m) + '" target="_blank" rel="noopener">' + escapeHtml(label) + '</a>' : escapeHtml(label));
      }
      const p = target ? ctx.resolveNote(target) : ctx.docPath;
      return put('<a class="internal-link' + (p ? '' : ' missing') + '" data-raw-wikilink="' + escapeHtml(m) + '" data-path="' + escapeHtml(p || '') + '" data-heading="' +
        escapeHtml((heading || '').replace(/^#/, '')) + '">' + escapeHtml(label) + '</a>');
    });
    text = text.replace(/==([^=\n][^\n]*?)==/g, '<mark>$1</mark>');
    text = text.replace(/[ \t]\^[A-Za-z0-9-]+$/gm, '');
    text = text.replace(/^([ \t]*\|.*\|)[ \t]*\n(?:[ \t]*\n)+(?=[ \t]*\|)/gm, '$1\n');
    text = text.replace(/(!?\[[^\]\n]*\])\(([^()\n]*\s[^()\n]*)\)/g, function (m, head, url) {
      const u = url.trim();
      if (/^<.*>$/.test(u) || /\s+["'][^"']*["']$/.test(u)) return m;
      return head + '(<' + u + '>)';
    });

    /* 4) 还原代码并交给 marked */
    text = text.replace(/\u0003C(\d+)\u0004/g, function (m, i) { return codeStash[+i]; });

    ensureEnhancedBashGrammar();

    const renderer = new window.marked.Renderer();
    renderer.code = function (code, infostring) {
      const rawLang = ((infostring || '').match(/^\S*/) || [''])[0].toLowerCase();
      const lang = /^(sh|shell|zsh|console|terminal)$/.test(rawLang) ? 'bash' : rawLang;
      let body;
      if (lang && window.hljs && window.hljs.getLanguage(lang)) {
        try { body = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch (e) { body = escapeHtml(code); }
      } else {
        body = escapeHtml(code);
      }
      const trimmedLines = String(code || '').replace(/\n$/, '').split('\n');
      const lineCount = trimmedLines.length;
      const firstMeaningful = (
        trimmedLines.find(function (l) { const s = l.trim(); return s.length > 0 && !/^(\/\/|#|--|\/\*)/.test(s); }) ||
        trimmedLines.find(function (l) { return l.trim().length > 0; }) ||
        ''
      ).trim();
      const preview = firstMeaningful.length > 56 ? firstMeaningful.slice(0, 56) + '…' : firstMeaningful;
      const summaryText = lineCount + ' 行' + (preview ? '  ·  ' + preview : '');
      const langBadge = rawLang || 'code';
      return (
        '<pre class="code-block">' +
          '<button type="button" class="code-fold-btn" title="折叠/展开代码" aria-label="折叠或展开代码" aria-expanded="true"></button>' +
          '<span class="code-fold-summary" title="点击展开代码" data-lang="' + escapeHtml(langBadge) + '" data-summary="' + escapeHtml(summaryText) + '"></span>' +
          '<code class="hljs' + (rawLang ? ' language-' + escapeHtml(rawLang) : '') + '">' + body + '\n</code>' +
        '</pre>'
      );
    };
    renderer.image = function (href, title, alt) {
      const raw = safeDecode(href || '');
      const isExternal = /^(https?:|data:|blob:)/i.test(raw);
      const info = isExternal
        ? { url: raw, relPath: '' }
        : (ctx.resolveAssetInfo ? ctx.resolveAssetInfo(raw) : { url: ctx.resolveAsset(raw), relPath: raw });
      const url = info && info.url;
      const relPath = (info && info.relPath) || '';
      if (!url) return '<span class="img-missing" data-raw-target="' + escapeHtml(raw) + '">未找到图片：' + escapeHtml(raw) + '</span>';
      let style = '';
      let altText = alt || '';
      const sz = altText.match(/^(\d+)(?:x(\d+))?$/);
      if (sz) { style = ' style="width:' + sz[1] + 'px;max-width:100%"'; altText = ''; }
      const pathAttr = relPath ? ' data-vault-path="' + escapeHtml(relPath) + '"' : '';
      return '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(altText) + '"' + pathAttr + ' data-raw-src="' + escapeHtml(href || '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy"' + style + '>';
    };
    renderer.link = function (href, title, body) {
      if (!href) return body;
      const t = title ? ' title="' + escapeHtml(title) + '"' : '';
      if (/^(https?:|mailto:|tel:)/i.test(href)) {
        return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"' + t + '>' + body + '</a>';
      }
      if (href.charAt(0) === '#') {
        return '<a href="' + escapeHtml(href) + '" class="anchor-link"' + t + '>' + body + '</a>';
      }
      const dec = safeDecode(href);
      const idx = dec.indexOf('#');
      const pathPart = idx >= 0 ? dec.slice(0, idx) : dec;
      const heading = idx >= 0 ? dec.slice(idx + 1) : '';
      if (/\.md$/i.test(pathPart)) {
        const p = ctx.resolveNote(pathPart);
        return '<a class="internal-link' + (p ? '' : ' missing') + '" data-path="' + escapeHtml(p || '') + '" data-heading="' + escapeHtml(heading) + '"' + t + '>' + body + '</a>';
      }
      const url = ctx.resolveAsset(pathPart);
      return url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener"' + t + '>' + body + '</a>' : body;
    };
    const seen = Object.create(null);
    renderer.heading = function (htmlText, level, raw) {
      let slug = String(raw).trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\u4e00-\u9fa5\- ]+/g, '').replace(/\s+/g, '-') || 'h';
      if (seen[slug] !== undefined) { seen[slug] += 1; slug += '-' + seen[slug]; } else { seen[slug] = 0; }
      return '<h' + level + ' id="' + escapeHtml(slug) + '">' + htmlText + '</h' + level + '>\n';
    };

    let html = window.marked.parse(text, { renderer: renderer, gfm: true, breaks: true, async: false });

    /* 5) 还原公式占位符 */
    html = html.replace(/<p>\s*\u0001S(\d+)\u0002\s*<\/p>/g, function (m, i) {
      return '<div class="math-block">' + stash[+i] + '</div>';
    });
    html = html.replace(/\u0001S(\d+)\u0002/g, function (m, i) {
      const s = stash[+i];
      return s.indexOf('katex-display') >= 0 ? '<span class="math-inline-display">' + s + '</span>' : s;
    });

    return { html: html, meta: fm.meta };
  }

  window.MDR = { render: render, parseFrontmatter: parseFrontmatter, escapeHtml: escapeHtml, safeDecode: safeDecode };
})();
