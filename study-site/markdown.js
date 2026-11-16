/**
 * Safe DOM-constructing Markdown renderer (zero innerHTML usage).
 * Supports headings, GFM tables, lists, blockquotes, fenced code, inline code,
 * bold/italic, links (http/https/# only), and local/https images.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function safeHref(url) {
  const u = (url || '').trim();
  if (/^(https?:\/\/|\/|\.\/|#)/i.test(u)) return u;
  return null;
}

function appendInline(parent, text) {
  // Tokenize inline `code`, **bold**, *italic*, ![alt](src), [label](url)
  const re = /(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[2] !== undefined && m[3] !== undefined) {
      const src = safeHref(m[3]);
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = m[2];
        img.loading = 'lazy';
        parent.appendChild(img);
      } else {
        parent.appendChild(document.createTextNode(m[0]));
      }
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const href = safeHref(m[5]);
      if (href) {
        const a = el('a', null, m[4]);
        a.href = href;
        if (/^https?:/i.test(href)) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[4]));
      }
    } else if (m[6] !== undefined) {
      parent.appendChild(el('code', null, m[6]));
    } else if (m[7] !== undefined) {
      const strong = el('strong');
      appendInline(strong, m[7]);
      parent.appendChild(strong);
    } else if (m[8] !== undefined) {
      const em = el('em');
      appendInline(em, m[8]);
      parent.appendChild(em);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function parseTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

export function renderMarkdown(mdText, container) {
  container.replaceChildren();
  const root = el('div', 'md');
  const lines = String(mdText || '').split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // Fenced code block
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const fence = trimmed.slice(0, 3);
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = el('pre');
      pre.appendChild(el('code', null, codeLines.join('\n')));
      root.appendChild(pre);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      root.appendChild(el('hr'));
      i++;
      continue;
    }

    // Headings
    const hm = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hm) {
      const tag = `h${hm[1].length}`;
      const h = el(tag);
      appendInline(h, hm[2]);
      root.appendChild(h);
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const bq = el('blockquote');
      appendInline(bq, qLines.join(' '));
      root.appendChild(bq);
      continue;
    }

    // GFM Table
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|/.test(lines[i + 1].trim())) {
      const headers = parseTableRow(trimmed);
      i += 2; // skip header + separator
      const wrap = el('div', 'table-wrap');
      const table = el('table');
      const thead = el('thead');
      const hr = el('tr');
      for (const h of headers) {
        const th = el('th');
        appendInline(th, h);
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = parseTableRow(lines[i]);
        const tr = el('tr');
        for (let c = 0; c < headers.length; c++) {
          const td = el('td');
          appendInline(td, cells[c] ?? '');
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      root.appendChild(wrap);
      continue;
    }

    // Unordered or ordered list
    const isUl = /^[-*]\s+/.test(trimmed);
    const isOl = /^\d+\.\s+/.test(trimmed);
    if (isUl || isOl) {
      const list = el(isUl ? 'ul' : 'ol');
      const reItem = isUl ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      while (i < lines.length) {
        const curT = lines[i].trim();
        const lm = reItem.exec(curT);
        if (!lm) break;
        const li = el('li');
        appendInline(li, lm[1]);
        list.appendChild(li);
        i++;
      }
      root.appendChild(list);
      continue;
    }

    // Paragraph (gather contiguous text lines)
    const pLines = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || /^(#{1,4}\s|```|~~~|>|\|.*\||[-*]\s|\d+\.\s|---)/.test(t)) break;
      pLines.push(t);
      i++;
    }
    const p = el('p');
    appendInline(p, pLines.join(' '));
    root.appendChild(p);
  }

  container.appendChild(root);
}
