document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.hidden = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value }),
    });
    if (res.ok) { location.href = '/admin'; return; }
    const out = await res.json().catch(() => ({}));
    err.textContent = out.error || 'Could not sign in.';
  } catch {
    err.textContent = 'We couldn\'t reach the server. Please try again.';
  }
  err.hidden = false;
});
