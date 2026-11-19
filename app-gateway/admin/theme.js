// Applied before first paint, so a chosen theme never flashes the other one.
// Not deferred, and its own file because the page's CSP allows no inline script.
'use strict';
(() => {
  const key = 'gw-theme';
  const root = document.documentElement;
  const labels = { auto: 'System', light: 'Light', dark: 'Dark' };
  function apply(value, persist = false) {
    if (value === 'light' || value === 'dark') root.dataset.theme = value;
    else delete root.dataset.theme;
    if (persist) {
      try {
        if (root.dataset.theme) localStorage.setItem(key, root.dataset.theme);
        else localStorage.removeItem(key);
      } catch { /* The choice can still apply to the current page. */ }
    }
    const mode = root.dataset.theme || 'auto';
    for (const picker of document.querySelectorAll('[data-theme-picker]')) {
      const label = picker.querySelector('.theme-label');
      if (!label) continue;
      label.textContent = labels[mode];
      const button = picker.querySelector('.theme-trigger');
      button.setAttribute('aria-label', 'Color theme: ' + labels[mode]);
      button.querySelector('.theme-symbol').dataset.mode = mode;
      for (const option of picker.querySelectorAll('[role="menuitemradio"]')) {
        option.setAttribute('aria-checked', String(option.dataset.mode === mode));
      }
    }
  }
  try { apply(localStorage.getItem(key)); } catch { /* Follow the system. */ }
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });

  function mount(picker, index) {
    const menuId = 'gateway-theme-options-' + index;
    picker.innerHTML = `<button class="theme-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
      <span class="theme-symbol" aria-hidden="true"></span><span class="theme-label"></span><span class="theme-chevron" aria-hidden="true"></span>
    </button><div class="theme-options" id="${menuId}" role="menu" aria-label="Color theme" hidden>
      ${Object.entries(labels).map(([mode, label]) => `<button type="button" role="menuitemradio" tabindex="-1" data-mode="${mode}" aria-checked="false">
        <span class="theme-symbol" data-mode="${mode}" aria-hidden="true"></span><span>${label}</span><span class="theme-check" aria-hidden="true">✓</span>
      </button>`).join('')}
    </div>`;
    const trigger = picker.querySelector('.theme-trigger');
    const menu = picker.querySelector('.theme-options');
    const choices = [...menu.children];
    function close(restoreFocus = false) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }
    function open(focusItem = false, last = false) {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      if (focusItem) {
        const target = last ? choices.at(-1) : choices.find(item => item.getAttribute('aria-checked') === 'true');
        (target || choices[0]).focus();
      }
    }
    trigger.addEventListener('click', event => {
      if (menu.hidden) open(event.detail === 0);
      else close();
    });
    picker.addEventListener('focusout', event => {
      if (!picker.contains(event.relatedTarget)) close();
    });
    document.addEventListener('pointerdown', event => {
      if (!menu.hidden && !picker.contains(event.target)) close();
    });
    menu.addEventListener('click', event => {
      const option = event.target.closest('[role="menuitemradio"]');
      if (!option) return;
      apply(option.dataset.mode, true);
      close(true);
    });
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.stopPropagation();
        close(true);
        return;
      }
      const { key } = event;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
      event.preventDefault();
      if (menu.hidden) {
        open(true, key === 'ArrowUp' || key === 'End');
        return;
      }
      const current = choices.indexOf(document.activeElement);
      const next = key === 'Home' ? 0 : key === 'End' ? choices.length - 1
        : current < 0 ? (key === 'ArrowUp' ? choices.length - 1 : 0)
        : (current + (key === 'ArrowUp' ? -1 : 1) + choices.length) % choices.length;
      choices[next].focus();
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    [...document.querySelectorAll('[data-theme-picker]')].forEach(mount);
    apply(root.dataset.theme);
  });
})();
