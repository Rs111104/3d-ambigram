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
    blendFactors: { left: 0, right: 0 },
    lastBlinkTime: Date.now(),
    decoyFetched: false,
    decoyLeftText: null,
    decoyRightText: null,
    faceDetected: false,
    faceCount: 0,
    frameCount: 0,
    aesKey: null
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

  // WebGL Check
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

  // WebGL Initialization
  const gl = UI.canvas.getContext('webgl');
  const vertSource = `attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  // I1: Directional blend fragment shader (3 textures)
  const fragSource = `
    precision highp float;
    varying vec2 v;
    uniform sampler2D realTex, decoyLeftTex, decoyRightTex;
    uniform float blendLeft, blendRight;
    void main() {
      vec4 real = texture2D(realTex, v);
      vec4 decoyLeft = texture2D(decoyLeftTex, v);
      vec4 decoyRight = texture2D(decoyRightTex, v);
      gl_FragColor = mix(mix(real, decoyLeft, blendLeft), decoyRight, blendRight);
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
    blendLeft: gl.getUniformLocation(prog, 'blendLeft'),
    blendRight: gl.getUniformLocation(prog, 'blendRight'),
    real: gl.getUniformLocation(prog, 'realTex'),
    decoyLeft: gl.getUniformLocation(prog, 'decoyLeftTex'),
    decoyRight: gl.getUniformLocation(prog, 'decoyRightTex')
  };
  gl.uniform1i(unis.real, 0); gl.uniform1i(unis.decoyLeft, 1); gl.uniform1i(unis.decoyRight, 2);
  const textures = [gl.createTexture(), gl.createTexture(), gl.createTexture()];

  const tCanvas = document.createElement('canvas');
  const tCtx = tCanvas.getContext('2d');
  tCanvas.width = 1280; tCanvas.height = 720;

  // H2 Word-wrapping helper
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
    tCtx.fillStyle = '#0f172a'; tCtx.font = 'bold 44px Inter';
    tCtx.textAlign = 'center';
    
    const lines = wrapText(tCtx, text, 1080);
    const lineHeight = 62;
    const totalBlockHeight = lines.length * lineHeight;
    const startY = (720 - totalBlockHeight) / 2 - (options ? 60 : 0);
    
    lines.forEach((line, i) => {
      tCtx.fillText(line, 640, startY + i * lineHeight);
    });

    if (options && options.length > 0) {
      tCtx.font = '500 28px Inter';
      tCtx.fillStyle = '#64748b';
      const optionLineHeight = 45;
      const optionsStartY = 480;
      options.forEach((opt, idx) => {
        const label = `${String.fromCharCode(65 + idx)}. ${opt}`;
        tCtx.fillText(label, 640, optionsStartY + idx * optionLineHeight);
      });
    }
    
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, textures[slot]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // M4 AES decryption helper using native Web Crypto API
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
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
    if (!r.ok) return null;
    return r.json();
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
    if (!q || q.done) { stopTimer(); show('done'); return; }
    
    let questionData = q;
    if (q.encrypted && session.aesKey) {
      const decrypted = await decryptPayload(q.encrypted, session.aesKey);
      if (decrypted) {
        questionData.text = decrypted.text;
        questionData.options = decrypted.options;
      }
    }
    
    session.decoyFetched = false;
    UI.progress.textContent = `Question ${questionData.index + 1} of ${questionData.total}`;
    updateTexture(0, questionData.text, questionData.options);
    
    UI.answers.innerHTML = '';
    questionData.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = opt;
      b.onclick = () => submit(questionData.id, opt);
      UI.answers.appendChild(b);
    });
    resetInactivityTimer();
  }

  async function submit(qId, val) {
    await api('/api/answer', 'POST', { questionId: qId, answer: val });
    loadQuestion();
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
  const fm = new FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}` });
  fm.setOptions({ maxNumFaces: 2, refineLandmarks: true, minDetectionConfidence: 0.5 });
  
  fm.onResults(res => {
    // I3: Remove loading overlay on first biometric results
    if (!biometricLoaderRemoved) {
      const loader = document.getElementById('biometric-loader');
      if (loader) loader.remove();
      biometricLoaderRemoved = true;
    }

    const faces = res.multiFaceLandmarks || [];
    session.faceDetected = faces.length > 0;
    session.faceCount = faces.length;
    
    UI.checklist.face.classList.toggle('ok', session.faceDetected);
    UI.checklist.face.querySelector('.icon').textContent = session.faceDetected ? '✅' : '⭕';

    if (session.faceDetected) {
      const lms = faces[0];
      // H3: Rotation-invariant multi-landmark Face Yaw calculation
      const leftDist  = lms[1].x - lms[234].x;
      const rightDist = lms[454].x - lms[1].x;
      const yaw       = ((rightDist - leftDist) / (rightDist + leftDist)) * 45;
      session.currentYaw = yaw;

      const ear = lms[145].y - lms[159].y;
      if (ear < 0.012) session.lastBlinkTime = Date.now();

      UI.checklist.light.classList.add('ok');
      UI.checklist.light.querySelector('.icon').textContent = '✅';
    }

    if (session.active) {
      if (session.faceCount > 1) sendFlag('multiple_faces', `Detected ${session.faceCount} faces`);
      if (session.faceCount === 0) sendFlag('no_face');
      if (Math.abs(session.currentYaw) > 15) fetchDecoy();
    }

    UI.btn.disabled = !session.faceDetected || !UI.consent.checked;
    UI.btn.textContent = !session.faceDetected ? 'Align Face to Start' : (!UI.consent.checked ? 'Accept Consent' : 'Begin Assessment');
  });

  const cam = new Camera(UI.video, {
    onFrame: async () => {
      if (UI.preview && UI.preview.srcObject !== UI.video.srcObject) {
        UI.preview.srcObject = UI.video.srcObject;
      }
      session.frameCount++;
      if (session.frameCount % 6 === 0) await fm.send({ image: UI.video });
    },
    width: 1280, height: 720
  });
  cam.start().then(() => {
    UI.checklist.cam.classList.add('ok');
    UI.checklist.cam.querySelector('.icon').textContent = '✅';
  });

  setInterval(() => {
    if (session.active && Date.now() - session.lastBlinkTime > 30000) {
      sendFlag('no_blink_detected', 'Likely static photo');
    }
  }, 30000);

  function loop() {
    // I1: WebGL blend left vs right based on sign of yaw
    const yaw = session.currentYaw;
    const blendLeft = Math.max(0, Math.min(1, (Math.max(0, -yaw) - 10) / 20));
    const blendRight = Math.max(0, Math.min(1, (Math.max(0, yaw) - 10) / 20));
    
    session.blendFactors.left += (blendLeft - session.blendFactors.left) * 0.1;
    session.blendFactors.right += (blendRight - session.blendFactors.right) * 0.1;
    
    gl.uniform1f(unis.blendLeft, session.blendFactors.left);
    gl.uniform1f(unis.blendRight, session.blendFactors.right);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    
    // I4: Smooth opacity fade of answer buttons when decoy starts blending
    const answersEl = UI.answers;
    const maxBlend = Math.max(session.blendFactors.left, session.blendFactors.right);
    if (maxBlend > 0.4) {
      answersEl.style.opacity = '0';
      answersEl.style.pointerEvents = 'none';
    } else if (maxBlend < 0.2) {
      answersEl.style.opacity = '1';
      answersEl.style.pointerEvents = 'auto';
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

    const startRes = await api('/api/session/start', 'POST', { email: emailVal });
    if (!startRes || startRes.error) {
      const emailError = document.getElementById('emailError');
      if (emailError) {
        emailError.textContent = startRes ? startRes.error : "Failed to start session";
        emailError.style.display = "block";
      }
      return;
    }
    
    session.aesKey = startRes.key;
    
    await api('/api/session/consent', 'POST');
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
    UI.btn.disabled = !session.faceDetected || !UI.consent.checked;
    UI.btn.textContent = !session.faceDetected ? 'Align Face to Start' : (!UI.consent.checked ? 'Accept Consent' : 'Begin Assessment');
  };

  const finishBtn = document.getElementById('finishBtn');
  if (finishBtn) finishBtn.onclick = () => location.reload();
})();
