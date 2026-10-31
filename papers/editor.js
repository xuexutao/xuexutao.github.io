/* editor.js：顶部固定工具栏操作 + 全快捷键支持 + 段落级原位渲染态编辑 (In-place Block Editor) */
(function () {
  'use strict';

  const PRESET_COLORS = [
    { name: '红色', value: 'red', hex: '#ef4444', shortcut: '⌥1' },
    { name: '橙色', value: '#e67e22', hex: '#e67e22', shortcut: '⌥2' },
    { name: '琥珀黄', value: '#d97706', hex: '#d97706', shortcut: '⌥3' },
    { name: '绿色', value: '#16a34a', hex: '#16a34a', shortcut: '⌥4' },
    { name: '蓝色', value: '#2563eb', hex: '#2563eb', shortcut: '⌥5' },
    { name: '紫色', value: '#9333ea', hex: '#9333ea', shortcut: '⌥6' }
  ];

  // Undo & Redo 历史栈：按文档路径存储，支持字符串（纯 Markdown）或 { type: 'md'|'img'|'insert-img', ... }
  const historyMap = new Map(); // path -> { undo: [entry], redo: [entry] }

  function getHistory(docPath) {
    if (!historyMap.has(docPath)) {
      historyMap.set(docPath, { undo: [], redo: [] });
    }
    return historyMap.get(docPath);
  }

  function pushUndo(docPath, oldMarkdownOrEntry) {
    const h = getHistory(docPath);
    const entry = typeof oldMarkdownOrEntry === 'string'
      ? { type: 'md', markdown: oldMarkdownOrEntry }
      : oldMarkdownOrEntry;
    const last = h.undo.length > 0 ? h.undo[h.undo.length - 1] : null;
    if (entry.type === 'md' && last && last.type === 'md' && last.markdown === entry.markdown) {
      return;
    }
    h.undo.push(entry);
    if (h.undo.length > 50) h.undo.shift();
    h.redo.length = 0;
  }

  function canUndo(docPath) {
    return docPath && getHistory(docPath).undo.length > 0;
  }

  function popUndo(docPath, currentMarkdown) {
    const h = getHistory(docPath);
    if (!h.undo.length) return null;
    const prev = h.undo.pop();
    h.redo.push({ type: 'md', markdown: currentMarkdown });
    return prev;
  }

  /**
   * 向上查找最近的段落级块元素（P, LI, H1-H6, TD, TH）
   */
  function findClosestEditableBlock(node, container) {
    let cur = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (cur && cur !== container) {
      if (/^(P|LI|H[1-6]|TD|TH)$/.test(cur.tagName)) {
        // 若命中的是松散列表项 LI，且其内部第一个子元素就是 P，优先定位到该 P，避免把子列表一并框入
        if (cur.tagName === 'LI') {
          const directP = Array.from(cur.children).find(function (c) { return c.tagName === 'P'; });
          if (directP) return directP;
        }
        return cur;
      }
      if (cur.tagName === 'BLOCKQUOTE' || (cur.classList && cur.classList.contains('callout-box'))) {
        const innerP = cur.querySelector('p');
        if (innerP) return innerP;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 将 DOM 片段清理并还原为带公式与换行的纯文本（移除悬浮按钮与子列表，还原 KaTeX 与 <br>）
   */
  function cleanDomFragmentToText(rootNode, isBlockRoot) {
    const clone = rootNode.cloneNode(true);
    if (clone.querySelectorAll) {
      clone.querySelectorAll('.img-edit-toolbar').forEach(function (n) { n.remove(); });
      if (isBlockRoot) {
        clone.querySelectorAll('ul, ol').forEach(function (sub) { sub.remove(); });
      }
      clone.querySelectorAll('.katex').forEach(function (k) {
        const ann = k.querySelector('annotation[encoding="application/x-tex"]');
        const tex = ann ? ann.textContent : '';
        const isDisplay = k.closest('.katex-display') !== null;
        k.parentNode.replaceChild(document.createTextNode(tex ? (isDisplay ? '$$' + tex + '$$' : '$' + tex + '$') : ''), k);
      });
      clone.querySelectorAll('br').forEach(function (br) {
        br.parentNode.replaceChild(document.createTextNode('\n'), br);
      });
    }
    return (clone.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  /**
   * 从浏览器当前的 Selection 中提取干净的选中文本与上下文信息
   */
  function extractSelectionInfo(articleRoot) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const container = articleRoot.querySelector('.markdown-rendered');
    if (!container || !container.contains(range.commonAncestorContainer)) return null;

    const rects = range.getClientRects();
    const endRect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    const boundingRect = range.getBoundingClientRect();

    const frag = range.cloneContents();
    frag.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, div.math-block').forEach(function (blk) {
      blk.appendChild(document.createTextNode('\n'));
    });

    const selectedTextWithMath = cleanDomFragmentToText(frag, false).replace(/\n{3,}/g, '\n\n').trim();
    const rawSelected = sel.toString().trim();
    if (!selectedTextWithMath && !rawSelected) return null;

    const startBlock = findClosestEditableBlock(range.startContainer, container);

    let occurrenceIndex = 0;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(container);
      preRange.setEnd(range.startContainer, range.startOffset);
      const preFrag = preRange.cloneContents();
      const preText = cleanDomFragmentToText(preFrag, false);
      if (selectedTextWithMath.length >= 2) {
        let pos = 0;
        while (true) {
          const found = preText.indexOf(selectedTextWithMath, pos);
          if (found === -1) break;
          occurrenceIndex++;
          pos = found + selectedTextWithMath.length;
        }
      }
    } catch (e) {
      occurrenceIndex = 0;
    }

    return {
      text: selectedTextWithMath || rawSelected,
      rawText: rawSelected,
      occurrenceIndex: occurrenceIndex,
      endRect: endRect,
      boundingRect: boundingRect,
      blockElement: startBlock,
      blockText: startBlock ? getCleanTextWithMath(startBlock) : ''
    };
  }

  /**
   * 在文档重绘后，根据保存的 selInfo 恢复浏览器的文字高亮选区并返回最新的 SelectionInfo
   */
  function restoreSelectionInfo(articleRoot, selInfo) {
    if (!articleRoot || !selInfo || !selInfo.text) return null;
    const container = articleRoot.querySelector('.markdown-rendered');
    if (!container) return selInfo;

    const segments = [];
    let fullText = '';

    function collectSegments(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        const val = (node.nodeValue || '').replace(/\u00a0/g, ' ');
        if (val.length > 0) {
          const start = fullText.length;
          fullText += val;
          segments.push({ node: node, isText: true, start: start, end: fullText.length });
        }
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.classList && node.classList.contains('img-edit-toolbar')) return;

      if (node.classList && node.classList.contains('katex')) {
        const ann = node.querySelector('annotation[encoding="application/x-tex"]');
        const tex = ann ? ann.textContent : '';
        const isDisplay = node.closest('.katex-display') !== null;
        const repr = tex ? (isDisplay ? '$$' + tex + '$$' : '$' + tex + '$') : '';
        if (repr.length > 0) {
          const start = fullText.length;
          fullText += repr;
          segments.push({ node: node, isKatex: true, start: start, end: fullText.length });
        }
        return;
      }

      if (node.tagName === 'BR') {
        fullText += '\n';
        return;
      }

      for (let i = 0; i < node.childNodes.length; i++) {
        collectSegments(node.childNodes[i]);
      }
    }

    collectSegments(container);

    const target = selInfo.text;
    const targetOcc = selInfo.occurrenceIndex || 0;
    let matchStart = -1;
    let curOcc = 0;
    let searchPos = 0;

    while (true) {
      const idx = fullText.indexOf(target, searchPos);
      if (idx === -1) break;
      matchStart = idx;
      if (curOcc === targetOcc) break;
      curOcc++;
      searchPos = idx + Math.max(1, target.length);
    }

    if (matchStart === -1 || segments.length === 0) {
      return selInfo;
    }

    const matchEnd = matchStart + target.length;
    let startSeg = null;
    let endSeg = null;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!startSeg && matchStart >= seg.start && matchStart < seg.end) {
        startSeg = seg;
      }
      if (matchEnd > seg.start && matchEnd <= seg.end) {
        endSeg = seg;
        break;
      }
    }

    if (!startSeg || !endSeg) return selInfo;

    try {
      const range = document.createRange();
      if (startSeg.isText) {
        range.setStart(startSeg.node, Math.max(0, Math.min(startSeg.node.nodeValue.length, matchStart - startSeg.start)));
      } else {
        range.setStartBefore(startSeg.node);
      }
      if (endSeg.isText) {
        range.setEnd(endSeg.node, Math.max(0, Math.min(endSeg.node.nodeValue.length, matchEnd - endSeg.start)));
      } else {
        range.setEndAfter(endSeg.node);
      }
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return extractSelectionInfo(articleRoot) || selInfo;
    } catch (e) {
      return selInfo;
    }
  }

  function getCleanTextWithMath(el) {
    return cleanDomFragmentToText(el, true);
  }

  /**
   * 计算某个块元素（blockEl）在 container 内的同文本出现序号，用于精准定位该段落在原始 Markdown 中的位置
   */
  function getBlockSelectionInfo(blockEl, container) {
    if (!blockEl || !container) return null;
    const textWithMath = getCleanTextWithMath(blockEl);
    if (!textWithMath) return null;

    let occurrenceIndex = 0;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(container);
      preRange.setEndBefore(blockEl);
      const preFrag = preRange.cloneContents();
      const preText = cleanDomFragmentToText(preFrag, false);
      if (textWithMath.length >= 2) {
        let pos = 0;
        while (true) {
          const found = preText.indexOf(textWithMath, pos);
          if (found === -1) break;
          occurrenceIndex++;
          pos = found + textWithMath.length;
        }
      }
    } catch (e) {
      occurrenceIndex = 0;
    }

    return {
      text: textWithMath,
      rawText: textWithMath,
      occurrenceIndex: occurrenceIndex,
      blockElement: blockEl
    };
  }

  /**
   * 将原位编辑后（contenteditable）的段落 DOM 节点逆向序列化为对应的 Markdown 文本（保留公式、加粗、斜体、颜色 span、批注 span、代码、链接、多行引用前缀）
   */
  function serializeBlockElementToMarkdown(blockEl, oldSeg) {
    function walk(node) {
      if (node.nodeType === 3) {
        return node.nodeValue;
      }
      if (node.nodeType !== 1) return '';

      const tag = node.tagName.toUpperCase();

      // 1. KaTeX 公式节点还原为 $...$ 或 $$...$$
      if (node.classList.contains('katex')) {
        const ann = node.querySelector('annotation[encoding="application/x-tex"]');
        const tex = ann ? ann.textContent : '';
        const isDisp = node.closest('.katex-display') !== null;
        return isDisp ? ('$$' + tex + '$$') : ('$' + tex + '$');
      }
      if (node.classList.contains('katex-display') || node.classList.contains('math-inline-display')) {
        const k = node.querySelector('.katex');
        if (k) return walk(k);
      }

      // 2. 换行
      if (tag === 'BR') return '\n';

      // 3. 图片与悬浮按钮
      if (tag === 'IMG') {
        const alt = node.getAttribute('alt') || '';
        const rawSrc = node.getAttribute('data-raw-src') || node.getAttribute('src') || '';
        return '![' + alt + '](' + rawSrc + ')';
      }
      if (node.classList && node.classList.contains('img-edit-toolbar')) {
        return '';
      }

      // 递归子节点
      let inner = '';
      for (let i = 0; i < node.childNodes.length; i++) {
        inner += walk(node.childNodes[i]);
      }

      if (tag === 'STRONG' || tag === 'B') {
        if (!inner) return '';
        const spanWrapMatch = inner.match(/^(<span\s+style=["'][^"']*color:\s*[^"']+["'][^>]*>)([\s\S]*?)(<\/span>)$/i);
        if (spanWrapMatch && !/<\/span>/i.test(spanWrapMatch[2])) {
          return spanWrapMatch[1] + '**' + spanWrapMatch[2] + '**' + spanWrapMatch[3];
        }
        return '**' + inner + '**';
      }
      if (tag === 'EM' || tag === 'I') {
        return inner ? ('*' + inner + '*') : '';
      }
      if (tag === 'MARK') {
        return inner ? ('==' + inner + '==') : '';
      }
      if (tag === 'CODE' && (!node.parentElement || node.parentElement.tagName !== 'PRE')) {
        return '`' + inner + '`';
      }
      if (tag === 'DEL' || tag === 'S') {
        return '~~' + inner + '~~';
      }
      if (tag === 'A') {
        const rawWiki = node.getAttribute('data-raw-wikilink');
        if (rawWiki) {
          // 如果用户未改动双链的显示文字，直接保留原始 [[...]] 语法
          const pipeIdx = rawWiki.indexOf('|');
          if (pipeIdx >= 0) {
            return rawWiki.slice(0, pipeIdx + 1) + inner + ']]';
          }
          const origLabel = rawWiki.slice(2, -2).split('#')[0].split('/').pop();
          if (!inner || inner === origLabel) return rawWiki;
          return rawWiki.slice(0, -2) + '|' + inner + ']]';
        }
        if (node.classList.contains('internal-link')) {
          const p = node.getAttribute('data-path') || '';
          const h = node.getAttribute('data-heading') || '';
          const baseName = p ? p.replace(/\.md$/i, '').split('/').pop() : '';
          const target = baseName + (h ? '#' + h : '');
          if (inner && inner !== baseName && inner !== target) {
            return '[[' + (target || inner) + '|' + inner + ']]';
          }
          return '[[' + (target || inner) + ']]';
        }
        const href = node.getAttribute('href') || '';
        // 若是裸链接（如 https://...），保持原格式而不强制包成 [url](url)
        if (inner === href && (!oldSeg || oldSeg.indexOf('[' + inner + ']') === -1)) {
          if (oldSeg && oldSeg.indexOf('<' + href + '>') >= 0) return '<' + href + '>';
          return href;
        }
        return '[' + inner + '](' + href + ')';
      }
      if (tag === 'SPAN') {
        if (node.classList.contains('md-comment-hl')) {
          const cmt = (node.getAttribute('data-comment') || '').replace(/"/g, '&quot;');
          return '<span class="md-comment-hl" data-comment="' + cmt + '" title="💬 ' + cmt + '">' + inner + '</span>';
        }
        const styleAttr = node.getAttribute('style') || '';
        if (/color\s*:/i.test(styleAttr)) {
          return '<span style="' + styleAttr.replace(/"/g, '\'') + '">' + inner + '</span>';
        }
      }
      if (tag === 'DIV') {
        return '\n' + inner;
      }

      return inner;
    }

    let out = '';
    for (let i = 0; i < blockEl.childNodes.length; i++) {
      // 如果内部包含嵌套的 ul/ol，跳过子列表（只序列化当前块自身内容）
      const ch = blockEl.childNodes[i];
      if (ch.nodeType === 1 && (ch.tagName === 'UL' || ch.tagName === 'OL')) continue;
      out += walk(ch);
    }
    let cleaned = out.replace(/\u00a0/g, ' ').trim();

    // 若当前段落位于 blockquote / callout 内，或原片段含多行 `> ` 引用前缀，换行时自动延续 `> `
    const inQuote = (blockEl.closest && blockEl.closest('blockquote, .callout-box')) || (oldSeg && /\r?\n[ \t]*>[ \t]?/.test(oldSeg));
    if (inQuote && cleaned.indexOf('\n') >= 0) {
      cleaned = cleaned.split('\n').map(function (line, idx) {
        if (idx === 0) return line;
        return /^[ \t]*>/.test(line) ? line : ('> ' + line);
      }).join('\n');
    } else if (oldSeg && cleaned.indexOf('\n') >= 0) {
      // 若原片段是带缩进续行的列表项（如 `1. xxx\n   yyy`），保留续行缩进
      const indentMatch = oldSeg.match(/\r?\n([ \t]{2,})(?![-*+]|\d+\.)/);
      if (indentMatch) {
        const indent = indentMatch[1];
        cleaned = cleaned.split('\n').map(function (line, idx) {
          if (idx === 0) return line;
          return line.startsWith(indent) ? line : (indent + line.trimStart());
        }).join('\n');
      }
    }

    return cleaned;
  }

  const TOKEN_UNIT = '\\*\\*|\\*|__|==|~~|`|<\\/?[a-zA-Z][^>\\n]*>|\\[\\[(?:[^\\]\\n]*?[\\/\\|#])?|\\]\\]|\\[|\\]\\([^)\\n]*\\)|<(?=(?:https?|mailto):)|(?<=\\S)>|\\\\(?=[\\\\`*_{}\\[\\]()#+\\-.!|>~])';
  const INLINE_GAP = '(?:' + TOKEN_UNIT + ')*';
  const WS_OR_TOKEN_GAP = '(?:' + TOKEN_UNIT + '|[ \\t\\r\\n>])+';
  const ANCHOR_GAP = '(?:' + TOKEN_UNIT + '|[ \\t\\r\\n>])*';

  /**
   * 在原始 Markdown 正文中精准定位用户选中的片段或整个段落块，返回 { start, end }
   */
  function locateInMarkdown(fullMarkdown, selInfo) {
    let bodyOffset = 0;
    const fmMatch = fullMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    if (fmMatch) {
      bodyOffset = fmMatch[0].length;
    }
    const body = fullMarkdown.slice(bodyOffset);
    const target = (selInfo && selInfo.text ? selInfo.text : '').trim();
    if (!target) return null;
    const occ = (selInfo && selInfo.occurrenceIndex) || 0;

    // 策略 1：直接精确子串查找
    const directMatches = findAllLiteralMatches(body, target);
    if (directMatches.length > 0) {
      const pick = directMatches[Math.min(occ, directMatches.length - 1)];
      return extendToBalancedInlineTags(fullMarkdown, bodyOffset + pick.start, bodyOffset + pick.end);
    }

    // 策略 2：无回溯弹性正则匹配（适用于中短句、标题、列表项或划选文字）
    if (target.length <= 120) {
      const flexRegex = buildFlexibleRegex(target, true);
      if (flexRegex) {
        const matches = [];
        let m;
        while ((m = flexRegex.exec(body)) !== null) {
          matches.push({ start: m.index, end: m.index + m[0].length });
          if (m.index === flexRegex.lastIndex) flexRegex.lastIndex++;
        }
        if (matches.length > 0) {
          const pick = matches[Math.min(occ, matches.length - 1)];
          return extendToBalancedInlineTags(fullMarkdown, bodyOffset + pick.start, bodyOffset + pick.end);
        }
      }
    }

    // 策略 3：首尾锚点消歧（针对含多行换行、复杂双链、公式、嵌套颜色/加粗的长段落）
    const compact = target.replace(/\s+/g, '');
    if (compact.length >= 4) {
      const hLen = Math.min(12, Math.max(2, Math.floor(compact.length / 2)));
      const tLen = Math.min(12, Math.max(2, compact.length - hLen));
      const headStr = compact.slice(0, hLen);
      const tailStr = compact.slice(-tLen);
      const headRx = buildFlexibleRegex(headStr, true);
      const tailRx = buildFlexibleRegex(tailStr, true);
      if (headRx && tailRx) {
        let hm;
        const candidates = [];
        const maxSpan = Math.max(target.length * 4 + 600, 1200);
        while ((hm = headRx.exec(body)) !== null) {
          tailRx.lastIndex = hm.index + hm[0].length;
          const tm = tailRx.exec(body);
          if (tm && (tm.index + tm[0].length - hm.index) <= maxSpan) {
            candidates.push({ start: hm.index, end: tm.index + tm[0].length });
          }
          if (hm.index === headRx.lastIndex) headRx.lastIndex++;
        }
        if (candidates.length > 0) {
          const pick = candidates[Math.min(occ, candidates.length - 1)];
          return extendToBalancedInlineTags(fullMarkdown, bodyOffset + pick.start, bodyOffset + pick.end);
        }
      }
    }

    // 策略 4：行级/块级去修饰归一化兜底（彻底解决多重嵌套语法、特殊转义字符或超长复杂段落映射）
    const lineFallback = locateByNormalizedLines(fullMarkdown, bodyOffset, body, target, occ);
    if (lineFallback) {
      return lineFallback;
    }

    return null;
  }

  /**
   * 将 Markdown 源码片段去除修饰符后转为纯文本（用于策略 4 行级精确对比）
   */
  function stripMarkdownToComparable(mdStr) {
    return mdStr
      .replace(/!\[\[[^\]]*\]\]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[\[([^\]\|#]*)(?:#[^\]\|]*)?\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]\|#]+)(?:#([^\]]+))?\]\]/g, function (_, t, h) {
        return t ? t.split('/').pop() : (h || '');
      })
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<((?:https?|mailto):[^>]+)>/gi, '$1')
      .replace(/<\/?[a-zA-Z][^>\n]*>/g, '')
      .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')
      .replace(/(\*\*|\*|__|==|~~|`)/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, '');
  }

  function locateByNormalizedLines(fullMd, bodyOffset, body, target, occ) {
    const normTarget = stripMarkdownToComparable(target);
    if (!normTarget) return null;

    // 收集每一行的起止位置与去掉行首块标记（#、>、-、1.）后的内容区间
    const lines = [];
    let pos = 0;
    const rawLines = body.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      const lineStr = rawLines[i].replace(/\r$/, '');
      const lineStart = pos;
      const lineEnd = pos + lineStr.length;
      pos += rawLines[i].length + 1;

      const prefixMatch = lineStr.match(/^([ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+\.)[ \t]+)?)/);
      const prefixLen = prefixMatch ? prefixMatch[0].length : 0;
      const contentStart = lineStart + prefixLen;
      const contentStr = lineStr.slice(prefixLen);
      lines.push({
        start: contentStart,
        end: lineEnd,
        norm: stripMarkdownToComparable(contentStr),
        isEmpty: contentStr.trim().length === 0
      });
    }

    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].isEmpty || !lines[i].norm) continue;
      let accNorm = '';
      for (let j = i; j < Math.min(lines.length, i + 25); j++) {
        if (lines[j].isEmpty) break;
        accNorm += lines[j].norm;
        if (accNorm === normTarget) {
          candidates.push({ start: bodyOffset + lines[i].start, end: bodyOffset + lines[j].end });
          break;
        }
        if (accNorm.length > normTarget.length + 30) break;
      }
    }

    if (candidates.length > 0) {
      return candidates[Math.min(occ, candidates.length - 1)];
    }

    // 若目标是某一行内的子串（如划选部分文字）
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].norm) continue;
      if (lines[i].norm.indexOf(normTarget) >= 0) {
        candidates.push({ start: bodyOffset + lines[i].start, end: bodyOffset + lines[i].end });
      }
    }
    if (candidates.length > 0) {
      return candidates[Math.min(occ, candidates.length - 1)];
    }
    return null;
  }

  /**
   * 若匹配到的区间首尾紧邻成对的外层 `**`、`<span...>`、`[[...` 等内联包裹符号，自动向两侧对称扩展使其闭合
   */
  function extendToBalancedInlineTags(fullMd, start, end) {
    const lineStart = fullMd.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = fullMd.indexOf('\n', end);
    const rightLimit = lineEnd === -1 ? fullMd.length : lineEnd;

    let changed = true;
    let guard = 0;
    while (changed && guard++ < 16) {
      changed = false;
      const left = fullMd.slice(lineStart, start);
      const right = fullMd.slice(end, rightLimit);
      const cur = fullMd.slice(start, end);

      // 1. 若区间内部存在奇数个未配对的 **，且紧邻左/右侧恰好是配对的 **，先补齐闭合
      const boldCount = (cur.match(/\*\*/g) || []).length;
      if (boldCount % 2 === 1) {
        if (right.startsWith('**')) {
          end += 2;
          changed = true;
          continue;
        }
        if (left.endsWith('**')) {
          start -= 2;
          changed = true;
          continue;
        }
      }

      // 2. 若区间内部存在未闭合的 <span...>，且紧邻左/右侧恰好是配对标签，先补齐闭合
      const openSpanCount = (cur.match(/<span\b[^>]*>/gi) || []).length;
      const closeSpanCount = (cur.match(/<\/span>/gi) || []).length;
      if (openSpanCount > closeSpanCount) {
        const rightCloseSpan = right.match(/^<\/span>/i);
        if (rightCloseSpan) {
          end += rightCloseSpan[0].length;
          changed = true;
          continue;
        }
      } else if (closeSpanCount > openSpanCount) {
        const leftOpenSpan = left.match(/<span\b[^>]*>$/i);
        if (leftOpenSpan) {
          start -= leftOpenSpan[0].length;
          changed = true;
          continue;
        }
      }

      // 3. 向两侧对称扩展成对的内联包裹标签
      if (left.endsWith('**') && right.startsWith('**')) {
        start -= 2;
        end += 2;
        changed = true;
        continue;
      }
      if (left.endsWith('__') && right.startsWith('__')) {
        start -= 2;
        end += 2;
        changed = true;
        continue;
      }
      if (left.endsWith('*') && !left.endsWith('**') && right.startsWith('*') && !right.startsWith('**')) {
        start -= 1;
        end += 1;
        changed = true;
        continue;
      }
      if (left.endsWith('==') && right.startsWith('==')) {
        start -= 2;
        end += 2;
        changed = true;
        continue;
      }
      if (left.endsWith('~~') && right.startsWith('~~')) {
        start -= 2;
        end += 2;
        changed = true;
        continue;
      }
      if (left.endsWith('`') && !left.endsWith('``') && right.startsWith('`') && !right.startsWith('``')) {
        start -= 1;
        end += 1;
        changed = true;
        continue;
      }

      const spanOpen = left.match(/<span\b[^>]*>$/i);
      const spanClose = right.match(/^<\/span>/i);
      if (spanOpen && spanClose) {
        start -= spanOpen[0].length;
        end += spanClose[0].length;
        changed = true;
        continue;
      }

      const tagOpen = left.match(/<(u|mark)>$/i);
      const tagClose = right.match(/^<\/(u|mark)>/i);
      if (tagOpen && tagClose && tagOpen[1].toLowerCase() === tagClose[1].toLowerCase()) {
        start -= tagOpen[0].length;
        end += tagClose[0].length;
        changed = true;
        continue;
      }

      const wikiOpen = left.match(/\[\[(?:[^\]\n]*?[\/\|#])?$/);
      const wikiClose = right.match(/^\]\]/);
      if (wikiOpen && wikiClose) {
        start -= wikiOpen[0].length;
        end += wikiClose[0].length;
        changed = true;
        continue;
      }

      if (left.endsWith('[') && !left.endsWith('[[') && !left.endsWith('![')) {
        const mdLinkClose = right.match(/^\]\([^)\n]*\)/);
        if (mdLinkClose) {
          start -= 1;
          end += mdLinkClose[0].length;
          changed = true;
          continue;
        }
      }
    }

    return { start: start, end: end };
  }

  function findAllLiteralMatches(haystack, needle) {
    const out = [];
    if (!needle) return out;
    let pos = 0;
    while (true) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;
      out.push({ start: idx, end: idx + needle.length });
      pos = idx + Math.max(1, needle.length);
    }
    return out;
  }

  function escapeRegexChar(ch) {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildFlexibleRegex(text, allowLooseWs) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 160) return null;
    const tokens = [];
    let i = 0;
    while (i < trimmed.length) {
      if (/\s/.test(trimmed[i])) {
        while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
        tokens.push({ type: 'ws' });
      } else {
        tokens.push({ type: 'ch', val: escapeRegexChar(trimmed[i]) });
        i++;
      }
    }
    if (tokens.length === 0) return null;
    let pattern = '';
    for (let k = 0; k < tokens.length; k++) {
      if (tokens[k].type === 'ch') {
        pattern += tokens[k].val;
        if (k + 1 < tokens.length && tokens[k + 1].type === 'ch') {
          pattern += allowLooseWs ? ANCHOR_GAP : INLINE_GAP;
        }
      } else {
        pattern += WS_OR_TOKEN_GAP;
      }
    }
    try {
      return new RegExp(pattern, 'g');
    } catch (e) {
      return null;
    }
  }

  function transformAcrossParagraphs(rawSlice, wrapperFn) {
    const lines = rawSlice.split('\n');
    return lines.map(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (/^(!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\]|---+|===+|\*\*\*+)$/.test(trimmed)) return line;
      const prefixMatch = line.match(/^([ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|(?:[-*+]|\d+\.)[ \t]+)?)(.*)$/);
      if (!prefixMatch) return wrapperFn(line);
      const prefix = prefixMatch[1] || '';
      const content = prefixMatch[2] || '';
      if (!content.trim()) return line;
      return prefix + wrapperFn(content);
    }).join('\n');
  }

  function toggleBoldOnSegment(seg) {
    const wsMatch = seg.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!wsMatch || !wsMatch[2]) return seg;
    const lead = wsMatch[1];
    const core = wsMatch[2];
    const trail = wsMatch[3];

    // 情况 A：外层是 <span ...>...</span>（如颜色 span 或批注高亮 span），将 ** 放在 span 内部，确保中文环境下 CommonMark 正常解析加粗且与颜色共存
    const outerSpanMatch = core.match(/^(<span\b[^>]*>)([\s\S]*?)(<\/span>)$/i);
    if (outerSpanMatch && !/<\/?span\b/i.test(outerSpanMatch[2])) {
      const openTag = outerSpanMatch[1];
      const innerText = outerSpanMatch[2];
      const closeTag = outerSpanMatch[3];
      const innerBoldMatch = innerText.match(/^(\s*)\*\*([\s\S]+?)\*\*(\s*)$/);
      if (innerBoldMatch && (innerText.match(/\*\*/g) || []).length === 2) {
        return lead + openTag + innerBoldMatch[1] + innerBoldMatch[2] + innerBoldMatch[3] + closeTag + trail;
      }
      const innerWs = innerText.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!innerWs || !innerWs[2]) return seg;
      const cleanedInner = innerWs[2].replace(/\*\*/g, '');
      return lead + openTag + innerWs[1] + '**' + cleanedInner + '**' + innerWs[3] + closeTag + trail;
    }

    // 情况 B：外层已经是 **...**（例如 **文字** 或历史遗留的 **<span...>**） -> 取消加粗，保留内部颜色等标签
    if (/^\*\*[\s\S]+\*\*$/.test(core) && (core.match(/\*\*/g) || []).length === 2) {
      return lead + core.slice(2, -2) + trail;
    }

    // 情况 C：未加粗 -> 包裹 **...**（若内部含有局部 ** 则合并去重）
    const cleanedCore = core.replace(/\*\*/g, '');
    return lead + '**' + cleanedCore + '**' + trail;
  }

  /**
   * 功能 1：切换加粗 (**text**)，兼容带颜色 span 的叠加与取消
   */
  function applyBoldToggle(fullMarkdown, loc) {
    let { start, end } = loc;
    if (start >= 2 && fullMarkdown.slice(start - 2, start) === '**' && fullMarkdown.slice(end, end + 2) === '**') {
      return fullMarkdown.slice(0, start - 2) + fullMarkdown.slice(start, end) + fullMarkdown.slice(end + 2);
    }
    const slice = fullMarkdown.slice(start, end);
    const replaced = transformAcrossParagraphs(slice, toggleBoldOnSegment);
    return fullMarkdown.slice(0, start) + replaced + fullMarkdown.slice(end);
  }

  /**
   * 功能 2A：设置颜色 (<span style="color: ...">...</span>)，保留已有加粗并规范为外层 span + 内层 **
   */
  function applyColorSpan(fullMarkdown, loc, colorValue) {
    let { start, end } = loc;
    const before = fullMarkdown.slice(Math.max(0, start - 80), start);
    const after = fullMarkdown.slice(end, Math.min(fullMarkdown.length, end + 20));
    const openMatch = before.match(/<span\s+style=["'][^"']*color:\s*[^"']+["'][^>]*>$/i);
    const closeMatch = after.match(/^<\/span>/i);
    if (openMatch && closeMatch) {
      start -= openMatch[0].length;
      end += closeMatch[0].length;
    }

    const slice = fullMarkdown.slice(start, end);
    const replaced = transformAcrossParagraphs(slice, function (seg) {
      const cleaned = stripColorSpansInString(seg);
      const m = cleaned.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m || !m[2]) return seg;
      return m[1] + '<span style="color: ' + colorValue + '">' + m[2] + '</span>' + m[3];
    });

    return fullMarkdown.slice(0, start) + replaced + fullMarkdown.slice(end);
  }

  function stripColorSpansInString(str) {
    return str
      .replace(/<span\s+style=["'][^"']*color:\s*[^"']+["'][^>]*>([\s\S]*?)<\/span>/gi, '$1')
      .replace(/<span\s+style=["'][^"']*color:\s*[^"']+["'][^>]*>/gi, '');
  }

  /**
   * 功能 2B：取消颜色
   */
  function removeColorSpan(fullMarkdown, loc) {
    let { start, end } = loc;
    const leftPart = fullMarkdown.slice(0, start);
    const rightPart = fullMarkdown.slice(end);
    const lastOpen = leftPart.lastIndexOf('<span');
    const lastCloseBefore = leftPart.lastIndexOf('</span>');

    if (lastOpen !== -1 && lastOpen > lastCloseBefore) {
      const openTagMatch = fullMarkdown.slice(lastOpen).match(/^<span\s+style=["'][^"']*color:\s*[^"']+["'][^>]*>/i);
      const nextCloseIdx = rightPart.indexOf('</span>');
      if (openTagMatch && nextCloseIdx !== -1) {
        start = lastOpen;
        end = end + nextCloseIdx + '</span>'.length;
      }
    }

    const slice = fullMarkdown.slice(start, end);
    const cleaned = stripColorSpansInString(slice);
    return fullMarkdown.slice(0, start) + cleaned + fullMarkdown.slice(end);
  }

  /**
   * 功能 3（方案 C）：行内高亮标记 + 在所选段落后新开一段用 `>` 引用插入评论
   */
  function applyCommentSchemeC(fullMarkdown, loc, commentText) {
    const { start, end } = loc;
    const cleanComment = commentText.trim();
    if (!cleanComment) return fullMarkdown;

    const slice = fullMarkdown.slice(start, end);
    const escapedAttr = cleanComment.replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');

    const highlightedSlice = transformAcrossParagraphs(slice, function (seg) {
      const m = seg.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m || !m[2]) return seg;
      return m[1] + '<span class="md-comment-hl" data-comment="' + escapedAttr + '" title="💬 ' + escapedAttr + '">' + m[2] + '</span>' + m[3];
    });

    const afterStart = end;
    const rest = fullMarkdown.slice(afterStart);
    const nextParaBreak = rest.search(/\r?\n[ \t]*\r?\n/);
    const insertOffset = nextParaBreak === -1 ? fullMarkdown.length : afterStart + nextParaBreak;

    const plainQuote = slice.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const shortQuote = plainQuote.length > 42 ? plainQuote.slice(0, 42) + '…' : plainQuote;

    const commentLines = cleanComment.split(/\r?\n/);
    const quoteBlockLines = [
      '> 💬 **批注**（针对「' + shortQuote + '」）：' + commentLines[0]
    ];
    for (let i = 1; i < commentLines.length; i++) {
      quoteBlockLines.push('> ' + commentLines[i]);
    }
    const quoteBlock = '\n\n' + quoteBlockLines.join('\n');

    return (
      fullMarkdown.slice(0, start) +
      highlightedSlice +
      fullMarkdown.slice(end, insertOffset) +
      quoteBlock +
      fullMarkdown.slice(insertOffset)
    );
  }

  /**
   * 在原始 Markdown 中根据目标段落位置（loc）或位置策略（after / before / end）插入图片语法
   */
  function insertImageMarkdown(fullMarkdown, loc, markdownLink, altText, position) {
    const cleanAlt = (altText || '').replace(/[\r\n\[\]]/g, '').trim();
    const imgSyntax = '![' + cleanAlt + '](' + markdownLink + ')';

    if (!loc || position === 'end') {
      const trimmedEnd = fullMarkdown.replace(/\s+$/, '');
      return trimmedEnd + '\n\n' + imgSyntax + '\n';
    }

    if (position === 'before') {
      const beforePart = fullMarkdown.slice(0, loc.start);
      const lineStart = beforePart.lastIndexOf('\n') + 1;
      return fullMarkdown.slice(0, lineStart) + imgSyntax + '\n\n' + fullMarkdown.slice(lineStart);
    }

    // 默认 after：在当前段落结束换行处插入新段落
    const afterStart = loc.end;
    const rest = fullMarkdown.slice(afterStart);
    const nextParaBreak = rest.search(/\r?\n[ \t]*\r?\n/);
    const insertOffset = nextParaBreak === -1 ? fullMarkdown.length : afterStart + nextParaBreak;
    return fullMarkdown.slice(0, insertOffset) + '\n\n' + imgSyntax + fullMarkdown.slice(insertOffset);
  }

  window.MDEditor = {
    PRESET_COLORS: PRESET_COLORS,
    findClosestEditableBlock: findClosestEditableBlock,
    extractSelectionInfo: extractSelectionInfo,
    restoreSelectionInfo: restoreSelectionInfo,
    getBlockSelectionInfo: getBlockSelectionInfo,
    serializeBlockElementToMarkdown: serializeBlockElementToMarkdown,
    locateInMarkdown: locateInMarkdown,
    applyBoldToggle: applyBoldToggle,
    applyColorSpan: applyColorSpan,
    removeColorSpan: removeColorSpan,
    applyCommentSchemeC: applyCommentSchemeC,
    insertImageMarkdown: insertImageMarkdown,
    pushUndo: pushUndo,
    canUndo: canUndo,
    popUndo: popUndo
  };
})();
