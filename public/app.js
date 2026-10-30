const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let docs = [];
let filter = 'all';
let pollTimer = null;
const open = new Set();

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- rendering ----------

const badge = (rel) => `<span class="badge rel-${esc(rel)}">${esc(rel === 'none' ? 'nothing found' : rel)}</span>`;
const sig = (s) => `<span class="sig sig-${esc(s)}" title="${esc(s)} significance"></span>`;

function quote(f) {
  if (!f.quote) return '';
  return `<blockquote>“${esc(f.quote)}”${f.location ? ` <span class="loc">— ${esc(f.location)}</span>` : ''}</blockquote>`;
}

function sleepSection(s) {
  if (!s) return '';
  const metrics = s.key_metrics.length
    ? `<div class="metrics">${s.key_metrics.map(m => `<div class="metric"><span class="m-name">${esc(m.name)}</span><span class="m-val">${esc(m.value)}</span><span class="m-int">${esc(m.interpretation)}</span></div>`).join('')}</div>`
    : '';
  const findings = s.findings.map(f => `
    <li>${sig(f.significance)}<div><strong>${esc(f.item)}</strong> ${esc(f.detail)}${quote(f)}</div></li>`).join('');
  return `
    <div class="section sleep">
      <h4>Sleep apnea ${badge(s.relevance)}</h4>
      <p>${esc(s.assessment)}</p>
      ${metrics}
      ${findings ? `<ul class="findings">${findings}</ul>` : ''}
    </div>`;
}

function vaSection(v) {
  if (!v) return '';
  const findings = v.findings.map(f => `
    <li>${sig(f.significance)}<div><span class="cat">${esc(f.category)}</span> <strong>${esc(f.item)}</strong> ${esc(f.detail)}
      ${f.why_it_matters ? `<p class="why">Why it matters: ${esc(f.why_it_matters)}</p>` : ''}${quote(f)}</div></li>`).join('');
  const claims = v.possible_claims.length ? `
    <table class="claims"><thead><tr><th>Possible claim</th><th>Code</th><th>Evidence here</th><th>Service-connection angle</th></tr></thead>
    <tbody>${v.possible_claims.map(c => `<tr><td>${esc(c.condition)}</td><td>${esc(c.diagnostic_code)}</td><td>${esc(c.evidence_in_document)}</td><td>${esc(c.service_connection_angle)}</td></tr>`).join('')}</tbody></table>` : '';
  return `
    <div class="section va">
      <h4>VA disability ${badge(v.relevance)}</h4>
      <p>${esc(v.assessment)}</p>
      ${claims}
      ${findings ? `<ul class="findings">${findings}</ul>` : ''}
    </div>`;
}

function docCard(d) {
  const a = d.analysis;
  const status = {
    queued: '<span class="status">Waiting…</span>',
    processing: '<span class="status spin">Analyzing…</span>',
    error: `<span class="status err">Failed</span>`,
    done: a ? `${badge(a.sleep_apnea.relevance)}<span class="lbl">sleep</span> ${badge(a.va_disability.relevance)}<span class="lbl">VA</span>` : '',
  }[d.status];
  const meta = a ? [a.document_type, a.document_date, a.provider_or_facility].filter(Boolean).map(esc).join(' · ') : '';
  let body = '';
  if (d.status === 'error') body = `<p class="error">${esc(d.error)}</p>`;
  if (a) {
    body = `
      <p class="summary">${esc(a.summary)}</p>
      ${filter !== 'va' ? sleepSection(a.sleep_apnea) : ''}
      ${filter !== 'sleep' ? vaSection(a.va_disability) : ''}
      ${a.follow_up_questions.length ? `<div class="section"><h4>Worth asking about</h4><ul class="plain">${a.follow_up_questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}`;
  }
  return `
    <details class="doc" data-id="${d.id}" ${open.has(d.id) ? 'open' : ''}>
      <summary>
        <div class="doc-title"><strong>${esc(d.name)}</strong><span class="muted">${meta || new Date(d.uploaded_at + 'Z').toLocaleString()}</span></div>
        <div class="doc-status">${status}</div>
      </summary>
      <div class="doc-body">
        ${body}
        <div class="doc-actions">
          <a href="/api/documents/${d.id}/file" target="_blank" rel="noopener">Open original</a>
          ${['done', 'error'].includes(d.status) ? `<button type="button" class="ghost" data-act="reanalyze">Re-analyze</button>` : ''}
          ${d.status !== 'processing' ? `<button type="button" class="ghost danger" data-act="delete">Delete</button>` : ''}
        </div>
      </div>
    </details>`;
}

function matchesFilter(d) {
  if (filter === 'all' || !d.analysis) return true;
  const rel = filter === 'sleep' ? d.analysis.sleep_apnea.relevance : d.analysis.va_disability.relevance;
  return rel !== 'none';
}

function renderDocs() {
  const shown = docs.filter(matchesFilter);
  $('#docs').innerHTML = shown.length ? shown.map(docCard).join('') : `<p class="muted">${docs.length ? 'Nothing relevant in these documents for this filter.' : 'No documents yet.'}</p>`;
}

function renderSummary(s) {
  if (!s) return;
  const x = s.summary;
  const li = (arr) => arr.length ? `<ul class="plain">${arr.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">None noted.</p>';
  const stale = docs.some(d => d.status === 'done' && !s.doc_ids.includes(d.id));
  $('#summary').innerHTML = `
    <p class="muted">Covers ${s.doc_ids.length} document(s) · ${new Date(s.created_at.includes('T') ? s.created_at : s.created_at + 'Z').toLocaleString()}
      ${stale ? ' · <strong>new documents since — run it again to include them</strong>' : ''}</p>
    <p class="summary">${esc(x.overview)}</p>
    <div class="cols">
      <div class="section sleep">
        <h4>Sleep apnea</h4>
        <p>${esc(x.sleep_apnea.status)}</p>
        <h5>Strongest evidence</h5>${li(x.sleep_apnea.strongest_evidence)}
        <h5>Gaps</h5>${li(x.sleep_apnea.gaps)}
      </div>
      <div class="section va">
        <h4>VA disability</h4>
        <h5>Strongest evidence</h5>${li(x.va_disability.strongest_evidence)}
        <h5>Gaps</h5>${li(x.va_disability.gaps)}
      </div>
    </div>
    ${x.va_disability.possible_claims.length ? `
      <h4>Possible claims</h4>
      <table class="claims"><thead><tr><th>Condition</th><th>Code</th><th>Supporting documents</th><th>Service-connection angle</th><th>Missing</th></tr></thead>
      <tbody>${x.va_disability.possible_claims.map(c => `<tr><td>${esc(c.condition)}</td><td>${esc(c.diagnostic_code)}</td><td>${esc(c.supporting_documents)}</td><td>${esc(c.service_connection_angle)}</td><td>${esc(c.missing_pieces)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${x.timeline.length ? `
      <h4>Timeline</h4>
      <table class="claims timeline"><tbody>${x.timeline.map(t => `<tr><td class="nowrap">${esc(t.date)}</td><td>${esc(t.event)}</td><td class="muted">${esc(t.document)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h4>Next steps</h4>${li(x.next_steps)}`;
}

// ---------- data ----------

async function load() {
  const data = await api('/api/documents');
  docs = data.documents;
  $('#key-warning').hidden = data.ready;
  renderDocs();
  const busy = docs.some(d => d.status === 'queued' || d.status === 'processing');
  clearTimeout(pollTimer);
  if (busy) pollTimer = setTimeout(load, 4000);
  $('#summary-btn').disabled = busy || !docs.some(d => d.status === 'done');
}

async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  $('#upload-status').textContent = `Uploading ${files.length} file(s)…`;
  try {
    const r = await api('/api/documents', { method: 'POST', body: fd });
    const skipped = files.length - r.added;
    $('#upload-status').textContent = `Uploaded ${r.added} file(s)${skipped ? ` · ${skipped} skipped (unsupported type)` : ''}. Analysis takes a minute or two per document.`;
  } catch (err) {
    $('#upload-status').textContent = err.message;
  }
  load();
}

// ---------- events ----------

$('#pick-btn').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]));

document.querySelectorAll('.chip').forEach(c => c.onclick = () => {
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
  filter = c.dataset.filter;
  renderDocs();
});

$('#docs').addEventListener('toggle', (e) => {
  const id = Number(e.target.dataset.id);
  if (e.target.open) open.add(id); else open.delete(id);
}, true);

$('#docs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.doc').dataset.id;
  try {
    if (btn.dataset.act === 'delete') {
      if (!confirm('Delete this document and its analysis?')) return;
      await api(`/api/documents/${id}`, { method: 'DELETE' });
    } else {
      await api(`/api/documents/${id}/reanalyze`, { method: 'POST' });
    }
  } catch (err) { alert(err.message); }
  load();
});

$('#summary-btn').onclick = async () => {
  const btn = $('#summary-btn');
  btn.disabled = true;
  btn.textContent = 'Reviewing… (a minute or two)';
  try { renderSummary(await api('/api/summary', { method: 'POST' })); }
  catch (err) { alert(err.message); }
  btn.textContent = 'Review all documents together';
  btn.disabled = false;
};

$('#print-btn').onclick = () => { document.querySelectorAll('details.doc').forEach(d => d.open = true); window.print(); };
$('#logout-btn').onclick = async () => { await fetch('/logout', { method: 'POST' }); location.href = '/login.html'; };

load().then(() => api('/api/summary')).then(renderSummary).catch(err => console.error(err));
