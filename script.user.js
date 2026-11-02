// ==UserScript==
// @name         Vocabulary.com Gemini & OpenRouter AI Solver
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  Solves Vocabulary.com (Practice, Trainer, and Vocab Jam) using Gemini or OpenRouter models with a live model search tool, auto-removes blockers, and caches answers.
// @author       apple-bonkers
// @match        *://*.vocabulary.com/*
// @icon         https://www.vocabulary.com/favicon.ico
// @grant        none
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/apple-bonkers/randomstuff/refs/heads/main/script.user.js
// @updateURL    https://raw.githubusercontent.com/apple-bonkers/randomstuff/refs/heads/main/script.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 1. STATE & STORAGE MANAGEMENT
    // ==========================================
    const STORAGE_KEYS = {
        PROVIDER: 'vcom_ai_provider', // 'gemini' | 'openrouter'
        API_KEY: 'vcom_ai_api_key',
        MODEL: 'vcom_ai_model',
        OR_MODEL: 'vcom_or_custom_model',
        MODE: 'vcom_ai_mode', // 'highlight' | 'auto'
        CACHE: 'vcom_ai_cache'
    };

    const GEMINI_MODELS = [
        { id: 'gemini-flash-lite-latest', label: 'gemini-flash-lite-latest (Fastest Alias)' },
        { id: 'gemini-flash-latest', label: 'gemini-flash-latest (Balanced Alias)' },
        { id: 'gemini-pro-latest', label: 'gemini-pro-latest (Pro Alias)' },
        { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (Pinned 3.1 Lite)' },
        { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (Pinned 3.5 Lite)' },
        { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Pinned 3.8 Flash)' },
        { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (Pinned 3.1 Pro)' }
    ];

    let config = {
        provider: localStorage.getItem(STORAGE_KEYS.PROVIDER) || 'gemini',
        apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
        model: localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-flash-lite-latest',
        orModel: localStorage.getItem(STORAGE_KEYS.OR_MODEL) || 'google/gemini-flash-1.5',
        mode: localStorage.getItem(STORAGE_KEYS.MODE) || 'highlight',
        cache: JSON.parse(localStorage.getItem(STORAGE_KEYS.CACHE) || '{}')
    };

    let lastSolvedSignature = '';
    let isProcessing = false;
    let debugLogs = [];

    function logDebug(msg, obj = null) {
        const timestamp = new Date().toLocaleTimeString();
        const line = `[${timestamp}] ${msg}` + (obj ? ` | ${JSON.stringify(obj)}` : '');
        debugLogs.push(line);
        if (debugLogs.length > 50) debugLogs.shift();
        console.log(`[VCOM-AI] ${msg}`, obj || '');
    }

    function saveCache(hash, answerText) {
        config.cache[hash] = answerText;
        localStorage.setItem(STORAGE_KEYS.CACHE, JSON.stringify(config.cache));
        updateCacheCountUI();
    }

    function generateCacheKey(promptText, choicesArray) {
        const raw = `${promptText.trim()}|||${choicesArray.map(c => c.trim()).sort().join('|')}`;
        return raw.toLowerCase().replace(/\s+/g, ' ');
    }

    // ==========================================
    // 2. AUTO-REMOVE BLOCKER
    // ==========================================
    function removeBlocker() {
        const blocker = document.querySelector('.blocker');
        if (blocker) {
            blocker.remove();
            logDebug('Blocker element removed.');
        }
    }

    // ==========================================
    // 3. FLOATING CONFIGURATION UI & MODEL SEARCH
    // ==========================================
    function injectUI() {
        if (document.getElementById('vcom-ai-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            #vcom-ai-toggle {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 999999;
                background: #1e293b;
                color: #38bdf8;
                border: 2px solid #38bdf8;
                border-radius: 50%;
                width: 44px;
                height: 44px;
                font-size: 20px;
                cursor: pointer;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.2s;
            }
            #vcom-ai-toggle:hover { transform: scale(1.08); }
            #vcom-ai-panel {
                position: fixed;
                bottom: 75px;
                right: 20px;
                z-index: 999999;
                width: 330px;
                background: #0f172a;
                color: #f8fafc;
                border: 1px solid #334155;
                border-radius: 12px;
                padding: 16px;
                font-family: system-ui, -apple-system, sans-serif;
                font-size: 13px;
                box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                display: none;
            }
            #vcom-ai-panel.open { display: block; }
            .vcom-ai-header {
                font-weight: 700;
                font-size: 15px;
                margin-bottom: 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                color: #38bdf8;
                border-bottom: 1px solid #1e293b;
                padding-bottom: 8px;
            }
            .vcom-ai-field { margin-bottom: 10px; }
            .vcom-ai-field label {
                display: block;
                margin-bottom: 4px;
                color: #94a3b8;
                font-weight: 500;
            }
            .vcom-ai-input, .vcom-ai-select {
                width: 100%;
                padding: 7px;
                background: #1e293b;
                border: 1px solid #475569;
                color: #fff;
                border-radius: 6px;
                box-sizing: border-box;
                font-size: 12px;
            }
            .vcom-ai-row { display: flex; gap: 6px; align-items: center; }
            .vcom-ai-status {
                margin-top: 8px;
                padding: 6px 8px;
                border-radius: 6px;
                background: #1e293b;
                color: #cbd5e1;
                font-size: 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 6px;
            }
            .vcom-ai-btn {
                background: #ef4444;
                color: white;
                border: none;
                padding: 5px 8px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
            }
            .vcom-ai-btn.secondary {
                background: #334155;
                color: #38bdf8;
            }
            .vcom-ai-btn:hover { opacity: 0.9; }
            #vcom-model-search-modal {
                position: fixed;
                top: 50%; left: 50%; transform: translate(-50%, -50%);
                z-index: 1000000;
                width: 400px; max-height: 80vh;
                background: #0f172a; border: 2px solid #38bdf8; border-radius: 12px;
                padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);
                display: none; flex-direction: column; color: #fff;
            }
            #vcom-model-search-modal.open { display: flex; }
            #vcom-model-list { overflow-y: auto; max-height: 300px; margin-top: 8px; border: 1px solid #334155; border-radius: 6px; }
            .vcom-model-item { padding: 8px; border-bottom: 1px solid #1e293b; cursor: pointer; font-size: 12px; }
            .vcom-model-item:hover { background: #1e293b; color: #38bdf8; }
        `;
        document.head.appendChild(style);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'vcom-ai-toggle';
        toggleBtn.title = 'Toggle Solver Settings (Alt + G)';
        toggleBtn.innerText = '🧠';

        const panel = document.createElement('div');
        panel.id = 'vcom-ai-panel';
        panel.classList.add('open');

        function renderPanelBody() {
            const isGemini = config.provider === 'gemini';
            const modelOptions = isGemini
                ? GEMINI_MODELS.map(m => `<option value="${m.id}" ${config.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')
                : `<option value="${config.orModel}" selected>${config.orModel}</option>`;

            panel.innerHTML = `
                <div class="vcom-ai-header">
                    <span>AI Vocab Solver v1.6</span>
                    <span style="font-size: 11px; color: #64748b;">Alt+G</span>
                </div>
                <div class="vcom-ai-field">
                    <label for="vcom-provider">Provider</label>
                    <select id="vcom-provider" class="vcom-ai-select">
                        <option value="gemini" ${isGemini ? 'selected' : ''}>Google Gemini API</option>
                        <option value="openrouter" ${!isGemini ? 'selected' : ''}>OpenRouter</option>
                    </select>
                </div>
                <div class="vcom-ai-field">
                    <label for="vcom-api-key">${isGemini ? 'Gemini API Key' : 'OpenRouter API Key'}</label>
                    <input type="password" id="vcom-api-key" class="vcom-ai-input" placeholder="${isGemini ? 'AIzaSy...' : 'sk-or-v1-...'}" value="${config.apiKey}">
                </div>
                <div class="vcom-ai-field">
                    <label for="vcom-model">Model</label>
                    <div class="vcom-ai-row">
                        <select id="vcom-model" class="vcom-ai-select">
                            ${modelOptions}
                        </select>
                        ${!isGemini ? '<button id="vcom-search-models-btn" class="vcom-ai-btn secondary" style="white-space:nowrap;">Search</button>' : ''}
                    </div>
                </div>
                <div class="vcom-ai-field">
                    <label for="vcom-mode">Operating Mode</label>
                    <select id="vcom-mode" class="vcom-ai-select">
                        <option value="highlight" ${config.mode === 'highlight' ? 'selected' : ''}>Highlight Only</option>
                        <option value="auto" ${config.mode === 'auto' ? 'selected' : ''}>Auto-Answer</option>
                    </select>
                </div>
                <div class="vcom-ai-status">
                    <span id="vcom-cache-count">Cached: ${Object.keys(config.cache).length}</span>
                    <div>
                        <button id="vcom-copy-debug" class="vcom-ai-btn secondary" title="Copy logs & DOM">Logs</button>
                        <button id="vcom-clear-cache" class="vcom-ai-btn">Clear Cache</button>
                    </div>
                </div>
                <div id="vcom-ai-log" style="margin-top:8px; color:#38bdf8; font-size:11px; min-height:16px; word-break:break-word;">Ready.</div>
            `;
            attachPanelListeners();
        }

        const modal = document.createElement('div');
        modal.id = 'vcom-model-search-modal';
        modal.innerHTML = `
            <div style="font-weight:700; font-size:14px; margin-bottom:8px; color:#38bdf8;">Search OpenRouter Models</div>
            <input type="text" id="vcom-model-filter" class="vcom-ai-input" placeholder="Type to filter (e.g., deepseek, claude, free)...">
            <div id="vcom-model-list"></div>
            <button id="vcom-close-modal" class="vcom-ai-btn secondary" style="margin-top:10px; width:100%;">Close</button>
        `;

        document.body.appendChild(toggleBtn);
        document.body.appendChild(panel);
        document.body.appendChild(modal);

        function attachPanelListeners() {
            document.getElementById('vcom-provider').addEventListener('change', (e) => {
                config.provider = e.target.value;
                localStorage.setItem(STORAGE_KEYS.PROVIDER, config.provider);
                renderPanelBody();
                lastSolvedSignature = '';
                checkAndSolve();
            });

            document.getElementById('vcom-api-key').addEventListener('input', (e) => {
                config.apiKey = e.target.value.trim();
                localStorage.setItem(STORAGE_KEYS.API_KEY, config.apiKey);
                setStatus('API Key saved.');
                lastSolvedSignature = '';
                checkAndSolve();
            });

            document.getElementById('vcom-model').addEventListener('change', (e) => {
                const val = e.target.value;
                if (config.provider === 'gemini') {
                    config.model = val;
                    localStorage.setItem(STORAGE_KEYS.MODEL, config.model);
                } else {
                    config.orModel = val;
                    localStorage.setItem(STORAGE_KEYS.OR_MODEL, config.orModel);
                }
                setStatus(`Model: ${val}`);
                lastSolvedSignature = '';
                checkAndSolve();
            });

            const searchBtn = document.getElementById('vcom-search-models-btn');
            if (searchBtn) {
                searchBtn.addEventListener('click', async () => {
                    modal.classList.add('open');
                    const listEl = document.getElementById('vcom-model-list');
                    listEl.innerHTML = '<div style="padding:10px; color:#94a3b8;">Loading OpenRouter models...</div>';
                    try {
                        const res = await fetch('https://openrouter.ai/api/v1/models');
                        const data = await res.json();
                        window._orModelsCache = data.data || [];
                        renderModelList(window._orModelsCache);
                    } catch (err) {
                        listEl.innerHTML = `<div style="padding:10px; color:#ef4444;">Failed to load models: ${err.message}</div>`;
                    }
                });
            }

            document.getElementById('vcom-mode').addEventListener('change', (e) => {
                config.mode = e.target.value;
                localStorage.setItem(STORAGE_KEYS.MODE, config.mode);
                setStatus(`Mode: ${config.mode}`);
                lastSolvedSignature = '';
                checkAndSolve();
            });

            document.getElementById('vcom-clear-cache').addEventListener('click', () => {
                config.cache = {};
                localStorage.removeItem(STORAGE_KEYS.CACHE);
                updateCacheCountUI();
                setStatus('Cache cleared.');
            });

            document.getElementById('vcom-copy-debug').addEventListener('click', () => {
                const activeQ = findActiveQuestionBox();
                const domSnapshot = activeQ ? activeQ.outerHTML.slice(0, 1500) : 'No active question found';
                const payload = `=== VCOM DEBUG LOGS ===\nURL: ${location.href}\n${debugLogs.join('\n')}\n\n=== DOM ===\n${domSnapshot}`;
                navigator.clipboard.writeText(payload).then(() => setStatus('📋 Logs copied to clipboard!'));
            });
        }

        document.getElementById('vcom-close-modal').addEventListener('click', () => modal.classList.remove('open'));
        document.getElementById('vcom-model-filter').addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const filtered = (window._orModelsCache || []).filter(m => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query));
            renderModelList(filtered);
        });

        function renderModelList(models) {
            const listEl = document.getElementById('vcom-model-list');
            listEl.innerHTML = models.map(m => `
                <div class="vcom-model-item" data-id="${m.id}">
                    <b>${m.name}</b> <span style="color:#64748b; font-size:10px;">(${m.id})</span>
                </div>
            `).join('');

            listEl.querySelectorAll('.vcom-model-item').forEach(el => {
                el.addEventListener('click', () => {
                    const chosenId = el.getAttribute('data-id');
                    config.orModel = chosenId;
                    localStorage.setItem(STORAGE_KEYS.OR_MODEL, chosenId);
                    modal.classList.remove('open');
                    renderPanelBody();
                    setStatus(`Selected: ${chosenId}`);
                });
            });
        }

        renderPanelBody();

        toggleBtn.addEventListener('click', () => panel.classList.toggle('open'));
        document.addEventListener('keydown', (e) => {
            if (e.altKey && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                panel.classList.toggle('open');
            }
        });
    }

    function setStatus(msg) {
        logDebug(msg);
        const el = document.getElementById('vcom-ai-log');
        if (el) el.innerText = msg;
    }

    function updateCacheCountUI() {
        const el = document.getElementById('vcom-cache-count');
        if (el) el.innerText = `Cached: ${Object.keys(config.cache).length}`;
    }

    // ==========================================
    // 4. DOM & QUESTION DETECTION (Supports Jam, Trainer, Practice)
    // ==========================================
    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findActiveQuestionBox() {
        // Expanded selectors to catch Jam, Trainer, and Practice layouts
        const selectors = '.question, div[class*="question"], div[class*="jam"], .challenge, .prompt';
        const questions = Array.from(document.querySelectorAll(selectors));
        for (let i = questions.length - 1; i >= 0; i--) {
            const q = questions[i];
            if (isVisible(q) && (q.querySelector('.choices') || q.querySelector('.spelltheword') || q.querySelector('input[type="text"]') || q.querySelectorAll('button, a[href="#"]').length >= 2)) {
                return q;
            }
        }
        const choicesList = Array.from(document.querySelectorAll('.choices, ul[class*="choice"], div[class*="option"]'));
        for (let i = choicesList.length - 1; i >= 0; i--) {
            if (isVisible(choicesList[i]) && choicesList[i].parentElement) {
                return choicesList[i].parentElement;
            }
        }
        return null;
    }

    function getCleanChoiceText(el) {
        return el.innerText.replace(/ 🧠$/g, '').trim();
    }

    function applyReferenceHighlight(choiceElement) {
        if (!choiceElement) return;
        choiceElement.style.color = "springgreen";
        choiceElement.style.setProperty('color', 'springgreen', 'important');
        if (!choiceElement.innerText.includes("🧠")) {
            choiceElement.innerText += " 🧠";
        }
    }

    // ==========================================
    // 5. UNIFIED API CALL (GEMINI OR OPENROUTER)
    // ==========================================
    async function callAI(systemPrompt, userPrompt) {
        if (!config.apiKey) {
            setStatus('⚠️ Missing API Key!');
            return null;
        }

        let endpoint, headers, body;

        if (config.provider === 'gemini') {
            endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
            headers = { 'Content-Type': 'application/json' };
            body = JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: userPrompt }] }],
                generationConfig: { temperature: 0.0, maxOutputTokens: 60 }
            });
        } else {
            endpoint = 'https://openrouter.ai/api/v1/chat/completions';
            headers = {
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://vocabulary.com',
                'X-Title': 'Vocab AI Solver'
            };
            body = JSON.stringify({
                model: config.orModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.0,
                max_tokens: 60
            });
        }

        const res = await fetch(endpoint, { method: 'POST', headers, body });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            logDebug(`HTTP ${res.status}`, errText.slice(0, 200));
            throw new Error(`API Error ${res.status}`);
        }

        const data = await res.json();
        if (config.provider === 'gemini') {
            return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        } else {
            return data?.choices?.[0]?.message?.content?.trim() || '';
        }
    }

    async function askAIMultipleChoice(promptText, choicesTextArray) {
        const formattedChoices = choicesTextArray.map(c => `- ${c}`).join('\n');
        const systemInstruction = "You are a precise Vocabulary.com question solver. Analyze the question prompt and choices. Respond with ONLY the exact text of the correct option from the list. Do not include bullet points, numbers, or quotes.";
        const userPrompt = `Question:\n${promptText}\n\nOptions:\n${formattedChoices}`;

        const rawReply = await callAI(systemInstruction, userPrompt);
        logDebug('AI raw reply', rawReply);

        const matched = choicesTextArray.find(c => {
            const cleanC = c.toLowerCase().trim();
            const cleanR = rawReply.toLowerCase().trim();
            return cleanC === cleanR || cleanC.includes(cleanR) || cleanR.includes(cleanC);
        });

        return matched || rawReply;
    }

    async function askAISpelling(promptContext) {
        const systemInstruction = "You are a Vocabulary.com spelling solver. Given the definition or sentence context, return ONLY the exact single vocabulary word being asked to spell. No punctuation, quotes, or explanation.";
        const rawReply = await callAI(systemInstruction, promptContext);
        return rawReply ? rawReply.replace(/[^a-zA-Z-]/g, '') : null;
    }

    // ==========================================
    // 6. QUESTION SOLVING PIPELINE
    // ==========================================
    function triggerHumanDelay(callback) {
        const delay = Math.floor(Math.random() * 301) + 400;
        setTimeout(callback, delay);
    }

    function checkNextButton() {
        if (config.mode !== 'auto') return;

        const candidates = Array.from(document.querySelectorAll('.next.active, button.next, a.next, button'));
        const nxtBtn = candidates.find(el => {
            if (!isVisible(el)) return false;
            const txt = el.innerText.trim().toLowerCase();
            return el.classList.contains('active') || txt.includes('try the next one') || txt === 'next' || txt.includes('next question') || txt.includes('continue');
        });

        if (nxtBtn && !nxtBtn.dataset.autoClicked) {
            nxtBtn.dataset.autoClicked = "true";
            triggerHumanDelay(() => {
                nxtBtn.click();
                setTimeout(() => { delete nxtBtn.dataset.autoClicked; }, 1200);
            });
        }
    }

    async function handleMultipleChoice(questBox, choicesContainer) {
        const choiceElements = Array.from(choicesContainer.children).filter(el => el.innerText.trim().length > 0);
        if (choiceElements.length === 0) return;

        if (choiceElements.some(el => el.classList.contains('correct')) && isVisible(document.querySelector('.blasé, .review, .next.active'))) {
            return;
        }

        const choicesText = choiceElements.map(getCleanChoiceText);
        const clone = questBox.cloneNode(true);
        const cloneChoices = clone.querySelector('.choices') || clone.querySelector('ul[class*="choice"]');
        if (cloneChoices) cloneChoices.remove();
        const fullPrompt = clone.innerText.trim();

        if (!fullPrompt) return;

        const cacheKey = generateCacheKey(fullPrompt, choicesText);
        if (cacheKey === lastSolvedSignature) return;
        lastSolvedSignature = cacheKey;

        let winningAnswerText = config.cache[cacheKey];

        if (winningAnswerText) {
            setStatus('⚡ Solved from local cache');
        } else {
            const activeModelName = config.provider === 'gemini' ? config.model : config.orModel;
            setStatus(`🤖 Asking ${activeModelName}...`);
            try {
                winningAnswerText = await askAIMultipleChoice(fullPrompt, choicesText);
                if (winningAnswerText) {
                    saveCache(cacheKey, winningAnswerText);
                    setStatus(`✅ Answer found`);
                }
            } catch (err) {
                console.error('[VCOM-AI]', err);
                setStatus(`❌ ${err.message}`);
                return;
            }
        }

        if (!winningAnswerText) {
            setStatus('⚠️ Could not determine answer');
            return;
        }

        const targetElement = choiceElements.find(el => {
            const clean = getCleanChoiceText(el).toLowerCase();
            const target = winningAnswerText.trim().toLowerCase();
            return clean === target || clean.includes(target) || target.includes(clean);
        });

        if (targetElement) {
            applyReferenceHighlight(targetElement);

            if (config.mode === 'auto') {
                triggerHumanDelay(() => {
                    targetElement.click();
                });
            }
        }

        choiceElements.forEach(el => {
            if (el.dataset.listenerAttached) return;
            el.dataset.listenerAttached = 'true';
            el.addEventListener('click', () => {
                setTimeout(() => {
                    for (const c of choiceElements) {
                        if (c.classList.contains('correct')) {
                            saveCache(cacheKey, getCleanChoiceText(c));
                        }
                    }
                }, 400);
            });
        });
    }

    async function handleSpelling(questBox) {
        const inp = questBox.querySelector('input[type="text"]') || questBox.querySelector('.spelltheword input');
        const submit = questBox.querySelector('.submit, button[type="submit"]');
        const label = questBox.querySelector('.spelltheword, label');
        if (!inp) return;

        const contextText = questBox.innerText.trim();
        const cacheKey = `spell|||${contextText.toLowerCase().replace(/\s+/g, ' ')}`;
        if (cacheKey === lastSolvedSignature) return;
        lastSolvedSignature = cacheKey;

        let wordAnswer = config.cache[cacheKey];

        if (!wordAnswer) {
            const activeModelName = config.provider === 'gemini' ? config.model : config.orModel;
            setStatus(`🤖 Spelling via ${activeModelName}...`);
            try {
                wordAnswer = await askAISpelling(contextText);
                if (wordAnswer) saveCache(cacheKey, wordAnswer);
            } catch (err) {
                setStatus(`❌ ${err.message}`);
                return;
            }
        } else {
            setStatus('⚡ Spelling loaded from cache');
        }

        if (wordAnswer) {
            if (label) {
                label.style.color = "springgreen";
                label.innerText = `Answer: ${wordAnswer} 🧠`;
            }
            setStatus(`✅ Spell: ${wordAnswer}`);

            if (config.mode === 'auto') {
                triggerHumanDelay(() => {
                    inp.value = wordAnswer;
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.blur();
                    if (submit) {
                        setTimeout(() => submit.click(), 350);
                    }
                });
            }
        }
    }

    // ==========================================
    // 7. MUTATION OBSERVER & POLLING
    // ==========================================
    async function checkAndSolve() {
        removeBlocker();
        checkNextButton();
        if (isProcessing) return;

        const questBox = findActiveQuestionBox();
        if (!questBox) return;

        const choicesContainer = questBox.querySelector('.choices') || questBox.querySelector('ul[class*="choice"]');
        const spellInput = questBox.querySelector('.spelltheword, input[type="text"]');

        isProcessing = true;
        try {
            if (choicesContainer && choicesContainer.children.length > 0) {
                await handleMultipleChoice(questBox, choicesContainer);
            } else if (spellInput) {
                await handleSpelling(questBox);
            }
        } finally {
            isProcessing = false;
        }
    }

    function startObserver() {
        injectUI();
        logDebug('Solver initialized on ' + location.pathname);

        const observer = new MutationObserver(() => {
            removeBlocker();
            checkAndSolve();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });

        setInterval(checkAndSolve, 500);
        checkAndSolve();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
})();
