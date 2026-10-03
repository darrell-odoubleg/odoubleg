const el = {
  locationSelect: document.getElementById('location-select'),
  noteForm: document.getElementById('note-form'),
  authorInput: document.getElementById('author-input'),
  bodyInput: document.getElementById('body-input'),
  formError: document.getElementById('form-error'),
  notesList: document.getElementById('notes-list'),
  emptyMsg: document.getElementById('empty-msg'),
  errorBanner: document.getElementById('error-banner'),
  logoutBtn: document.getElementById('logout-btn'),
};

const LAST_LOCATION_KEY = 'sitenotes:lastLocation';
const AUTHOR_KEY = 'sitenotes:author';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso.replace(' ', 'T') + 'Z').toLocaleString();
}

function renderNotes(notes) {
  el.notesList.innerHTML = '';
  el.emptyMsg.hidden = notes.length > 0;
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'note-row';
    li.innerHTML = `
      <div class="note-meta">
        <span>${escapeHtml(note.author || 'Anonymous')}</span>
        <span>${escapeHtml(fmtDate(note.created_at))}</span>
      </div>
      <div class="note-body">${escapeHtml(note.body)}</div>
    `;
    el.notesList.appendChild(li);
  }
}

async function loadNotes(location) {
  try {
    const res = await fetch(`/api/notes?location=${encodeURIComponent(location)}`);
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    renderNotes(data.notes);
    el.errorBanner.hidden = true;
  } catch (err) {
    el.errorBanner.textContent = `Couldn't load notes: ${err.message}`;
    el.errorBanner.hidden = false;
  }
}

async function loadLocations() {
  const res = await fetch('/api/locations');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return;
  }
  const data = await res.json();
  el.locationSelect.innerHTML = '';
  for (const loc of data.locations) {
    const opt = document.createElement('option');
    opt.value = loc;
    opt.textContent = loc;
    el.locationSelect.appendChild(opt);
  }

  const saved = localStorage.getItem(LAST_LOCATION_KEY);
  if (saved && data.locations.includes(saved)) {
    el.locationSelect.value = saved;
  }
  loadNotes(el.locationSelect.value);
}

el.locationSelect.addEventListener('change', () => {
  localStorage.setItem(LAST_LOCATION_KEY, el.locationSelect.value);
  loadNotes(el.locationSelect.value);
});

const savedAuthor = localStorage.getItem(AUTHOR_KEY);
if (savedAuthor) el.authorInput.value = savedAuthor;

el.noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.formError.hidden = true;

  const body = el.bodyInput.value.trim();
  if (!body) return;

  const author = el.authorInput.value.trim();
  localStorage.setItem(AUTHOR_KEY, author);

  const submitBtn = el.noteForm.querySelector('button');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: el.locationSelect.value, author, body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server returned ${res.status}`);
    }
    el.bodyInput.value = '';
    await loadNotes(el.locationSelect.value);
  } catch (err) {
    el.formError.textContent = err.message;
    el.formError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

el.logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

loadLocations();
