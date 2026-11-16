// Runs in Chrome's isolated content-script world. No page-to-background message listener.
(() => {
  if (globalThis.__gptBrowserPage) return;
  // elementId -> { node, label }. Staleness is judged per target element (same
  // node, still present, same own label), so unrelated page mutations elsewhere
  // no longer invalidate a whole snapshot.
  const elements = new Map();
  let snapshotId = null;
  function visible(node) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return node.isConnected && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && !node.closest('[inert],[aria-hidden="true"]');
  }
  function secret(node) {
    return node.matches('input[type="password"],input[type="hidden"],input[type="file"]') ||
      /password|one-time-code|cc-number|cc-csc/.test(node.getAttribute('autocomplete') || '');
  }
  function label(node) {
    return String(node.getAttribute('aria-label') || node.labels?.[0]?.innerText || node.getAttribute('placeholder') || node.innerText || node.getAttribute('title') || node.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  function bodyText(maxText) {
    // innerText does not include password input values or script text; redact marked private regions.
    const selection = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(text) {
        const parent = text.parentElement;
        if (!parent || parent.closest('script,style,noscript,input,textarea,[data-private],[autocomplete="one-time-code"]') || !visible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let result = '', node;
    while ((node = selection.nextNode()) && result.length < maxText) result += `${node.textContent.trim()} `;
    return result.replace(/\s+/g, ' ').trim().slice(0, maxText);
  }
  function find(args) {
    if (!snapshotId || args.snapshotId !== snapshotId) throw new Error('STALE_SNAPSHOT: 页面已刷新或快照已失效，请重新读取页面。');
    const entry = elements.get(args.elementId);
    if (!entry || !entry.node.isConnected) throw new Error('ELEMENT_UNAVAILABLE: 元素已被移除，请重新读取页面。');
    const node = entry.node;
    if (!visible(node)) throw new Error('ELEMENT_UNAVAILABLE');
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') throw new Error('ELEMENT_DISABLED');
    if (label(node) !== entry.label) throw new Error('STALE_SNAPSHOT: 目标元素内容已变化，请重新读取页面。');
    return node;
  }
  function deepElements(container, output = []) {
    for (const node of container.querySelectorAll('*')) {
      if (node.matches('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"],[tabindex]')) output.push(node);
      if (node.shadowRoot) deepElements(node.shadowRoot, output);
    }
    return output;
  }
  globalThis.__gptBrowserPage = async (action, args) => {
    if (action === 'snapshot') {
      elements.clear();
      snapshotId = crypto.randomUUID();
      const interactive = [];
      for (const node of deepElements(document)) {
        if (!visible(node) || secret(node) || node.closest('[data-private]')) continue;
        const elementId = `e${elements.size + 1}`;
        const text = label(node);
        elements.set(elementId, { node, label: text });
        interactive.push({
          elementId, tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), label: text,
          type: node.getAttribute('type'), disabled: !!node.disabled, checked: node.matches('input[type="checkbox"],input[type="radio"]') ? node.checked : undefined,
          value: node.matches('input,textarea,select') ? String(node.value).slice(0, 500) : undefined,
          options: node.tagName === 'SELECT' ? [...node.options].slice(0, 80).map(option => ({ value: option.value, label: option.label })) : undefined
        });
      }
      return { snapshotId, title: document.title, url: location.href, text: bodyText(args.maxText || 8000), elements: interactive, contentTrust: 'untrusted-page-data' };
    }
    if (action === 'probe') return { ready: document.readyState !== 'loading', found: args.text ? bodyText(200000).includes(args.text) : true, url: location.href };
    if (action === 'scroll') { window.scrollBy({ left: args.x, top: args.y, behavior: 'instant' }); return { x: scrollX, y: scrollY, url: location.href }; }
    const node = find(args);
    if (secret(node) || node.closest('[data-private]')) throw new Error('PRIVATE_FIELD');
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    if (action === 'click') {
      node.click();
    } else if (action === 'fill') {
      if (node.readOnly) throw new Error('FIELD_READONLY');
      node.focus();
      if (node.matches('input[type="checkbox"],input[type="radio"]')) {
        if (typeof args.checked !== 'boolean') throw new Error('CHECKED_REQUIRED');
        if (node.checked !== args.checked) node.click();
      } else if (node.matches('select')) {
        if (typeof args.text !== 'string') throw new Error('TEXT_REQUIRED');
        const wanted = args.text.trim();
        const options = [...node.options].filter(option => !option.disabled);
        // Accept the option's value first, then its visible label/text, so the
        // model can use either the value returned in the snapshot or what the user sees.
        const option = options.find(candidate => candidate.value === args.text)
          ?? options.find(candidate => candidate.label.trim() === wanted || candidate.textContent.trim() === wanted);
        if (!option) throw new Error('OPTION_NOT_FOUND');
        node.value = option.value;
      } else if (node.matches('input,textarea')) {
        if (typeof args.text !== 'string') throw new Error('TEXT_REQUIRED');
        if (node.matches('input') && !['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'time', 'month', 'week'].includes(node.type)) throw new Error('UNSUPPORTED_INPUT_TYPE');
        const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, args.text);
      } else if (node.isContentEditable) {
        if (typeof args.text !== 'string') throw new Error('TEXT_REQUIRED');
        node.textContent = args.text;
      } else throw new Error('ELEMENT_NOT_EDITABLE');
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else if (action === 'press_key') {
      node.focus();
      const key = args.key === 'Space' ? ' ' : args.key;
      const allowed = node.dispatchEvent(new KeyboardEvent('keydown', { key, code: args.key, bubbles: true, cancelable: true, composed: true }));
      // Synthetic keys do not invoke the browser's default submit behavior.
      if (allowed && key === 'Enter' && node.matches('input') && node.form) node.form.requestSubmit();
      else if (allowed && (key === 'Enter' || key === ' ') && node.matches('button,a[href]')) node.click();
      else if (allowed && key === 'Tab') {
        const focusable = deepElements(document).filter(candidate => visible(candidate) && !candidate.disabled && candidate.tabIndex >= 0);
        focusable[(focusable.indexOf(node) + 1) % focusable.length]?.focus();
      }
      node.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }));
    } else throw new Error('UNKNOWN_PAGE_ACTION');
    snapshotId = null;
    return { executed: true, verified: false, url: location.href, next: 'Read a fresh snapshot to verify the result.' };
  };
})();
