// ==UserScript==
// @name         Vocabulary.com Gemini & OpenRouter AI Solver
// @namespace    http://tampermonkey.net/
// @version      2.2.2
// @description  Solves Vocabulary.com with instant Exa search strictly for spelling questions, pure LLM memory for multiple choice, and anti-lockout pacing.
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
        PROVIDER: 'vcom_ai_provider',
        API_KEY: 'vcom_ai_api_key',
        MODEL: 'vcom_ai_model',
        OR_MODEL: 'vcom_or_custom_model',
        MODE: 'vcom_ai_mode',         // 'highlight' | 'auto'
        SPEED: 'vcom_ai_speed',       // 'safe' | 'fast' | 'instant'
        SPELL_SEARCH: 'vcom_spell_search', // 'true' | 'false'
        CACHE: 'vcom_ai_cache'
    };

    const GEMINI_MODELS = [
        { id: 'gemini-flash-latest', label: 'gemini-flash-latest (Recommended: High Accuracy)' },
        { id: 'gemini-flash-lite-latest', label: 'gemini-flash-lite-latest (Fastest Alias)' },
        { id: 'gemini-pro-latest', label: 'gemini-pro-latest (Pro Alias)' },
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash (Pinned 2.5 Flash)' },
        { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (Pinned 3.1 Lite)' },
        { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (Pinned 3.5 Lite)' },
        { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Pinned 3.8 Flash)' }
    ];

    let config = {
        provider: localStorage.getItem(STORAGE_KEYS.PROVIDER) || 'gemini',
        apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
        model: localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-flash-latest',
        orModel: localStorage.getItem(STORAGE_KEYS.OR_MODEL) || 'deepseek/deepseek-chat',
        mode: localStorage.getItem(STORAGE_KEYS.MODE) || 'auto',
        speed: localStorage.getItem(STORAGE_KEYS.SPEED) || 'safe',
        spellSearch: localStorage.getItem(STORAGE_KEYS.SPELL_SEARCH) !== 'false', // Exa Instant for spelling only
        cache: JSON.parse(localStorage.getItem(STORAGE_KEYS.CACHE) || '{}')
    };

    let lastSolvedSignature = '';
    let isProcessing = false;
    let debugLogs = [];

    function logDebug(msg, obj = null) {
        const timestamp = new Date().toLocaleTimeString();
        const line = `[${timestamp}] ${msg}` + (obj ? ` | ${JSON.stringify(obj)}` : '');
        debugLogs.push(line);
        if (debugLogs.length > 60) debugLogs.shift();
        console.log(`[VCOM-AI] ${msg}`, obj || '');
    }

    function saveCache(hash, answerText) {
        if (!hash || !answerText) return;
        config.cache[hash] = answerText.trim();
        localStorage.setItem(STORAGE_KEYS.CACHE, JSON.stringify(config.cache));
        updateCacheCountUI();
    }

    function generateCacheKey(promptText, choicesArray) {
        const raw = `${promptText.trim()}|||${choicesArray.map(c => c.trim()).sort().join('|')}`;
        return raw.toLowerCase().replace(/\s+/g, ' ');
    }

    // ==========================================
    // 2. BLOCKER & LOCKOUT MANAGEMENT
    // ==========================================
    function checkBlockersAndLockout() {
        const legacyBlockers = document.querySelectorAll('.blocker');
        legacyBlockers.forEach(b => b.remove());

        const lockout = document.querySelector('.lockout-background, div[class*="lockout"]');
        if (lockout) {
            const timeElem = lockout.querySelector('.lockout-continue-text b, b');
            const remaining = timeElem ? timeElem.innerText.trim() : 'a few minutes';
            setStatus(`⏸️ Cooldown Active: Pausing (${remaining}) to prevent flag.`);
            return true;
        }
        return false;
    }

    // ==========================================
    // 3. FLOATING CONFIGURATION UI
    // ==========================================
    function injectUI() {
        if (document.getElementById('vcom-ai-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
            #vcom-ai-toggle {
                position: fixed; bottom: 20px; right: 20px; z-index: 999999;
                background: #1e293b; color: #38bdf8; border: 2px solid #38bdf8;
                border-radius: 50%; width: 44px; height: 44px; font-size: 20px;
                cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                display: flex; align-items: center; justify-content: center; transition: transform 0.2s;
            }
            #vcom-ai-toggle:hover { transform: scale(1.08); }
            #vcom-ai-panel {
                position: fixed; bottom: 75px; right: 20px; z-index: 999999;
                width: 330px; background: #0f172a; color: #f8fafc; border: 1px solid #334155;
                border-radius: 12px; padding: 16px; font-family: system-ui, -apple-system, sans-serif;
                font-size: 13px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); display: none;
            }
            #vcom-ai-panel.open { display: block; }
            .vcom-ai-header {
                font-weight: 700; font-size: 15px; margin-bottom: 12px;
                display: flex; justify-content: space-between; align-items: center;
                color: #38bdf8; border-bottom: 1px solid #1e293b; padding-bottom: 8px;
            }
            .vcom-ai-field { margin-bottom: 10px; }
            .vcom-ai-field label { display: block; margin-bottom: 4px; color: #94a3b8; font-weight: 500; font-size: 11px; }
            .vcom-ai-input, .vcom-ai-select {
                width: 100%; padding: 7px; background: #1e293b; border: 1px solid #475569;
                color: #fff; border-radius: 6px; box-sizing: border-box; font-size: 12px;
            }
            .vcom-ai-row { display: flex; gap: 6px; align-items: center; }
            .vcom-ai-status {
                margin-top: 8px; padding: 6px 8px; border-radius: 6px; background: #1e293b;
                color: #cbd5e1; font-size: 12px; display: flex; justify-content: space-between; align-items: center; gap: 6px;
            }
            .vcom-ai-btn { background: #ef4444; color: white; border: none; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
            .vcom-ai-btn.secondary { background: #334155; color: #38bdf8; }
            .vcom-ai-btn:hover { opacity: 0.9; }
            #vcom-model-search-modal {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                z-index: 1000000; width: 400px; max-height: 80vh; background: #0f172a;
                border: 2px solid #38bdf8; border-radius: 12px; padding: 16px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.8); display: none; flex-direction: column; color: #fff;
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
                    <span>AI Vocab Solver v2.2.2</span>
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
                    <label for="vcom-spell-search">Exa Instant Search (Spelling Questions Only)</label>
                    <select id="vcom-spell-search" class="vcom-ai-select">
                        <option value="true" ${config.spellSearch ? 'selected' : ''}>Enabled (Exa ~250ms / Google Grounding)</option>
                        <option value="false" ${!config.spellSearch ? 'selected' : ''}>Disabled (Fast Pure Model Memory)</option>
                    </select>
                </div>
                <div class="vcom-ai-row" style="margin-bottom: 10px;">
                    <div style="flex:1;">
                        <label for="vcom-mode" style="display:block; margin-bottom:4px; color:#94a3b8; font-size:11px;">Mode</label>
                        <select id="vcom-mode" class="vcom-ai-select">
                            <option value="highlight" ${config.mode === 'highlight' ? 'selected' : ''}>Highlight</option>
                            <option value="auto" ${config.mode === 'auto' ? 'selected' : ''}>Auto-Answer</option>
                        </select>
                    </div>
                    <div style="flex:1;">
                        <label for="vcom-speed" style="display:block; margin-bottom:4px; color:#94a3b8; font-size:11px;">Pacing</label>
                        <select id="vcom-speed" class="vcom-ai-select">
                            <option value="safe" ${config.speed === 'safe' ? 'selected' : ''}>Safe (3-5s)</option>
                            <option value="fast" ${config.speed === 'fast' ? 'selected' : ''}>Fast (1.5-2.5s)</option>
                            <option value="instant" ${config.speed === 'instant' ? 'selected' : ''}>Instant (0.8s)</option>
                        </select>
                    </div>
                </div>
                <div class="vcom-ai-status">
                    <span id="vcom-cache-count">Cached: ${Object.keys(config.cache).length}</span>
                    <div>
                        <button id="vcom-copy-debug" class="vcom-ai-btn secondary">Logs</button>
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
            <input type="text" id="vcom-model-filter" class="vcom-ai-input" placeholder="Type to filter (e.g. deepseek, llama, gemini)...">
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

            document.getElementById('vcom-spell-search').addEventListener('change', (e) => {
                config.spellSearch = e.target.value === 'true';
                localStorage.setItem(STORAGE_KEYS.SPELL_SEARCH, config.spellSearch ? 'true' : 'false');
                setStatus(`Spelling Search: ${config.spellSearch ? 'Exa Instant' : 'Off'}`);
                lastSolvedSignature = '';
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

            document.getElementById('vcom-speed').addEventListener('change', (e) => {
                config.speed = e.target.value;
                localStorage.setItem(STORAGE_KEYS.SPEED, config.speed);
                setStatus(`Pacing: ${config.speed}`);
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
                    lastSolvedSignature = '';
                    checkAndSolve();
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
    // 4. DOM & CLEAN TEXT EXTRACTION
    // ==========================================
    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function findActiveQuestionBox() {
        const selectors = '.question, div[class*="question"], div[class*="jam"], .challenge, .prompt';
        const questions = Array.from(document.querySelectorAll(selectors));
        for (let i = questions.length - 1; i >= 0; i--) {
            const q = questions[i];
            if (isVisible(q) && (q.querySelector('.choices') || q.querySelector('.spelltheword') || q.querySelector('input.wordspelling') || q.querySelector('img') || q.querySelectorAll('button, a[accesskey]').length >= 2)) {
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
        if (!el) return '';
        const lookupSpan = el.querySelector('.lookup[word]');
        if (lookupSpan && lookupSpan.getAttribute('word')) {
            return lookupSpan.getAttribute('word').trim();
        }
        const clone = el.cloneNode(true);
        const tools = clone.querySelector('.tools, .lookup');
        if (tools) tools.remove();
        return clone.innerText.replace(/ 🧠$/g, '').trim();
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
    // 5. UNIFIED API ENGINE (EXA INSTANT STRICTLY FOR SPELLING)
    // ==========================================
    function cleanAIReply(reply) {
        if (!reply || typeof reply !== 'string') return '';
        let stripped = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (!stripped) {
            stripped = reply.replace(/<\/?think>/gi, '').trim();
        }
        return stripped;
    }

    async function callAI(systemPrompt, userPrompt, imageUrls = [], enableSpellingSearch = false) {
        if (!config.apiKey) {
            setStatus('⚠️ Missing API Key!');
            return null;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 18000);

        let endpoint, headers, body;

        try {
            if (config.provider === 'gemini') {
                endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
                headers = { 'Content-Type': 'application/json' };

                let contentParts = [{ text: userPrompt }];
                const reqBody = {
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ parts: contentParts }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 350 }
                };

                // Gemini Native Google Search ONLY for spelling
                if (enableSpellingSearch && config.spellSearch) {
                    reqBody.tools = [{ googleSearch: {} }];
                }

                body = JSON.stringify(reqBody);
            } else {
                endpoint = 'https://openrouter.ai/api/v1/chat/completions';
                headers = {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://vocabulary.com',
                    'X-Title': 'Vocab AI Solver'
                };

                let userContent;
                if (imageUrls && imageUrls.length > 0) {
                    userContent = [{ type: 'text', text: userPrompt }];
                    imageUrls.forEach(url => {
                        userContent.push({ type: 'image_url', image_url: { url } });
                    });
                } else {
                    userContent = userPrompt;
                }

                const reqBody = {
                    model: config.orModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent }
                    ],
                    temperature: 0.1,
                    max_tokens: 350
                };

                // Exa Instant search strictly on vocabulary.com ONLY for spelling
                if (enableSpellingSearch && config.spellSearch) {
                    reqBody.tools = [
                        {
                            type: 'openrouter:web_search',
                            parameters: {
                                engine: 'exa',
                                mode: 'instant', // ~250ms latency
                                max_results: 3,
                                allowed_domains: ['vocabulary.com']
                            }
                        }
                    ];
                }

                body = JSON.stringify(reqBody);
            }

            const res = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                logDebug(`HTTP ${res.status}`, errText.slice(0, 200));
                throw new Error(`API Error ${res.status}`);
            }

            const data = await res.json();
            let rawContent = '';
            if (config.provider === 'gemini') {
                const parts = data?.candidates?.[0]?.content?.parts || [];
                rawContent = parts.map(p => p.text || '').filter(Boolean).join('\n');
            } else {
                const msg = data?.choices?.[0]?.message;
                rawContent = msg?.content || msg?.reasoning || msg?.reasoning_content || '';
            }

            return cleanAIReply(rawContent);
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    }

    function extractFinalAnswer(rawReply) {
        if (!rawReply) return '';
        const match = rawReply.match(/(?:ANSWER|CORRECT(?: ANSWER)?|CHOICE):\s*([^\n\r]+)/i);
        if (match && match[1]) {
            return match[1].replace(/^["'*\s]+|["'*\s]+$/g, '').trim();
        }
        const lines = rawReply.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        return lines.length > 0 ? lines[lines.length - 1].replace(/^["'*\s]+|["'*\s]+$/g, '').trim() : '';
    }

    // MULTIPLE CHOICE: Pure fast LLM memory (0 web search overhead)
    async function askAIMultipleChoice(promptText, choicesTextArray) {
        const formattedChoices = choicesTextArray.map((c, i) => `${i + 1}. ${c}`).join('\n');
        const systemInstruction = 
            "You are an expert Vocabulary.com solver. Select the single best answer choice.\n" +
            "Output ONLY the text or number of the correct option in this exact format:\n" +
            "ANSWER: <exact text of chosen option>";

        const userPrompt = `Question Context / Prompt:\n${promptText}\n\nAvailable Options:\n${formattedChoices}`;
        const rawReply = await callAI(systemInstruction, userPrompt, [], false);
        logDebug('AI raw reply', rawReply);

        if (!rawReply) return null;

        const parsed = extractFinalAnswer(rawReply);
        logDebug('Parsed final answer', parsed);

        let matched = choicesTextArray.find(c => c.toLowerCase().trim() === parsed.toLowerCase().trim());

        if (!matched) {
            const numMatch = parsed.match(/^([1-4])\b/);
            if (numMatch) {
                const idx = parseInt(numMatch[1], 10) - 1;
                if (idx >= 0 && idx < choicesTextArray.length) {
                    matched = choicesTextArray[idx];
                }
            }
        }

        if (!matched && parsed.length >= 3) {
            matched = choicesTextArray.find(c => 
                c.toLowerCase().includes(parsed.toLowerCase()) || 
                parsed.toLowerCase().includes(c.toLowerCase())
            );
        }

        if (!matched) {
            const replyLower = rawReply.toLowerCase();
            for (const choice of choicesTextArray) {
                if (choice.length >= 3 && replyLower.includes(choice.toLowerCase())) {
                    matched = choice;
                    break;
                }
            }
        }

        return matched || null;
    }

    // SPELLING: Grounded via Exa Instant (~250ms) to vocabulary.com
    async function askAISpelling(sentenceContext) {
        let systemInstruction = 
            "You are an expert Vocabulary.com spelling solver.\n" +
            "You are given an example sentence with blanks (________) from Vocabulary.com.\n" +
            "Identify the exact academic headword being tested.\n" +
            "Search vocabulary.com for this exact sentence to locate the word entry.\n" +
            "The target spelling is always the primary dictionary headword / base lemma.\n" +
            "Output your final answer on the last line strictly in this format:\n" +
            "ANSWER: <single word>";

        const userPrompt = `Sentence / Definition:\n"${sentenceContext}"\n\nFind the target vocabulary headword:`;
        const rawReply = await callAI(systemInstruction, userPrompt, [], true); // enableSpellingSearch = true
        logDebug('AI spelling reply', rawReply);

        let parsed = extractFinalAnswer(rawReply);
        if (!parsed && rawReply) {
            const words = rawReply.match(/\b[a-zA-Z-]{3,}\b/g);
            if (words && words.length > 0) parsed = words[words.length - 1];
        }
        return parsed ? parsed.toLowerCase().replace(/[^a-z-]/g, '') : null;
    }

    // PICTURE CHOICE: Pure fast multimodal vision
    async function askAIPictureChoice(wordPrompt, pictureUrls) {
        const systemInstruction = 
            "You are an expert Vocabulary.com picture-choice solver.\n" +
            "You are given a target vocabulary word and 4 images arranged in order:\n" +
            "Option 1: Top-Left, Option 2: Top-Right, Option 3: Bottom-Left, Option 4: Bottom-Right.\n" +
            "Select the single image option number (1, 2, 3, or 4) that correctly illustrates the target word.\n" +
            "On your final line, output strictly:\n" +
            "ANSWER: <1, 2, 3, or 4>";

        const userPrompt = `Target Word Prompt: "${wordPrompt}"\nWhich option (1, 2, 3, or 4) matches this word?`;
        const rawReply = await callAI(systemInstruction, userPrompt, pictureUrls, false);
        logDebug('AI picture reply', rawReply);

        const parsed = extractFinalAnswer(rawReply);
        const num = parseInt(parsed.replace(/[^0-9]/g, ''), 10);
        return (!isNaN(num) && num >= 1 && num <= 4) ? num : null;
    }

    // ==========================================
    // 6. QUESTION SOLVING PIPELINE
    // ==========================================
    function getPacingDelay() {
        if (config.speed === 'instant') {
            return Math.floor(Math.random() * 200) + 700;
        } else if (config.speed === 'fast') {
            return Math.floor(Math.random() * 1000) + 1500;
        } else {
            return Math.floor(Math.random() * 1500) + 3200;
        }
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
            setTimeout(() => {
                nxtBtn.click();
                setTimeout(() => { delete nxtBtn.dataset.autoClicked; }, 1500);
            }, getPacingDelay());
        }
    }

    async function handleMultipleChoice(questBox, choicesContainer) {
        const choiceElements = Array.from(choicesContainer.querySelectorAll('a, div.choice, .choices > *'))
            .filter(el => isVisible(el) && getCleanChoiceText(el).length > 0);

        if (choiceElements.length === 0) return;

        if (choiceElements.some(el => el.classList.contains('correct') || el.classList.contains('incorrect'))) {
            checkNextButton();
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
                    setStatus(`✅ Answer: ${winningAnswerText}`);
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
                setTimeout(() => {
                    targetElement.click();
                }, getPacingDelay());
            }
        }
    }

    async function handlePictureChoice(questBox) {
        const imgElements = Array.from(questBox.querySelectorAll('img')).filter(img => isVisible(img) && img.src && !img.src.includes('avatar') && !img.src.includes('logo'));
        const clickableOptions = Array.from(questBox.querySelectorAll('.choices a, a[accesskey], div.choice, .picture-choice, .item-play a')).filter(isVisible);

        if (imgElements.length < 2 || clickableOptions.length < 2) return;

        const promptEl = questBox.querySelector('.instructions, .prompt, h3, .sentence') || questBox;
        const promptText = promptEl.innerText.replace(/choose the best picture for/i, '').trim();

        const cacheKey = `pic|||${promptText.toLowerCase()}`;
        if (cacheKey === lastSolvedSignature) return;
        lastSolvedSignature = cacheKey;

        let optionNumber = config.cache[cacheKey];

        if (optionNumber) {
            setStatus(`⚡ Solved from cache: Option ${optionNumber}`);
        } else {
            const activeModelName = config.provider === 'gemini' ? config.model : config.orModel;
            setStatus(`🤖 Visual solve via ${activeModelName}...`);
            try {
                const imgUrls = imgElements.slice(0, 4).map(img => img.src);
                optionNumber = await askAIPictureChoice(promptText, imgUrls);
                if (optionNumber) {
                    saveCache(cacheKey, String(optionNumber));
                    setStatus(`✅ Option ${optionNumber} selected`);
                }
            } catch (err) {
                setStatus(`❌ Visual error: ${err.message}`);
                return;
            }
        }

        if (optionNumber && optionNumber <= clickableOptions.length) {
            const targetElement = clickableOptions[optionNumber - 1];
            applyReferenceHighlight(targetElement);

            if (config.mode === 'auto') {
                setTimeout(() => {
                    targetElement.click();
                }, getPacingDelay());
            }
        }
    }

    async function handleSpelling(questBox) {
        const inp = questBox.querySelector('input.wordspelling, input[type="text"]');
        const submitBtn = questBox.querySelector('button.spellit, button[type="submit"]');
        const label = questBox.querySelector('.spelltheword .label, .label');
        const sentenceElem = questBox.querySelector('.sentence.blanked, .sentence, .questionContent');

        if (!inp || !sentenceElem) return;

        const sentenceText = sentenceElem.innerText.trim();
        const cacheKey = `spell|||${sentenceText.toLowerCase().replace(/\s+/g, ' ')}`;

        if (cacheKey === lastSolvedSignature) return;
        lastSolvedSignature = cacheKey;

        let wordAnswer = config.cache[cacheKey];

        if (!wordAnswer) {
            const activeModelName = config.provider === 'gemini' ? config.model : config.orModel;
            setStatus(`🤖 Spelling via ${activeModelName}${config.spellSearch ? ' (Exa Instant)' : ''}...`);
            try {
                wordAnswer = await askAISpelling(sentenceText);
                if (wordAnswer) {
                    saveCache(cacheKey, wordAnswer);
                    setStatus(`✅ Spell: ${wordAnswer}`);
                }
            } catch (err) {
                setStatus(`❌ ${err.message}`);
                return;
            }
        } else {
            setStatus('⚡ Spelling loaded from cache');
        }

        if (wordAnswer) {
            inp.value = wordAnswer;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));

            if (label) {
                label.style.color = "springgreen";
                label.innerText = `Spell the word: ${wordAnswer} 🧠`;
            }

            if (config.mode === 'auto') {
                setTimeout(() => {
                    inp.blur();
                    if (submitBtn) submitBtn.click();
                }, getPacingDelay());
            }
        }
    }

    // ==========================================
    // 7. MAIN ENGINE & OBSERVER
    // ==========================================
    async function checkAndSolve() {
        if (checkBlockersAndLockout()) return;
        checkNextButton();

        if (isProcessing) return;

        const questBox = findActiveQuestionBox();
        if (!questBox) return;

        const choicesContainer = questBox.querySelector('.choices') || questBox.querySelector('ul[class*="choice"]');
        const spellInput = questBox.querySelector('input.wordspelling, .spelltheword');
        const imgElements = questBox.querySelectorAll('img');

        isProcessing = true;
        try {
            if (spellInput) {
                await handleSpelling(questBox);
            } else if (imgElements.length >= 2 && (!choicesContainer || choicesContainer.children.length === 0)) {
                await handlePictureChoice(questBox);
            } else if (choicesContainer && choicesContainer.children.length > 0) {
                await handleMultipleChoice(questBox, choicesContainer);
            }
        } finally {
            isProcessing = false;
        }
    }

    function startEngine() {
        injectUI();
        logDebug('Vocab Solver Engine 2.2.2 started on ' + location.pathname);

        const observer = new MutationObserver(() => {
            checkAndSolve();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });

        setInterval(checkAndSolve, 400);
        checkAndSolve();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startEngine);
    } else {
        startEngine();
    }
})();
