/**
 * A4 主题自定义前端增强
 * 1. 列表页：按年份分组折叠（默认最新一年展开，其余收起）
 * 2. 正文排版修复：清理 Pandoc + 引用块导致的未解析 > ### 标题和多余全角空格
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

  /* ============ 2. 清理 Markdown / Pandoc 边界渲染瑕疵 ============ */
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
