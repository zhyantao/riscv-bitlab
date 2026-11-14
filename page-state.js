(function (root) {
  'use strict';
  const key = 'riscv-page-state:v1:' + location.pathname;
  let warned = false;
  function warn() {
    if (warned) return;
    warned = true;
    const note = document.createElement('p');
    note.setAttribute('role', 'status');
    note.textContent = '浏览器未允许页面缓存，本次输入可能无法在切换页面后恢复。';
    note.style.cssText = 'padding:8px 12px;color:#991b1b;background:#fef2f2';
    document.body.append(note);
  }
  function load() {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      if (raw.length > 1000000) return null;
      const state = JSON.parse(raw);
      return state && state.version === 1 && typeof state.controls === 'object' ? state : null;
    } catch { warn(); return null; }
  }
  function bind({ selector = 'input[id], select[id], textarea[id]', read = () => null, restore = () => {}, render = () => {}, state = load() } = {}) {
    if (state) {
      document.querySelectorAll(selector).forEach(input => {
        if (input.readOnly || input.type === 'password' || input.type === 'file') return;
        const saved = state.controls?.[input.id];
        if (!saved || typeof saved.value !== 'string') return;
        if (input.tagName !== 'SELECT' || [...input.options].some(option => option.value === saved.value)) input.value = saved.value;
        if (['checkbox', 'radio'].includes(input.type) && typeof saved.checked === 'boolean') input.checked = saved.checked;
      });
      restore(state.extra);
      render();
    }
    function save() {
      const controls = Object.create(null);
      document.querySelectorAll(selector).forEach(input => {
        if (input.readOnly || input.type === 'password' || input.type === 'file') return;
        controls[input.id] = { value:input.value, checked:input.checked === true };
      });
      try { sessionStorage.setItem(key, JSON.stringify({ version:1, controls, extra:read() })); }
      catch { warn(); }
    }
    for (const event of ['input', 'change', 'click', 'submit', 'toggle']) document.addEventListener(event, save);
    window.addEventListener('pagehide', save);
    save();
    return save;
  }
  root.PageState = { load, bind };
})(globalThis);
