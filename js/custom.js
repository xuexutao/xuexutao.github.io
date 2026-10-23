/**
 * A4 主题自定义前端增强
 * 1. 列表页：按年份分组折叠（默认最新一年展开，其余收起）
 * 2. 文章页：正文前目录可收起（长目录默认收起）
 * 3. 正文排版修复：清理 Pandoc + 引用块导致的未解析 > ### 标题和多余全角空格
 */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  ready(function () {
    initArchiveFold();
    initPostTocFold();
    fixMarkdownArtifacts();
  });

  /* ============ 1. 列表页 年份分组折叠 ============ */
  function initArchiveFold() {
    var archive = document.querySelector('.archive');
    if (!archive) return;

    var lis = Array.prototype.filter.call(archive.children, function (el) {
      return el.tagName === 'LI';
    });

    var groups = [];
    var current = null;

    lis.forEach(function (li) {
      if (li.querySelector('.year-font-color')) {
        current = { header: li, items: [] };
        groups.push(current);
      } else if (current) {
        current.items.push(li);
      }
    });

    groups.forEach(function (group, index) {
      var header = group.header;
      if (!group.items.length) return;
      header.classList.add('archive-fold-header');

      var arrow = document.createElement('span');
      arrow.className = 'archive-fold-arrow';
      header.insertBefore(arrow, header.firstChild);

      var collapsed = index !== 0;
      apply(group, collapsed);

      header.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        collapsed = !collapsed;
        apply(group, collapsed);
      });
    });

    function apply(group, collapsed) {
      group.items.forEach(function (li) {
        li.style.display = collapsed ? 'none' : '';
      });
      if (collapsed) {
        group.header.classList.add('is-collapsed');
      } else {
        group.header.classList.remove('is-collapsed');
      }
    }
  }

  /* ============ 2. 文章页 正文前目录收起 ============ */
  // 长目录会把正文推到很后面：超过阈值时默认收起，读者点按钮/标题栏再展开。
  var TOC_COLLAPSE_THRESHOLD = 12;

  function initPostTocFold() {
    var toc = document.querySelector('.post-md > .post-toc');
    if (!toc) return;

    var itemCount = toc.querySelectorAll('a').length;
    if (!toc.id) toc.id = 'post-toc-list';

    var wrap = document.createElement('div');
    wrap.className = 'post-toc-wrap';
    toc.parentNode.insertBefore(wrap, toc);

    var header = document.createElement('div');
    header.className = 'post-toc-header';

    var title = document.createElement('span');
    title.className = 'post-toc-title';
    title.textContent = '目录';
    if (itemCount > 0) {
      var count = document.createElement('span');
      count.className = 'post-toc-count';
      count.textContent = itemCount + ' 项';
      title.appendChild(count);
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'post-toc-toggle';
    button.setAttribute('aria-controls', toc.id);

    var label = document.createElement('span');
    label.className = 'post-toc-toggle-label';
    var arrow = document.createElement('span');
    arrow.className = 'post-toc-toggle-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    button.appendChild(label);
    button.appendChild(arrow);

    header.appendChild(title);
    header.appendChild(button);
    wrap.appendChild(header);
    wrap.appendChild(toc);

    var collapsed = itemCount > TOC_COLLAPSE_THRESHOLD;
    apply(collapsed);

    header.addEventListener('click', function () {
      collapsed = !collapsed;
      apply(collapsed);
    });

    function apply(isCollapsed) {
      toc.style.display = isCollapsed ? 'none' : '';
      label.textContent = isCollapsed ? '展开' : '收起';
      button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      if (isCollapsed) {
        wrap.classList.add('is-collapsed');
      } else {
        wrap.classList.remove('is-collapsed');
      }
    }
  }

  /* ============ 3. 清理 Markdown / Pandoc 边界渲染瑕疵 ============ */
  function fixMarkdownArtifacts() {
    var postMd = document.querySelector('.post-md');
    if (!postMd) return;

    // 修复 blockquote 内未解析的 '### 标题'（例如 >  ### 一维模型 被 pandoc 当成普通 p）
    var bqPs = postMd.querySelectorAll('blockquote p');
    Array.prototype.forEach.call(bqPs, function (p) {
      var text = (p.textContent || '').trim();
      var match = /^(#{1,6})\s+(.+)$/.exec(text);
      if (match && p.children.length === 0) {
        var level = match[1].length;
        var h = document.createElement('h' + level);
        h.textContent = match[2];
        h.style.marginTop = '4px';
        h.style.marginBottom = '8px';
        p.parentNode.replaceChild(h, p);
      }
    });

    // 清理 Typora 复制粘贴留下的零宽空格 (\u200b) 开头段落缩进异常
    var allPs = postMd.querySelectorAll('p');
    Array.prototype.forEach.call(allPs, function (p) {
      if (p.firstChild && p.firstChild.nodeType === 3) {
        p.firstChild.nodeValue = p.firstChild.nodeValue.replace(/^[\u200b\s]+/, function (m) {
          return m.indexOf('\u200b') > -1 ? '' : m;
        });
      }
    });
  }
})();
