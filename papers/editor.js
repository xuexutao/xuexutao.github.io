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

  // Undo & Redo 历史栈：按文档路径存储
  const historyMap = new Map(); // path -> { undo: [str], redo: [str] }

  function getHistory(docPath) {
    if (!historyMap.has(docPath)) {
      historyMap.set(docPath, { undo: [], redo: [] });
    }
    return historyMap.get(docPath);
  }

  function pushUndo(docPath, oldMarkdown) {
    const h = getHistory(docPath);
    if (h.undo.length === 0 || h.undo[h.undo.length - 1] !== oldMarkdown) {
      h.undo.push(oldMarkdown);
      if (h.undo.length > 50) h.undo.shift();
    }
    h.redo.length = 0;
  }

  function canUndo(docPath) {
    return docPath && getHistory(docPath).undo.length > 0;
  }

  function popUndo(docPath, currentMarkdown) {
    const h = getHistory(docPath);
    if (!h.undo.length) return null;
    const prev = h.undo.pop();
    h.redo.push(currentMarkdown);
    return prev;
  }

  /**
   * 向上查找最近的段落级块元素（P, LI, H1-H6, BLOCKQUOTE, TD, TH）
   */
  function findClosestEditableBlock(node, container) {
    let cur = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (cur && cur !== container) {
      if (/^(P|LI|H[1-6])$/.test(cur.tagName)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
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
    frag.querySelectorAll('.katex').forEach(function (k) {
      const ann = k.querySelector('annotation[encoding="application/x-tex"]');
      const tex = ann ? ann.textContent : '';
      const isDisplay = k.closest('.katex-display') !== null;
      const replacement = document.createTextNode(tex ? (isDisplay ? '$$' + tex + '$$' : '$' + tex + '$') : '');
      k.parentNode.replaceChild(replacement, k);
    });

    frag.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, div.math-block').forEach(function (blk) {
      blk.appendChild(document.createTextNode('\n'));
    });

    let selectedTextWithMath = frag.textContent.replace(/\n{3,}/g, '\n\n').trim();
    const rawSelected = sel.toString().trim();
    if (!selectedTextWithMath && !rawSelected) return null;

    const startBlock = findClosestEditableBlock(range.startContainer, container);

    let occurrenceIndex = 0;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(container);
      preRange.setEnd(range.startContainer, range.startOffset);
      const preFrag = preRange.cloneContents();
      preFrag.querySelectorAll('.katex').forEach(function (k) {
        const ann = k.querySelector('annotation[encoding="application/x-tex"]');
        const tex = ann ? ann.textContent : '';
        const isDisplay = k.closest('.katex-display') !== null;
        k.parentNode.replaceChild(document.createTextNode(tex ? (isDisplay ? '$$' + tex + '$$' : '$' + tex + '$') : ''), k);
      });
      const preText = preFrag.textContent;
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

  function getCleanTextWithMath(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.katex').forEach(function (k) {
      const ann = k.querySelector('annotation[encoding="application/x-tex"]');
      const tex = ann ? ann.textContent : '';
      const isDisplay = k.closest('.katex-display') !== null;
      k.parentNode.replaceChild(document.createTextNode(tex ? (isDisplay ? '$$' + tex + '$$' : '$' + tex + '$') : ''), k);
    });
    return clone.textContent.trim();
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
      preFrag.querySelectorAll('.katex').forEach(function (k) {
        const ann = k.querySelector('annotation[encoding="application/x-tex"]');
        const tex = ann ? ann.textContent : '';
        const isDisplay = k.closest('.katex-display') !== null;
        k.parentNode.replaceChild(document.createTextNode(tex ? (isDisplay ? '$$' + tex + '$$' : '$' + tex + '$') : ''), k);
      });
      const preText = preFrag.textContent;
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
   * 将原位编辑后（contenteditable）的段落 DOM 节点逆向序列化为对应的 Markdown 文本（保留公式、加粗、斜体、颜色 span、批注 span、代码、链接）
   */
  function serializeBlockElementToMarkdown(blockEl) {
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

      // 3. 图片
      if (tag === 'IMG') {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return '![' + alt + '](' + src + ')';
      }

      // 递归子节点
      let inner = '';
      for (let i = 0; i < node.childNodes.length; i++) {
        inner += walk(node.childNodes[i]);
      }

      if (tag === 'STRONG' || tag === 'B') {
        return inner ? ('**' + inner + '**') : '';
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
      // 瀏覽器在 contenteditable 回车时可能插入 div
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
    return out.replace(/\u00a0/g, ' ').trim();
  }

  /**
   * 在原始 Markdown 正文中精准定位用户选中的片段，返回 { start, end }
   */
  function locateInMarkdown(fullMarkdown, selInfo) {
    let bodyOffset = 0;
    const fmMatch = fullMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    if (fmMatch) {
      bodyOffset = fmMatch[0].length;
    }
    const body = fullMarkdown.slice(bodyOffset);
    const target = selInfo.text;

    // 策略 1：直接精确子串查找
    const directMatches = findAllLiteralMatches(body, target);
    if (directMatches.length > 0) {
      const pick = directMatches[Math.min(selInfo.occurrenceIndex, directMatches.length - 1)];
      return { start: bodyOffset + pick.start, end: bodyOffset + pick.end };
    }

    // 策略 2：弹性正则匹配（容忍 **, *, ==, <span...>, [[target|alias]] 等修饰符）
    const flexRegex = buildFlexibleRegex(target);
    if (flexRegex) {
      const matches = [];
      let m;
      while ((m = flexRegex.exec(body)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
        if (m.index === flexRegex.lastIndex) flexRegex.lastIndex++;
      }
      if (matches.length > 0) {
        const pick = matches[Math.min(selInfo.occurrenceIndex, matches.length - 1)];
        return extendToBalancedInlineTags(fullMarkdown, bodyOffset + pick.start, bodyOffset + pick.end);
      }
    }

    // 策略 3：首尾锚点消歧（针对含复杂双链别名或长段落）
    const compact = target.replace(/\s+/g, '');
    if (compact.length >= 12) {
      const headStr = compact.slice(0, Math.min(10, Math.floor(compact.length / 2)));
      const tailStr = compact.slice(-Math.min(10, Math.floor(compact.length / 2)));
      const headRx = buildFlexibleRegex(headStr);
      const tailRx = buildFlexibleRegex(tailStr);
      if (headRx && tailRx) {
        let hm;
        const candidates = [];
        while ((hm = headRx.exec(body)) !== null) {
          tailRx.lastIndex = hm.index + hm[0].length;
          const tm = tailRx.exec(body);
          if (tm && (tm.index + tm[0].length - hm.index) <= target.length * 3 + 360) {
            candidates.push({ start: hm.index, end: tm.index + tm[0].length });
          }
          if (hm.index === headRx.lastIndex) headRx.lastIndex++;
        }
        if (candidates.length > 0) {
          const pick = candidates[Math.min(selInfo.occurrenceIndex, candidates.length - 1)];
          return extendToBalancedInlineTags(fullMarkdown, bodyOffset + pick.start, bodyOffset + pick.end);
        }
      }
    }

    return null;
  }

  /**
   * 若匹配到的区间首尾紧邻外层 `**` 或 `<span...>`，自动向两侧扩展使其闭合，方便整段替换
   */
  function extendToBalancedInlineTags(fullMd, start, end) {
    // 扩展两侧紧邻的 **
    if (start >= 2 && fullMd.slice(start - 2, start) === '**' && fullMd.slice(end, end + 2) === '**') {
      start -= 2;
      end += 2;
    }
    // 扩展两侧紧邻的 <span ...>...</span>
    const before = fullMd.slice(Math.max(0, start - 160), start);
    const after = fullMd.slice(end, Math.min(fullMd.length, end + 20));
    const openSpan = before.match(/<span\b[^>]*>$/i);
    const closeSpan = after.match(/^<\/span>/i);
    if (openSpan && closeSpan) {
      start -= openSpan[0].length;
      end += closeSpan[0].length;
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

  function buildFlexibleRegex(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 2200) return null;
    // 允许字符之间穿插 Markdown 修饰符、HTML 标签或双链目标前缀
    const inlineTokenGap = '(?:\\*\\*|\\*|==|~~|`|<\\/?span[^>]*>|<\\/?u>|<\\/?mark>|\\[\\[(?:[^\\]\\|]*\\|)?|\\]\\]|\\[|\\]\\([^)]*\\))*';
    const parts = [];
    let i = 0;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (/\s/.test(ch)) {
        while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
        parts.push('(?:[ \\t\\r\\n>]|\\*\\*|\\*|==|<\\/?span[^>]*>)+');
      } else {
        parts.push(escapeRegexChar(ch));
        i++;
      }
    }
    if (parts.length === 0) return null;
    try {
      return new RegExp(inlineTokenGap + parts.join(inlineTokenGap) + inlineTokenGap, 'g');
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

  /**
   * 功能 1：切换加粗 (**text**)
   */
  function applyBoldToggle(fullMarkdown, loc) {
    let { start, end } = loc;
    if (start >= 2 && fullMarkdown.slice(start - 2, start) === '**' && fullMarkdown.slice(end, end + 2) === '**') {
      return fullMarkdown.slice(0, start - 2) + fullMarkdown.slice(start, end) + fullMarkdown.slice(end + 2);
    }
    const slice = fullMarkdown.slice(start, end);
    if (/^\*\*[\s\S]+\*\*$/.test(slice.trim()) && (slice.match(/\*\*/g) || []).length === 2) {
      const unbolded = slice.replace(/^\s*\*\*([\s\S]+?)\*\*\s*$/, '$1');
      return fullMarkdown.slice(0, start) + unbolded + fullMarkdown.slice(end);
    }
    const replaced = transformAcrossParagraphs(slice, function (seg) {
      const m = seg.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m || !m[2]) return seg;
      return m[1] + '**' + m[2] + '**' + m[3];
    });
    return fullMarkdown.slice(0, start) + replaced + fullMarkdown.slice(end);
  }

  /**
   * 功能 2A：设置颜色 (<span style="color: ...">...</span>)
   */
  function applyColorSpan(fullMarkdown, loc, colorValue) {
    let { start, end } = loc;
    const before = fullMarkdown.slice(Math.max(0, start - 60), start);
    const after = fullMarkdown.slice(end, Math.min(fullMarkdown.length, end + 20));
    const openMatch = before.match(/<span\s+style=["']color:\s*[^"']+["']\s*>$/i);
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

  window.MDEditor = {
    PRESET_COLORS: PRESET_COLORS,
    findClosestEditableBlock: findClosestEditableBlock,
    extractSelectionInfo: extractSelectionInfo,
    getBlockSelectionInfo: getBlockSelectionInfo,
    serializeBlockElementToMarkdown: serializeBlockElementToMarkdown,
    locateInMarkdown: locateInMarkdown,
    applyBoldToggle: applyBoldToggle,
    applyColorSpan: applyColorSpan,
    removeColorSpan: removeColorSpan,
    applyCommentSchemeC: applyCommentSchemeC,
    pushUndo: pushUndo,
    canUndo: canUndo,
    popUndo: popUndo
  };
})();
