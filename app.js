const appState = {
    channels: [],
    categories: new Set(),
    currentCategory: 'all',
    currentView: 'live-tv',
    searchQuery: '',
    hls: null,
    mpegtsPlayer: null,
    sourceUrl: '',
    epgUrl: '',
    epgData: {},
    idleTimer: null,
    isIdle: false
};

// Helper: route any URL through the local proxy
function proxyUrl(targetUrl) {
    return '/api/proxy?url=' + encodeURIComponent(targetUrl);
}

// DOM Elements
const elements = {
    grid: document.getElementById('channels-grid'),
    emptyState: document.getElementById('empty-state'),
    sidebarMenu: document.querySelectorAll('.menu li'),
    sectionTitle: document.getElementById('section-title'),
    categoriesContainer: document.getElementById('categories-container'),
    searchInput: document.getElementById('search-input'),
    clock: document.getElementById('clock'),
    videoOverlay: document.getElementById('video-overlay'),
    videoPlayer: document.getElementById('video-player'),
    closePlayerBtn: document.getElementById('close-player'),
    m3uUpload: document.getElementById('m3u-upload'),
    m3uUrlInput: document.getElementById('m3u-url'),
    loadUrlBtn: document.getElementById('load-url-btn'),
    playerInfo: {
        name: document.getElementById('player-channel-name'),
        group: document.getElementById('player-group-name')
    }
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    updateClock();
    setInterval(updateClock, 60000);

    // Auto-load playlist from server (URL is kept secret server-side)
    fetch('/api/playlist')
        .then(response => {
            if (!response.ok) throw new Error('Playlist fetch failed');
            return response.text();
        })
        .then(data => {
            parseM3U(data);
            showNotification('Lista kanałów załadowana', 'success');
        })
        .catch(err => {
            console.error('Failed to load playlist:', err);
            // Show upload state so user can load manually
        });

    // Event Listeners
    elements.searchInput.addEventListener('input', (e) => {
        appState.searchQuery = e.target.value.toLowerCase();
        renderChannels();
    });

    elements.m3uUpload.addEventListener('change', handleFileUpload);
    elements.loadUrlBtn.addEventListener('click', handleUrlUpload);

    elements.closePlayerBtn.addEventListener('click', closePlayer);

    // Sidebar navigation
    elements.sidebarMenu.forEach(item => {
        item.addEventListener('click', () => {
            elements.sidebarMenu.forEach(li => li.classList.remove('active'));
            item.classList.add('active');

            const view = item.dataset.view;
            appState.currentView = view;
            elements.sectionTitle.textContent = item.querySelector('span').textContent;

            if (view === 'settings') {
                elements.grid.style.display = 'none';
                elements.emptyState.style.display = 'none'; // Hide upload state too
                elements.categoriesContainer.style.display = 'none';
                renderSettings();
            } else if (view === 'epg') {
                elements.grid.style.display = 'none';
                elements.emptyState.style.display = 'none';
                elements.categoriesContainer.style.display = 'none';
                renderEPG();
            } else {
                // Ensure EPG list is hidden
                document.getElementById('epg-list').style.display = 'none';

                elements.categoriesContainer.style.display = 'flex';
                if (appState.channels.length > 0) {
                    elements.grid.style.display = 'grid';
                    elements.emptyState.style.display = 'none';
                }
                // Reset category to "all" when switching views
                appState.currentCategory = 'all';
                document.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
                if (document.querySelector('.category-pill')) {
                    document.querySelector('.category-pill').classList.add('active');
                }

                // Re-extract categories for the new view
                extractCategories();
                renderCategories();
                renderChannels();
            }
        });
    });

    // Keyboard navigation support for player
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && elements.videoOverlay.classList.contains('active')) {
            closePlayer();
        }
    });
});

function updateClock() {
    const now = new Date();
    elements.clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// --- M3U Parser ---
function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        parseM3U(content);
    };
    reader.readAsText(file);
}

function handleUrlUpload() {
    const url = elements.m3uUrlInput.value.trim();
    if (!url) return;

    // Fetch M3U through local proxy
    fetch(proxyUrl(url))
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.text();
        })
        .then(data => {
            appState.sourceUrl = url;
            localStorage.setItem('iptv_source_url', url);
            parseM3U(data);
        })
        .catch(error => {
            console.error('Error fetching M3U:', error);
            alert('Nie udało się pobrać listy. Sprawdź czy serwer działa (node server.js).');
        });
}

function parseM3U(content) {
    const lines = content.split('\n');
    const channels = [];
    let currentChannel = {};

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            currentChannel = {};

            // Extract attributes like tvg-logo, group-title
            const logoMatch = line.match(/tvg-logo="([^"]*)"/);
            const groupMatch = line.match(/group-title="([^"]*)"/);
            const nameMatch = line.match(/,(.+)$/);

            currentChannel.logo = logoMatch ? logoMatch[1] : null;
            currentChannel.group = groupMatch ? groupMatch[1] : 'Uncategorized';
            currentChannel.name = nameMatch ? nameMatch[1].trim() : 'Unknown Channel';
        } else if (line.length > 0 && !line.startsWith('#')) {
            currentChannel.url = line;
            if (currentChannel.name && currentChannel.url) {
                channels.push({ ...currentChannel });
            }
        }
    });

    appState.channels = channels;
    extractCategories();
    renderCategories();
    renderChannels();
    console.log(`Loaded ${channels.length} channels`);

    // Auto-fetch EPG if we have channels
    if (channels.length > 0) {
        fetchEPG();
    }
}

// --- EPG Logic ---
function fetchEPG() {
    console.log("Fetching EPG...");
    showNotification("Pobieranie programu TV...", "info");

    // Fetch EPG through secure server endpoint (URL hidden server-side)
    fetch('/api/epg')
        .then(res => res.text())
        .then(str => {
            parseEPG(str);
        })
        .catch(err => {
            console.error("EPG Fetch Error:", err);
            showNotification("Błąd pobierania EPG", "warning");
        });
}

function parseEPG(xmlString) {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlString, "text/xml");
        const programmes = xmlDoc.querySelectorAll("programme");

        console.log(`EPG Parsed. Found ${programmes.length} programs.`);
        appState.epgData = {};

        const parseDate = (dateStr) => {
            if (!dateStr || dateStr.length < 14) return null;
            const y = parseInt(dateStr.substring(0, 4));
            const m = parseInt(dateStr.substring(4, 6)) - 1;
            const d = parseInt(dateStr.substring(6, 8));
            const h = parseInt(dateStr.substring(8, 10));
            const min = parseInt(dateStr.substring(10, 12));
            return new Date(y, m, d, h, min);
        };

        programmes.forEach(prog => {
            const channelId = prog.getAttribute("channel");
            const startStr = prog.getAttribute("start");
            const stopStr = prog.getAttribute("stop");

            if (!channelId || !startStr || !stopStr) return;

            const start = parseDate(startStr);
            const stop = parseDate(stopStr);

            if (!start || !stop) return;

            const titleFn = prog.querySelector("title");
            const title = titleFn ? titleFn.textContent : "Bez tytułu";
            const descFn = prog.querySelector("desc");
            const desc = descFn ? descFn.textContent : "";

            if (!appState.epgData[channelId]) {
                appState.epgData[channelId] = [];
            }

            appState.epgData[channelId].push({
                start,
                stop,
                title,
                desc
            });
        });

        mapEPGToChannels();
    } catch (e) {
        console.error("EPG Parse Error:", e);
    }
}

function mapEPGToChannels() {
    let mappedCount = 0;

    appState.channels.forEach(ch => {
        let epgId = ch.name;

        // Exact match check
        if (appState.epgData[epgId]) {
            ch.epg = appState.epgData[epgId];
            mappedCount++;
        } else {
            // Case-insensitive match check
            const chNameLower = ch.name.toLowerCase();
            const foundKey = Object.keys(appState.epgData).find(k => k.toLowerCase() === chNameLower);
            if (foundKey) {
                ch.epg = appState.epgData[foundKey];
                mappedCount++;
            }
        }
    });

    console.log(`Mapped EPG for ${mappedCount} channels.`);
    showNotification(`Zaktualizowano EPG (${mappedCount} kanałów)`, "success");

    if (appState.currentView === 'epg') {
        renderEPG();
    }
}

function getCurrentProgram(channel) {
    if (!channel.epg) return null;
    const now = new Date();
    return channel.epg.find(p => now >= p.start && now < p.stop);
}

function getNextProgram(channel) {
    if (!channel.epg) return null;
    const now = new Date();
    const currentIdx = channel.epg.findIndex(p => now >= p.start && now < p.stop);
    if (currentIdx !== -1 && currentIdx + 1 < channel.epg.length) {
        return channel.epg[currentIdx + 1];
    }
    return null;
}

function extractCategories() {
    appState.categories = new Set(['all']);
    const viewChannels = getChannelsForView(appState.currentView);
    viewChannels.forEach(ch => {
        if (ch.group) appState.categories.add(ch.group);
    });
}

function getChannelsForView(view) {
    if (!appState.channels.length) return [];

    return appState.channels.filter(ch => {
        const group = (ch.group || '').toLowerCase();
        const name = (ch.name || '').toLowerCase();

        const isMovie = group.includes('movie') || group.includes('film') ||
            group.includes('vod') || group.includes('cinema') ||
            name.includes('movie') || name.includes('vod');

        const isSeries = group.includes('series') || group.includes('serial') ||
            group.includes('season') || group.includes('episode') ||
            name.includes('s0') || name.includes('e0'); // simple heuristic

        if (view === 'movies') return isMovie;
        if (view === 'series') return isSeries;
        if (view === 'live-tv') return !isMovie && !isSeries;

        return true; // Fallback
    });
}

// --- Rendering ---
function renderCategories() {
    elements.categoriesContainer.innerHTML = '';

    appState.categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `category-pill ${appState.currentCategory === cat ? 'active' : ''}`;
        btn.textContent = cat === 'all' ? 'Wszystkie' : cat;
        btn.onclick = () => {
            appState.currentCategory = cat;
            document.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderChannels();
        };
        elements.categoriesContainer.appendChild(btn);
    });
}

function renderSettings() {
    elements.grid.style.display = 'grid';
    elements.grid.style.display = 'flex';
    elements.grid.style.flexDirection = 'column';
    elements.grid.innerHTML = '';

    const settingsContainer = document.createElement('div');
    settingsContainer.className = 'settings-container';
    settingsContainer.innerHTML = `
        <div class="settings-card">
            <h3>Konfiguracja Odtwarzania</h3>
            <div class="setting-item">
                <div class="setting-info">
                    <strong>Serwer Proxy</strong>
                    <p>Wszystkie żądania są automatycznie kierowane przez lokalny serwer proxy (node server.js). Nie potrzebujesz żadnych wtyczek CORS.</p>
                    <p style="color: var(--accent); font-weight: 500;">✓ Serwer proxy aktywny na localhost:3000</p>
                </div>
            </div>
             <div class="setting-item">
                <div class="setting-info">
                    <strong>Wgraj nową listę</strong>
                    <p>Obecna lista zostanie zastąpiona.</p>
                </div>
                <button class="btn-secondary" onclick="document.getElementById('m3u-upload').click()">Wgraj plik</button>
            </div>
        </div>
    `;

    elements.grid.appendChild(settingsContainer);
}

function renderChannels() {
    if (appState.currentView === 'settings') return; // Don't render channels in settings view

    if (appState.channels.length === 0) {
        elements.grid.style.display = 'none';
        elements.emptyState.style.display = 'flex';
        return;
    }

    elements.emptyState.style.display = 'none';
    elements.grid.style.display = 'grid';
    elements.grid.innerHTML = '';

    // 1. Filter by View
    let viewChannels = getChannelsForView(appState.currentView);

    // 2. Filter by Category & Search
    const filtered = viewChannels.filter(ch => {
        const matchesCategory = appState.currentCategory === 'all' || ch.group === appState.currentCategory;
        const matchesSearch = ch.name.toLowerCase().includes(appState.searchQuery);
        return matchesCategory && matchesSearch;
    });

    if (filtered.length === 0) {
        elements.grid.innerHTML = '<div class="no-results">Brak kanałów w tej sekcji</div>';
        return;
    }

    filtered.forEach(ch => {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.innerHTML = `
            ${ch.logo ? `<img src="${ch.logo}" class="channel-logo" loading="lazy" onerror="this.style.display='none'">` : '<i class="fa-solid fa-tv channel-logo"></i>'}
            <div class="channel-name">${ch.name}</div>
        `;
        card.onclick = () => playChannel(ch);
        elements.grid.appendChild(card);
    });
}

function renderEPG() {
    const list = document.getElementById('epg-list');
    list.innerHTML = '';
    list.style.display = 'flex';
    elements.grid.style.display = 'none';
    elements.emptyState.style.display = 'none';
    elements.categoriesContainer.style.display = 'none';

    if (appState.channels.length === 0) {
        list.innerHTML = '<div class="no-results">Brak kanałów. Wgraj listę.</div>';
        return;
    }

    // Only show first 100 or so to avoid DOM overload, or use virtualization (skipped for simplicity)
    const channels = appState.channels;

    channels.forEach(ch => {
        const current = getCurrentProgram(ch);
        const next = getNextProgram(ch);

        const item = document.createElement('div');
        item.className = 'epg-item';

        let progressWidth = 0;
        if (current) {
            const now = new Date();
            const total = current.stop - current.start;
            const elapsed = now - current.start;
            progressWidth = Math.min(100, Math.max(0, (elapsed / total) * 100));
        }

        item.innerHTML = `
            <div class="epg-logo-wrapper">
                 ${ch.logo ? `<img src="${ch.logo}" class="epg-logo" loading="lazy">` : '<i class="fa-solid fa-tv"></i>'}
            </div>
            <div class="epg-details">
                <div class="epg-channel-name">${ch.name}</div>
                <div class="epg-program-now">
                    ${current ? `${formatTime(current.start)} - ${current.title}` : 'Brak danych EPG'}
                </div>
                ${current ? `
                <div class="epg-time-bar">
                    <div class="epg-time-progress" style="width: ${progressWidth}%"></div>
                </div>
                ` : ''}
                <div class="epg-program-next">
                    ${next ? `Następnie: ${formatTime(next.start)} ${next.title}` : ''}
                </div>
            </div>
            <div class="play-btn-small"><i class="fa-solid fa-play"></i></div>
        `;

        item.onclick = () => playChannel(ch);
        list.appendChild(item);
    });
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// --- Player Logic ---
function playChannel(channel) {
    elements.videoOverlay.classList.add('active');
    elements.playerInfo.name.textContent = channel.name;
    elements.playerInfo.group.textContent = channel.group;

    const video = elements.videoPlayer;
    let url = channel.url.trim();

    // Attempt to handle Autoplay
    // video.muted = true; // REMOVED: Allow audio by default

    // Reset Idle Timer on start
    resetIdleTimer();
    // Add listeners for idle detection
    document.addEventListener('mousemove', resetIdleTimer);
    document.addEventListener('mousedown', resetIdleTimer);
    document.addEventListener('keydown', resetIdleTimer);


    // Cleanup previous players
    if (appState.hls) {
        appState.hls.destroy();
        appState.hls = null;
    }
    if (appState.mpegtsPlayer) {
        appState.mpegtsPlayer.destroy();
        appState.mpegtsPlayer = null;
    }

    // Determine type
    const isM3U8 = url.includes('.m3u8');
    const isTS = url.includes('.ts') || url.includes('/mpegts') || !isM3U8; // Fallback to TS for non-m3u8 links

    console.log(`Playing: ${url} (isM3U8: ${isM3U8}, isTS: ${isTS})`);

    if (isM3U8 && Hls.isSupported()) {
        const config = {
            // Route all HLS segment fetches through local proxy
            xhrSetup: function (xhr, hlsUrl) {
                // If the URL is already proxied, skip
                if (!hlsUrl.startsWith('/api/proxy')) {
                    const proxied = proxyUrl(hlsUrl);
                    xhr.open('GET', proxied, true);
                }
            }
        };

        appState.hls = new Hls(config);

        // Load the original URL — xhrSetup will proxy each request
        appState.hls.loadSource(url);
        appState.hls.attachMedia(video);
        appState.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            var promise = video.play();
            if (promise !== undefined) {
                promise.catch(error => {
                    console.error("Auto-play blocked, showing mute warning", error);
                    showNotification("Autoplay zablokowany. Odtwarzam wyciszone.", "warning");
                    video.muted = true;
                    video.play();
                });
            }
        });

        appState.hls.on(Hls.Events.ERROR, function (event, data) {
            console.error("HLS Error:", data);
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        showNotification(`Błąd sieci (HLS): Sprawdź CORS lub łącze.`, 'error');
                        appState.hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        appState.hls.recoverMediaError();
                        break;
                    default:
                        showNotification(`Błąd krytyczny (HLS): ${data.details}`, 'error');
                        appState.hls.destroy();
                        break;
                }
            }
        });
    } else if (isTS && mpegts.getFeatureList().mseLivePlayback) {
        // MPEG-TS Playback — route through local proxy
        appState.mpegtsPlayer = mpegts.createPlayer({
            type: 'mpegts',
            isLive: true,
            url: proxyUrl(url),
        });

        appState.mpegtsPlayer.attachMediaElement(video);
        appState.mpegtsPlayer.load();
        var promise = appState.mpegtsPlayer.play();
        if (promise !== undefined) {
            promise.catch(e => {
                console.error("MPEGTS Play error", e);
                showNotification("Błąd startu MPEGTS. Spróbuj kliknąć play.", "warning");
            });
        }

        appState.mpegtsPlayer.on(mpegts.Events.ERROR, (type, details, data) => {
            console.error("MPEGTS Error:", type, details, data);
            if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
                showNotification(`Błąd sieci (MPEGTS): ${details}`, 'error');
            }
        });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari)
        video.src = url;
        video.play();
    } else {
        video.src = url; // Try direct play (mp4 etc)
        video.play().catch(e => {
            showNotification("Nieobsługiwany format w tej przeglądarce.", "error");
        });
    }

    // Start OSD Updater
    updateOSD(channel);
    if (appState.osdInterval) clearInterval(appState.osdInterval);
    appState.osdInterval = setInterval(() => updateOSD(channel), 5000);
}

function updateOSD(channel) {
    const current = getCurrentProgram(channel);
    const next = getNextProgram(channel);

    const titleEl = document.getElementById('osd-program-title');
    const startEl = document.getElementById('osd-start-time');
    const endEl = document.getElementById('osd-end-time');
    const nextEl = document.getElementById('osd-next-program');
    const progressEl = document.getElementById('osd-progress-bar');

    if (current) {
        titleEl.textContent = current.title;
        startEl.textContent = formatTime(current.start);
        endEl.textContent = formatTime(current.stop);

        const now = new Date();
        const total = current.stop - current.start;
        const elapsed = now - current.start;
        const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));

        progressEl.style.width = `${pct}%`;

        if (next) {
            nextEl.textContent = `Następnie: ${formatTime(next.start)} ${next.title}`;
        } else {
            nextEl.textContent = '';
        }
    } else {
        titleEl.textContent = "Brak informacji o EPG";
        startEl.textContent = '';
        endEl.textContent = '';
        progressEl.style.width = '0%';
        nextEl.textContent = '';
    }
}

function showNotification(message, type = 'info') {
    const area = document.getElementById('notification-area');
    const note = document.createElement('div');
    note.className = `notification ${type}`;
    note.textContent = message;

    area.appendChild(note);

    // Animation in
    requestAnimationFrame(() => note.classList.add('visible'));

    setTimeout(() => {
        note.classList.remove('visible');
        setTimeout(() => note.remove(), 300);
    }, 5000);
}


function closePlayer() {
    elements.videoOverlay.classList.remove('active');
    elements.videoPlayer.pause();
    elements.videoPlayer.src = '';

    // Clear idle timer
    if (appState.idleTimer) clearTimeout(appState.idleTimer);
    document.removeEventListener('mousemove', resetIdleTimer);
    document.removeEventListener('mousedown', resetIdleTimer);
    document.removeEventListener('keydown', resetIdleTimer);
    elements.videoContainer.classList.remove('user-idle'); // Ensure cursor is back

    if (appState.hls) {
        appState.hls.destroy();
        appState.hls = null;
    }
    if (appState.mpegtsPlayer) {
        appState.mpegtsPlayer.destroy();
        appState.mpegtsPlayer = null;
    }
}

// --- Idle Timer ---
function resetIdleTimer() {
    const container = document.querySelector('.video-container');
    if (!container) return;

    // Wake up
    if (appState.isIdle) {
        container.classList.remove('user-idle');
        appState.isIdle = false;
    }

    if (appState.idleTimer) clearTimeout(appState.idleTimer);

    // Go to sleep after 3s
    appState.idleTimer = setTimeout(() => {
        if (elements.videoOverlay.classList.contains('active')) { // Only if player is active
            container.classList.add('user-idle');
            appState.isIdle = true;
        }
    }, 3000);
}
