(() => {
  let authState = { sessions: [] };

  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str == null ? '' : String(str);
    return el.innerHTML;
  }

  const UI = {
    login: { screen: 'loginScreen', user: 'loginUser', pass: 'loginPass', btn: 'loginBtn', msg: 'loginMsg' },
    dash: 'dashboard',
    screens: ['sessions', 'questions', 'simulator', 'settings'],
    table: document.getElementById('sessionsTable').querySelector('tbody'),
    replay: {
      section: 'replaySection',
      name: 'replayCandidate',
      summary: 'reviewSummary',
      answers: 'answerReview',
      log: 'replayTimeline'
    },
    sim: { angle: document.getElementById('simAngle'), real: document.getElementById('simReal'), decoy: document.getElementById('simDecoy'), status: document.getElementById('simStatus') }
  };

  const api = async (path, method = 'GET', body = null) => {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
    if (!res.ok) return null;
    return res.json();
  };

  function showScreen(name) {
    UI.screens.forEach(s => document.getElementById(`screen-${s}`).classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    document.getElementById(`screen-${name}`).classList.add('active');
    if (name === 'sessions') refreshSessions();
    if (name === 'settings') loadSettings();
  }

  document.getElementById(UI.login.btn).onclick = async () => {
    const user = document.getElementById(UI.login.user).value;
    const pass = document.getElementById(UI.login.pass).value;
    const res = await api('/api/admin/login', 'POST', { username: user, password: pass });
    
    if (!res || !res.ok) {
      document.getElementById(UI.login.msg).textContent = "Invalid administrator credentials";
      return;
    }
    document.getElementById(UI.login.screen).classList.remove('active');
    document.getElementById(UI.dash).classList.remove('is-hidden');
    refreshSessions();
  };

  async function checkAuth() {
    try {
      const res = await fetch('/api/admin/sessions', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (res.status === 200) {
        document.getElementById(UI.login.screen).classList.remove('active');
        document.getElementById(UI.dash).classList.remove('is-hidden');
        authState.sessions = await res.json();
        renderSessions();
      }
    } catch (e) { console.error("Session restoration failed", e); }
  }
  checkAuth();

  async function refreshSessions() {
    try {
      const res = await api('/api/admin/sessions');
      if (!res) return;
      authState.sessions = res;
      renderSessions();
    } catch(e) { console.error("Session sync failed", e); }
  }

  function renderSessions() {
    UI.table.innerHTML = '';
    if (authState.sessions.length === 0) {
      UI.table.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:3rem; color:var(--text-secondary)">No assessment sessions recorded yet.</td></tr>';
      return;
    }
    
    authState.sessions.forEach(session => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      const integrity = session.integrity_score || 0;
      const statusClass = integrity >= 80 ? 'pass' : (integrity >= 50 ? 'warn' : 'review');
      
      row.innerHTML = `
        <td style="font-weight:600">${esc(session.name)}</td>
        <td>${esc(new Date(session.started_at*1000).toLocaleString())}</td>
        <td>${Math.round(session.durationSec / 60)}m</td>
        <td>${Math.round((session.score || 0)*100)}%</td>
        <td><span class="badge ${statusClass}">${statusClass.toUpperCase()} (${integrity})</span></td>
      `;
      row.onclick = () => loadForensicAudit(session.token, session.name);
      UI.table.appendChild(row);
    });
  }

  function formatTime(ts) {
    return ts ? new Date(ts * 1000).toLocaleString() : 'Not finished';
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(seconds || 0));
    const minutes = Math.floor(value / 60);
    const secs = value % 60;
    return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  }

  async function loadForensicAudit(token, name) {
    const res = await api(`/api/admin/session/${encodeURIComponent(token)}`);
    if (!res) return;
    const auditData = res;
    const session = auditData.session;
    document.getElementById(UI.replay.section).classList.remove('is-hidden');
    document.getElementById(UI.replay.name).textContent = session.candidate_email || name;

    document.getElementById(UI.replay.summary).innerHTML = [
      ['Candidate', session.candidate_email],
      ['Started', formatTime(session.started_at)],
      ['Finished', session.finished_at ? formatTime(session.finished_at) : 'Active'],
      ['Duration', formatDuration(session.durationSec)],
      ['Score', `${Math.round((session.score || 0) * 100)}% (${session.correct_count}/${session.total_questions})`],
      ['Answers', `${session.answered_count}/${session.total_questions}`],
      ['Integrity', session.integrity_score],
      ['Status', session.status]
    ].map(([label, value]) => `
      <div class="review-metric">
        <span>${esc(label)}</span>
        <strong>${esc(value)}</strong>
      </div>
    `).join('');

    document.getElementById(UI.replay.answers).innerHTML = auditData.answers.length > 0
      ? `
        <table class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Question</th>
              <th>Submitted</th>
              <th>Correct Answer</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            ${auditData.answers.map(answer => {
              const resultClass = !answer.answered ? 'muted' : (answer.correct ? 'pass' : 'review');
              const resultText = !answer.answered ? 'UNANSWERED' : (answer.correct ? 'CORRECT' : 'INCORRECT');
              return `
                <tr>
                  <td>${esc(answer.index + 1)}</td>
                  <td>
                    <strong>${esc(answer.subject || 'General')}</strong><br>
                    ${esc(answer.question)}
                  </td>
                  <td>${esc(answer.submitted_answer || 'No answer')}</td>
                  <td>${esc(answer.correct_answer || 'Unavailable')}</td>
                  <td><span class="badge ${resultClass}">${resultText}</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `
      : '<div style="padding:1rem; color:var(--text-secondary)">No questions were assigned to this session.</div>';
    
    document.getElementById(UI.replay.log).innerHTML = auditData.events.length > 0 
      ? auditData.events.map(event => `
          <div class="check-item">
            <span style="font-family:monospace; font-size:0.75rem">[${esc(new Date(event.created_at*1000).toLocaleTimeString())}]</span>
            <b style="min-width:140px; display:inline-block">${esc(event.type.toUpperCase())}</b>
            <span>${esc(event.detail || 'No additional metadata')}</span>
            ${event.duration_ms != null ? `<span style="color:var(--text-secondary)">(${esc(event.duration_ms)}ms)</span>` : ''}
          </div>
        `).join('')
      : '<div style="text-align:center; padding:1rem; color:var(--text-secondary)">No behavioral anomalies detected during this session.</div>';
      
    document.getElementById(UI.replay.section).scrollIntoView({ behavior: 'smooth' });
  }

  UI.sim.angle.oninput = (e) => {
    const val = parseInt(e.target.value);
    const absVal = Math.abs(val);
    const opacity = Math.min(1, Math.max(0, (absVal - 12) / 10));
    
    UI.sim.real.style.opacity = 1 - opacity;
    UI.sim.decoy.style.opacity = opacity;
    UI.sim.decoy.style.transform = `translateX(${val * 0.8}px)`;
    
    const isAligned = absVal <= 15;
    UI.sim.status.querySelector('.check-item').style.background = isAligned ? 'var(--status-good)' : 'var(--status-bad)';
    UI.sim.status.querySelector('.check-item').textContent = isAligned ? 'ALIGNED: Real Content Visible' : 'OUT OF ALIGNMENT: Decoy Active';
  };

  document.getElementById('addQuestionBtn').onclick = () => window.closeQuestionForm() || document.getElementById('questionForm').classList.remove('is-hidden');
  document.getElementById('closeReplayBtn').onclick = () => document.getElementById('replaySection').classList.add('is-hidden');
  document.getElementById('cancelQuestionBtn').onclick = () => window.closeQuestionForm();
  
  window.closeQuestionForm = () => {
    document.getElementById('questionForm').classList.add('is-hidden');
    document.getElementById('formId').value = '';
    document.getElementById('formSubject').value = '';
    document.getElementById('formText').value = '';
    document.getElementById('formOptions').value = '';
    document.getElementById('formCorrect').value = '0';
    document.getElementById('formDecoyL').value = '';
    document.getElementById('formDecoyR').value = '';
    document.getElementById('formTitle').textContent = "Create New Question";
  };

  window.editQuestion = (id, subject, text, options, correctIndex, decoyLeft, decoyRight) => {
    document.getElementById('formTitle').textContent = "Edit Question";
    document.getElementById('formId').value = id;
    document.getElementById('formSubject').value = subject;
    document.getElementById('formText').value = text;
    document.getElementById('formOptions').value = options;
    document.getElementById('formCorrect').value = correctIndex;
    document.getElementById('formDecoyL').value = decoyLeft || '';
    document.getElementById('formDecoyR').value = decoyRight || '';
    document.getElementById('questionForm').classList.remove('is-hidden');
    document.getElementById('questionForm').scrollIntoView({ behavior: 'smooth' });
  };

  window.deleteQuestion = async (id) => {
    if (!confirm("Are you sure you want to delete this question?")) return;
    const res = await api(`/api/admin/question/${id}`, 'DELETE');
    if (res && res.ok) {
      refreshQuestions();
    }
  };

  document.getElementById('submitQuestion').onclick = async () => {
    const id = document.getElementById('formId').value;
    const payload = {
      subject: document.getElementById('formSubject').value || 'General',
      question: document.getElementById('formText').value,
      options: document.getElementById('formOptions').value.split(',').map(o => o.trim()),
      correctIndex: parseInt(document.getElementById('formCorrect').value || 0),
      decoyLeft: document.getElementById('formDecoyL').value || '',
      decoyRight: document.getElementById('formDecoyR').value || ''
    };
    const path = id ? `/api/admin/question/${id}` : '/api/admin/question';
    const method = id ? 'PATCH' : 'POST';
    const res = await api(path, method, payload);
    if (res && res.ok) {
      window.closeQuestionForm();
      refreshQuestions();
    }
  };
  
  let _questionCache = [];

  async function refreshQuestions() {
    const res = await api('/api/admin/questions');
    if (!res) return;
    _questionCache = res;
    const tbody = document.getElementById('questionsTable').querySelector('tbody');
    tbody.innerHTML = '';
    _questionCache.forEach((q, idx) => {
      let opts = [];
      try { opts = JSON.parse(q.options); } catch (e) { opts = []; }
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(q.id)}</td>
        <td style="font-weight:600">${esc(q.subject || 'General')}</td>
        <td>${esc(q.text)}</td>
        <td></td>
      `;
      const actionsCell = tr.querySelector('td:last-child');
      
      const editBtn = document.createElement('button');
      editBtn.className = 'btn';
      editBtn.style.cssText = 'padding:4px 8px; font-size:0.75rem; background:var(--accent-color); margin-right:4px;';
      editBtn.textContent = 'Edit';
      editBtn.onclick = () => window.editQuestion(q.id, q.subject || 'General', q.text, opts.join(','), q.correct_index || 0, q.decoy_left_text || '', q.decoy_right_text || '');
      actionsCell.appendChild(editBtn);
      
      const delBtn = document.createElement('button');
      delBtn.className = 'btn';
      delBtn.style.cssText = 'padding:4px 8px; font-size:0.75rem; background:var(--status-bad);';
      delBtn.textContent = 'Delete';
      delBtn.onclick = () => window.deleteQuestion(q.id);
      actionsCell.appendChild(delBtn);
      
      tbody.appendChild(tr);
    });
  }

  async function loadSettings() {
    try {
      const res = await api('/api/admin/settings');
      if (!res) return;
      const settings = res;
      if (settings.inactivity_timeout) document.getElementById('cfgTimeout').value = settings.inactivity_timeout;
      if (settings.integrity_threshold) document.getElementById('cfgThreshold').value = settings.integrity_threshold;
    } catch (e) { console.error("Failed to load settings", e); }
  }

  document.getElementById('saveCfg').onclick = async () => {
    const payload = {
      inactivity_timeout: document.getElementById('cfgTimeout').value,
      integrity_threshold: document.getElementById('cfgThreshold').value
    };
    const res = await api('/api/admin/settings', 'POST', payload);
    if (res && res.ok) {
      alert("System configuration successfully updated.");
    }
  };

  document.getElementById('exportCsv').onclick = () => {
    window.location.href = '/api/admin/sessions/export';
  };

  document.getElementById('logoutBtn').onclick = async () => {
    await api('/api/admin/logout', 'POST');
    window.location.href = '/admin';
  };
  
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', (e) => {
      const screen = e.target.dataset.screen;
      showScreen(screen);
      if (screen === 'questions') refreshQuestions();
  }));
})();
