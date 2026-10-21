/**
 * A4 主题自定义前端增强
 * 1. 列表页：按年份分组折叠（默认最新一年展开，其余收起）
 * 注：纯前端 DOM 处理，不改动主题模板。
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
      // 含 .year-font-color 的 li 是分组标题（年份 / Recent-Updates）
      if (li.querySelector('.year-font-color')) {
        current = { header: li, items: [] };
        groups.push(current);
      } else if (current) {
        current.items.push(li);
      }
      // 分组标题之前的 li（如 TOP 置顶文章）保持原样显示，不参与折叠
    });

    groups.forEach(function (group, index) {
      var header = group.header;
      if (!group.items.length) return; // 没有子项的分组头不加折叠
      header.classList.add('archive-fold-header');

      var arrow = document.createElement('span');
      arrow.className = 'archive-fold-arrow';
      header.insertBefore(arrow, header.firstChild);

      // 默认：第一个（最新）年份展开，其余收起
      var collapsed = index !== 0;
      apply(group, collapsed);

      header.addEventListener('click', function (e) {
        if (e.target.closest('a')) return; // 点击链接时正常跳转，不触发折叠
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
})();
