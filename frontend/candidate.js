(() => {
  const UI = {
    screens: { start: 'screen-start', test: 'screen-test', done: 'screen-complete' },
    checklist: { cam: document.getElementById('checkCamera'), face: document.getElementById('checkFace'), light: document.getElementById('checkLighting') },
    btn: document.getElementById('beginBtn'),
    canvas: document.getElementById('secureCanvas'),
    status: document.getElementById('statusMessage'),
    dot: document.getElementById('statusDot'),
    progress: document.getElementById('progressCounter'),
    answers: document.getElementById('answerGrid'),
    video: document.getElementById('trackingVideo'),
    preview: document.getElementById('previewVideo'),
    consent: document.getElementById('consentCheck')
  };

  let session = {
    active: false,
    currentYaw: 0,
    yawBaseline: null,
    blendFactors: { left: 0, right: 0 },
    lastBlinkTime: Date.now(),
    decoyFetched: false,
    decoyLeftText: null,
    decoyRightText: null,
    faceDetected: false,
    faceCount: 0,
    frameCount: 0,
    aesKey: null,
    privacyForced: false
  };

  let inactivityTimeout = 300; // fallback default
  let inactivityTimer;

  // Fetch public settings on initialization
  async function fetchPublicSettings() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.inactivity_timeout) inactivityTimeout = data.inactivity_timeout;
      }
    } catch (e) { console.error("Failed to fetch settings", e); }
  }
  fetchPublicSettings();

  function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (!session.active) return;
    inactivityTimer = setTimeout(() => {
      sendFlag('inactivity_timeout');
      showInactivityWarning();
    }, inactivityTimeout * 1000);
  }

  function showInactivityWarning() {
    let overlay = document.getElementById('inactivity-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'inactivity-overlay';
      overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); color:#fff; display:flex; flex-direction:column; justify-content:center; align-items:center; z-index:9999; font-family:sans-serif;';
      overlay.innerHTML = `
        <h2 style="color:var(--status-bad); font-size:2rem; margin-bottom:1rem;">Inactivity Warning</h2>
        <p style="font-size:1.1rem; margin-bottom:1.5rem;">You have been inactive for too long. This event has been flagged.</p>
        <button class="btn" id="resumeBtn">Resume Assessment</button>
      `;
      document.body.appendChild(overlay);
      document.getElementById('resumeBtn').onclick = () => {
        overlay.remove();
        resetInactivityTimer();
      };
    }
  }

  function setBiometricUnavailable(message) {
    const loader = document.getElementById('biometric-loader');
    if (loader) {
      loader.textContent = '';
      const panel = document.createElement('div');
      panel.className = 'biometric-error-panel';
      const title = document.createElement('h2');
      title.textContent = 'Biometric engine unavailable';
      const copy = document.createElement('p');
      copy.textContent = message;
      const retry = document.createElement('button');
      retry.className = 'btn';
      retry.id = 'retryBiometricBtn';
      retry.textContent = 'Retry';
      retry.onclick = () => location.reload();
      panel.append(title, copy, retry);
      loader.appendChild(panel);
    }
    UI.status.textContent = 'Biometric setup failed';
    UI.btn.disabled = true;
    UI.btn.textContent = 'Setup Required';
    UI.checklist.cam.classList.remove('ok');
    UI.checklist.face.classList.remove('ok');
    UI.checklist.light.classList.remove('ok');
  }

  function checkWebGL() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      const err = document.getElementById("webgl-error");
      if (err) err.style.display = "block";
      return false;
    }
    return true;
  }
  if (!checkWebGL()) return;

  const gl = UI.canvas.getContext('webgl');
  const vertSource = `
    attribute vec2 p;
    varying vec2 v;
    void main() {
      v = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
      gl_Position = vec4(p, 0.0, 1.0);
    }
  `;
  const fragSource = `
    precision highp float;
    varying vec2 v;
    uniform sampler2D realTex;
    uniform float privacyAmount, privacyDir, lockAmount, scanTime;

    float hash(float n) {
      return fract(sin(n) * 43758.5453123);
    }

    void main() {
      vec4 real = texture2D(realTex, v);
      float p = smoothstep(0.0, 1.0, privacyAmount);
      p = max(p, lockAmount);
      float slat = floor(v.x * 72.0);
      float row = floor(v.y * 26.0);
      float jitter = (hash(slat * 19.17 + row * 3.91) - 0.5) * 0.22 * p;
      vec2 shreddedUv = vec2(
        clamp(0.5 + (v.x - 0.5) * (1.0 - 0.72 * p) + privacyDir * 0.42 * p + jitter, 0.0, 1.0),
        clamp(v.y + (hash(row * 11.3 + slat) - 0.5) * 0.09 * p, 0.0, 1.0)
      );
      vec4 shredded = texture2D(realTex, shreddedUv);
      float shutter = step(0.42 + 0.22 * p, fract(v.x * 72.0 + privacyDir * p * 8.0));
      vec3 shutterColor = mix(vec3(0.03, 0.04, 0.06), vec3(0.92, 0.95, 0.98), shutter);
      vec3 protectedColor = mix(shutterColor, shredded.rgb, 0.12 * (1.0 - shutter) * (1.0 - lockAmount));
      float sweep = fract(scanTime * 1.65);
      float bandA = 1.0 - smoothstep(0.014, 0.034, abs(v.y - sweep));
      float bandB = 1.0 - smoothstep(0.014, 0.034, abs(v.y - fract(sweep + 0.25)));
      float bandC = 1.0 - smoothstep(0.014, 0.034, abs(v.y - fract(sweep + 0.50)));
      float bandD = 1.0 - smoothstep(0.014, 0.034, abs(v.y - fract(sweep + 0.75)));
      float reveal = clamp(max(max(bandA, bandB), max(bandC, bandD)) + 0.28, 0.0, 1.0);
      float microSlat = step(0.38, fract(v.x * 118.0 + scanTime * 1.7));
      reveal *= mix(0.55, 1.0, microSlat);
      vec3 paper = vec3(0.96, 0.98, 1.0);
      vec3 staticProtected = mix(paper, real.rgb, reveal);
      gl_FragColor = vec4(mix(staticProtected, protectedColor, p), 1.0);
    }
  `;

  function createShader(gl, type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source); gl.compileShader(s);
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, createShader(gl, gl.VERTEX_SHADER, vertSource));
  gl.attachShader(prog, createShader(gl, gl.FRAGMENT_SHADER, fragSource));
  gl.linkProgram(prog); gl.useProgram(prog);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const pLoc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(pLoc); gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);

  const unis = {
    real: gl.getUniformLocation(prog, 'realTex'),
    privacyAmount: gl.getUniformLocation(prog, 'privacyAmount'),
    privacyDir: gl.getUniformLocation(prog, 'privacyDir'),
    lockAmount: gl.getUniformLocation(prog, 'lockAmount'),
    scanTime: gl.getUniformLocation(prog, 'scanTime')
  };
  gl.uniform1i(unis.real, 0);
  const textures = [gl.createTexture(), gl.createTexture(), gl.createTexture()];

  const tCanvas = document.createElement('canvas');
  const tCtx = tCanvas.getContext('2d');
  tCanvas.width = 1280; tCanvas.height = 720;

  function clearTexture(slot) {
    tCtx.fillStyle = '#fff';
    tCtx.fillRect(0, 0, 1280, 720);
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, textures[slot]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  textures.forEach((_, slot) => clearTexture(slot));

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && i > 0) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  function updateTexture(slot, text, options) {
    tCtx.fillStyle = '#fff'; tCtx.fillRect(0, 0, 1280, 720);
    tCtx.fillStyle = '#020617';
    tCtx.strokeStyle = 'rgba(255,255,255,0.92)';
    tCtx.lineWidth = 7;
    tCtx.font = '900 58px Inter, Arial, sans-serif';
    tCtx.textAlign = 'center';
    tCtx.textBaseline = 'middle';
    
    const lines = wrapText(tCtx, text, 1080);
    const lineHeight = 76;
    const totalBlockHeight = lines.length * lineHeight;
    const startY = (720 - totalBlockHeight) / 2 - (options ? 82 : 0);
    
    lines.forEach((line, i) => {
      const y = startY + i * lineHeight;
      tCtx.strokeText(line, 640, y);
      tCtx.fillText(line, 640, y);
    });

    if (options && options.length > 0) {
      tCtx.font = '800 38px Inter, Arial, sans-serif';
      tCtx.fillStyle = '#1e293b';
      tCtx.strokeStyle = 'rgba(255,255,255,0.86)';
      tCtx.lineWidth = 5;
      const optionLineHeight = 54;
      const optionsStartY = 475;
      options.forEach((opt, idx) => {
        const label = `${String.fromCharCode(65 + idx)}. ${opt}`;
        const y = optionsStartY + idx * optionLineHeight;
        tCtx.strokeText(label, 640, y);
        tCtx.fillText(label, 640, y);
      });
    }

    drawPrivacyWeave();

    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, textures[slot]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  async function decryptPayload(encrypted, hexKey) {
    try {
      const keyBytes = new Uint8Array(hexKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const key = await window.crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );
      const nonceBytes = Uint8Array.from(atob(encrypted.nonce), c => c.charCodeAt(0));
      const ciphertextBytes = Uint8Array.from(atob(encrypted.ciphertext), c => c.charCodeAt(0));
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceBytes },
        key,
        ciphertextBytes
      );
      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decryptedBuffer));
    } catch (e) {
      console.error("Payload decryption failed", e);
      return null;
    }
  }

  async function api(path, method = 'GET', body = null) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (body) headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, status: r.status, error: data.error || 'Request failed' };
      return data;
    } catch (e) {
      console.error("Network request failed", e);
      return { ok: false, error: 'Network error. Check that the server is running.' };
    }
  }

  function drawPrivacyWeave() {
    tCtx.save();
    tCtx.globalAlpha = 0.22;
    for (let x = 0; x < 1280; x += 8) {
      tCtx.fillStyle = x % 16 === 0 ? '#ffffff' : '#cbd5e1';
      tCtx.fillRect(x, 0, 3, 720);
    }
    tCtx.globalAlpha = 0.08;
    tCtx.fillStyle = '#0f172a';
    for (let y = 0; y < 720; y += 18) {
      tCtx.fillRect(0, y, 1280, 1);
    }
    tCtx.restore();
  }

  const lastFlagTimes = {};
  async function sendFlag(type, detail = '') {
    const now = Date.now();
    if (lastFlagTimes[type] && now - lastFlagTimes[type] < 5000) return;
    lastFlagTimes[type] = now;
    await api('/api/flag', 'POST', { type, detail });
  }

  let timerInterval;
  function startTimer(startedAtMs) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedAtMs) / 1000);
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      const timerEl = document.getElementById('sessionTimer');
      if (timerEl) timerEl.textContent = `${m}:${s}`;
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
  }

  async function loadQuestion() {
    const q = await api('/api/question');
    if (!q || q.ok === false) {
      showCandidateError(q && q.error ? q.error : 'Unable to load the next question.');
      return;
    }
    if (q.done) { stopTimer(); show('done'); return; }
    
    let questionData = q;
    if (q.encrypted && session.aesKey) {
      const decrypted = await decryptPayload(q.encrypted, session.aesKey);
      if (decrypted) {
        questionData.text = decrypted.text;
        questionData.options = decrypted.options;
      }
    }
    
    session.decoyFetched = false;
    session.blendFactors.left = 0;
    session.blendFactors.right = 0;
    clearTexture(1);
    clearTexture(2);
    UI.progress.textContent = `Question ${questionData.index + 1} of ${questionData.total}`;
    updateTexture(0, questionData.text, questionData.options);
    
    UI.answers.innerHTML = '';
    questionData.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = String.fromCharCode(65 + i);
      b.setAttribute('aria-label', `Select option ${String.fromCharCode(65 + i)}`);
      b.onclick = () => submit(questionData.id, opt);
      UI.answers.appendChild(b);
    });
    resetInactivityTimer();
  }

  async function submit(qId, val) {
    setAnswersDisabled(true);
    const res = await api('/api/answer', 'POST', { questionId: qId, answer: val });
    if (!res || res.ok === false) {
      setAnswersDisabled(false);
      showCandidateError(res && res.error ? res.error : 'Unable to submit your answer.');
      return;
    }
    loadQuestion();
  }

  function setAnswersDisabled(disabled) {
    UI.answers.querySelectorAll('button').forEach(button => {
      button.disabled = disabled;
    });
  }

  function showCandidateError(message) {
    UI.status.textContent = message;
    UI.dot.classList.remove('status-dot--good', 'status-dot--warn');
    UI.dot.classList.add('status-dot--bad');
  }

  async function fetchDecoy() {
    if (session.decoyFetched) return;
    session.decoyFetched = true;
    const d = await api('/api/decoy');
    if (!d) return;

    let decoyLeft, decoyRight;
    if (d.encrypted && session.aesKey) {
      const decrypted = await decryptPayload(d.encrypted, session.aesKey);
      if (decrypted) {
        decoyLeft = decrypted.left;
        decoyRight = decrypted.right;
      }
    } else {
      decoyLeft = d.left;
      decoyRight = d.right;
    }

    session.decoyLeftText = decoyLeft.text;
    session.decoyRightText = decoyRight.text;
    
    updateTexture(1, decoyLeft.text, decoyLeft.options);
    updateTexture(2, decoyRight.text, decoyRight.options);
  }

  let biometricLoaderRemoved = false;
  if (typeof FaceMesh !== 'function' || typeof Camera !== 'function') {
    setBiometricUnavailable('Required browser tracking scripts did not load. Check your connection and reload the page.');
    return;
  }

  const biometricTimeout = setTimeout(() => {
    if (!biometricLoaderRemoved) {
      setBiometricUnavailable('Setup took too long. Allow camera access, check your connection, then retry.');
    }
  }, 15000);

  let faceMeshFailureCount = 0;
  const fm = new FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  fm.setOptions({ maxNumFaces: 2, refineLandmarks: true, minDetectionConfidence: 0.5 });
  
  fm.onResults(res => {
    faceMeshFailureCount = 0;
    if (!biometricLoaderRemoved) {
      const loader = document.getElementById('biometric-loader');
      if (loader) loader.remove();
      biometricLoaderRemoved = true;
      clearTimeout(biometricTimeout);
    }

    const faces = res.multiFaceLandmarks || [];
    session.faceDetected = faces.length > 0;
    session.faceCount = faces.length;
    
    UI.checklist.face.classList.toggle('ok', session.faceDetected);
    UI.checklist.face.querySelector('.icon').textContent = session.faceDetected ? '✅' : '⭕';

    if (session.faceDetected) {
      const lms = faces[0];
      const leftDist  = lms[1].x - lms[234].x;
      const rightDist = lms[454].x - lms[1].x;
      const rawYaw = ((rightDist - leftDist) / (rightDist + leftDist)) * 45;
      if (!session.active || session.yawBaseline === null) {
        session.yawBaseline = rawYaw;
      }
      session.currentYaw = rawYaw - session.yawBaseline;

      const ear = lms[145].y - lms[159].y;
      if (ear < 0.012) session.lastBlinkTime = Date.now();

      UI.checklist.light.classList.add('ok');
      UI.checklist.light.querySelector('.icon').textContent = '✅';
    }

    if (session.active) {
      if (session.faceCount > 1) sendFlag('multiple_faces', `Detected ${session.faceCount} faces`);
      if (session.faceCount === 0) sendFlag('no_face');
      session.privacyForced = session.faceCount !== 1 || Math.abs(session.currentYaw) > 12;
      if (Math.abs(session.currentYaw) > 15) fetchDecoy();
    } else {
      session.privacyForced = false;
    }

    const aligned = session.faceDetected && Math.abs(session.currentYaw) <= 12;
    UI.btn.disabled = !aligned || !UI.consent.checked;
    UI.btn.textContent = !aligned ? 'Face Camera Directly' : (!UI.consent.checked ? 'Accept Consent' : 'Begin Assessment');
  });

  const cam = new Camera(UI.video, {
    onFrame: async () => {
      if (UI.preview && UI.preview.srcObject !== UI.video.srcObject) {
        UI.preview.srcObject = UI.video.srcObject;
      }
      session.frameCount++;
      if (session.frameCount % 6 === 0) {
        try {
          await fm.send({ image: UI.video });
        } catch (e) {
          console.error("Face tracking failed", e);
          faceMeshFailureCount++;
          if (faceMeshFailureCount >= 5) {
            setBiometricUnavailable('Face tracking failed to initialize. Reload the page and allow camera access.');
          }
        }
      }
    },
    width: 1280, height: 720
  });
  cam.start().then(() => {
    UI.checklist.cam.classList.add('ok');
    UI.checklist.cam.querySelector('.icon').textContent = '✅';
  }).catch(e => {
    console.error("Camera start failed", e);
    setBiometricUnavailable('Camera access is required. Allow camera permission in your browser and retry.');
  });

  setInterval(() => {
    if (session.active && Date.now() - session.lastBlinkTime > 30000) {
      sendFlag('no_blink_detected', 'Likely static photo');
    }
  }, 30000);

  function loop() {
    const yaw = session.currentYaw;
    const blendLeft = Math.max(0, Math.min(1, (Math.max(0, -yaw) - 14) / 14));
    const blendRight = Math.max(0, Math.min(1, (Math.max(0, yaw) - 14) / 14));

    session.blendFactors.left += (blendLeft - session.blendFactors.left) * 0.1;
    session.blendFactors.right += (blendRight - session.blendFactors.right) * 0.1;

    const privacyAmount = Math.max(session.blendFactors.left, session.blendFactors.right);
    const lockAmount = session.privacyForced ? 1 : 0;
    const privacyDir = session.blendFactors.right >= session.blendFactors.left ? 1 : -1;
    gl.uniform1f(unis.privacyAmount, privacyAmount);
    gl.uniform1f(unis.privacyDir, privacyDir);
    gl.uniform1f(unis.lockAmount, lockAmount);
    gl.uniform1f(unis.scanTime, performance.now() / 1000);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const answersEl = UI.answers;
    if (lockAmount > 0 || privacyAmount > 0.35) {
      answersEl.style.opacity = '0';
      answersEl.style.pointerEvents = 'none';
      UI.status.textContent = lockAmount > 0 ? 'Screen locked: face must stay centered' : 'Privacy shield active';
      UI.dot.classList.remove('status-dot--good');
      UI.dot.classList.add('status-dot--warn');
    } else if (privacyAmount < 0.15) {
      answersEl.style.opacity = '1';
      answersEl.style.pointerEvents = 'auto';
      if (session.active) {
        UI.status.textContent = 'Secure view aligned';
        UI.dot.classList.remove('status-dot--warn', 'status-dot--bad');
        UI.dot.classList.add('status-dot--good');
      }
    }

    requestAnimationFrame(loop);
  }
  loop();

  function show(id) {
    Object.values(UI.screens).forEach(s => {
      const el = document.getElementById(s);
      if (el) el.classList.remove('active');
    });
    const activeEl = document.getElementById(UI.screens[id]);
    if (activeEl) activeEl.classList.add('active');
  }

  UI.btn.onclick = async () => {
    const emailInput = document.getElementById('candidateEmail');
    const emailVal = emailInput ? emailInput.value.trim() : "";
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailVal)) {
      const emailError = document.getElementById('emailError');
      if (emailError) {
        emailError.textContent = "Please enter a valid email address.";
        emailError.style.display = "block";
      }
      return;
    }

    UI.btn.disabled = true;
    UI.btn.textContent = 'Starting...';

    const startRes = await api('/api/session/start', 'POST', { email: emailVal });
    if (!startRes || startRes.ok === false || startRes.error) {
      const emailError = document.getElementById('emailError');
      if (emailError) {
        emailError.textContent = startRes ? startRes.error : "Failed to start session";
        emailError.style.display = "block";
      }
      UI.btn.disabled = !session.faceDetected || !UI.consent.checked;
      UI.btn.textContent = 'Begin Assessment';
      return;
    }
    
    session.aesKey = startRes.key;
    session.yawBaseline = null;
    
    const consentRes = await api('/api/session/consent', 'POST');
    if (!consentRes || consentRes.ok === false) {
      const emailError = document.getElementById('emailError');
      if (emailError) {
        emailError.textContent = consentRes ? consentRes.error : "Failed to record consent";
        emailError.style.display = "block";
      }
      UI.btn.disabled = !session.faceDetected || !UI.consent.checked;
      UI.btn.textContent = 'Begin Assessment';
      return;
    }
    session.active = true;
    const startedAt = startRes.started_at ? startRes.started_at * 1000 : Date.now();
    show('test');
    loadQuestion();
    startTimer(startedAt);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session.active) sendFlag('tab_hidden');
  });

  UI.consent.onchange = () => {
    const aligned = session.faceDetected && Math.abs(session.currentYaw) <= 12;
    UI.btn.disabled = !aligned || !UI.consent.checked;
    UI.btn.textContent = !aligned ? 'Face Camera Directly' : (!UI.consent.checked ? 'Accept Consent' : 'Begin Assessment');
  };

  const finishBtn = document.getElementById('finishBtn');
  if (finishBtn) finishBtn.onclick = () => location.reload();
})();
