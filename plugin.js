class Plugin extends AppPlugin {

    onLoad() {
        // We load PAT from plugin configuration, removing from cleartext localstorage if found
        const conf = this.getConfiguration();
        this.githubPat = conf?.custom?.githubPat || localStorage.getItem('pm_github_pat_persistent') || localStorage.getItem('pm_github_pat') || '';
        if (localStorage.getItem('pm_github_pat')) {
            localStorage.removeItem('pm_github_pat');
        }
        this.communityRepos = localStorage.getItem('pm_community_repos') || 'https://raw.githubusercontent.com/ed-nico/awesome-thymer/main/README.md';
        this._updateIntervalId = null;
        try { this._disabledPlugins = JSON.parse(localStorage.getItem('pm_disabled_plugins') || '{}'); } catch (e) { this._disabledPlugins = {}; }
        try { this._incompatiblePlugins = JSON.parse(localStorage.getItem('pm_incompatible') || '{}'); } catch (e) { this._incompatiblePlugins = {}; }
        // Evict stale incompatible entries older than 30 days
        const _cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        Object.keys(this._incompatiblePlugins).forEach(k => {
            if (new Date(this._incompatiblePlugins[k].date || 0).getTime() < _cutoff)
                delete this._incompatiblePlugins[k];
        });
        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
        let savedThemes = conf?.custom?.saved_themes;

        if (!savedThemes) {
            const oldThemesRaw = localStorage.getItem('pm_saved_themes');
            if (oldThemesRaw) {
                try {
                    savedThemes = JSON.parse(oldThemesRaw);
                    // Schedule migration to config after load
                    setTimeout(() => {
                        this._savedThemes = savedThemes;
                        this._saveThemes();
                    }, 1000);
                } catch (e) { }
            }
        }

        this._savedThemes = savedThemes || [];
        this._autoExportEnabled = localStorage.getItem('pm_auto_export') === 'true';
        this._autoExportDirHandle = null;
        this._autoExportDirName = localStorage.getItem('pm_auto_export_dir_name') || '';
        // Restore directory handle from IndexedDB
        this._restoreAutoExportHandle();

        // Register the panel type
        this.ui.registerCustomPanelType("plugin-manager-panel", (panel) => {
            this.renderUI(panel);
        });

        // Add a status bar button to launch it
        this.ui.addStatusBarItem({
            icon: "box",
            tooltip: "Plugins Manager",
            onClick: async () => {
                const newPanel = await this.ui.createPanel();
                if (newPanel) {
                    newPanel.navigateToCustomType("plugin-manager-panel");
                }
            }
        });

        // Start automated update checker
        this.startAutomatedUpdateChecker();
    }

    onUnload() {
        // Clean up interval to prevent memory leaks
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }
        this._discoverItems = null;
        // Remove any dangling import modal from the DOM
        if (this._importModal && this._importModal.parentNode) {
            this._importModal.parentNode.removeChild(this._importModal);
            this._importModal = null;
        }
        // Disconnect responsive resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
    }

    async startAutomatedUpdateChecker() {
        // Run daily
        const lastCheck = localStorage.getItem('pm_last_update_check');
        const now = Date.now();
        if (!lastCheck || now - parseInt(lastCheck) > 24 * 60 * 60 * 1000) {
            await this.checkForAllUpdatesInBackground();
            localStorage.setItem('pm_last_update_check', now.toString());
        }

        // Setup interval to check every 12 hours while open
        this._updateIntervalId = setInterval(() => this.checkForAllUpdatesInBackground(), 12 * 60 * 60 * 1000);
    }

    async checkForAllUpdatesInBackground() {
        try {
            const updatesAvailable = {};
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            const allPlugins = [...allGlobals, ...allCollections];
            let checkCount = 0;
            const MAX_CHECKS = 50; // Cap to avoid massive rate limits in one run

            for (const p of allPlugins) {
                if (checkCount >= MAX_CHECKS) break;
                
                try {
                    const { json } = p.getExistingCodeAndConfig();
                    const repo = json.__source_repo;
                    if (repo && this._isValidGithubUrl(repo)) {
                        checkCount++;
                        const { json: remoteJson } = await this.fetchGithubRepo(repo, { sourceFiles: json.__source_files });
                        if (remoteJson.version && remoteJson.version !== json.version) {
                            updatesAvailable[p.getGuid()] = remoteJson.version;
                        }
                        // Avoid GitHub rate limiting between requests
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } catch (e) {
                    // Bail early if rate-limited
                    if (e.message && (e.message.includes('rate limit') || e.message.includes('403'))) {
                        console.warn('[Plugins Manager] GitHub rate limit hit during background check, stopping early.');
                        // Add exponential backoff style delay to prevent immediate retries from locking up further
                        localStorage.setItem('pm_last_update_check', (Date.now() + 6 * 60 * 60 * 1000).toString()); // push next check 6 hrs out
                        break;
                    }
                    /* ignore individual plugin errors */
                }
            }

            localStorage.setItem('pm_updates_available', JSON.stringify(updatesAvailable));
        } catch (e) {
            console.error("Background update check failed", e);
        }
    }

    renderUI(panel) {
        const html = `
            <div class="pm-container">
                <div class="pm-header">
                    <h1 style="margin: 0;">Plugins Manager</h1>
                </div>
                
                <div class="pm-tabs">
                    <div class="pm-tab active" data-tab="global" title="Plugins"><span class="pm-tab-icon">🔌</span><span class="pm-tab-label">Plugins</span></div>
                    <div class="pm-tab" data-tab="collections" title="Collections"><span class="pm-tab-icon">📁</span><span class="pm-tab-label">Collections</span></div>
                    <div class="pm-tab" data-tab="themes" title="Themes"><span class="pm-tab-icon">🎨</span><span class="pm-tab-label">Themes</span></div>
                    <div class="pm-tab" data-tab="discover" title="Discover"><span class="pm-tab-icon">🔍</span><span class="pm-tab-label">Discover</span></div>
                    <div class="pm-tab" data-tab="settings" title="Settings"><span class="pm-tab-icon">⚙️</span><span class="pm-tab-label">Settings</span></div>
                </div>

                <div class="pm-tab-content active" id="tab-global">
                    <div class="pm-tab-actions">
                        <button class="pm-btn primary" id="pm-install-global-btn">Install Global Plugin</button>
                        <button class="pm-btn" id="pm-import-global-btn">Import Plugins</button>
                        <button class="pm-btn" id="pm-export-global-btn">Export Plugins</button>
                    </div>
                    <div id="pm-global-list" class="pm-list-container">Loading...</div>
                </div>

                <div class="pm-tab-content" id="tab-collections">
                    <div class="pm-tab-actions">
                        <button class="pm-btn primary" id="pm-install-col-btn">Install Collection Plugin</button>
                        <button class="pm-btn" id="pm-import-col-btn">Import Collections</button>
                        <button class="pm-btn" id="pm-export-col-btn">Export Collections</button>
                    </div>
                    <div id="pm-collections-list" class="pm-list-container">Loading...</div>
                </div>

                
                
                <div class="pm-tab-content" id="tab-discover">
                    <div class="pm-tab-actions" style="flex-wrap: wrap; gap: 10px; align-items: center;">
                        <input type="text" id="pm-discover-search" class="pm-input pm-search-input" placeholder="Search plugins, themes..." autocomplete="off" />
                        <div class="pm-filter-chips">
                            <button class="pm-filter-chip active" data-filter="all">All</button>
                            <button class="pm-filter-chip" data-filter="app">Plugins</button>
                            <button class="pm-filter-chip" data-filter="collection">Collections</button>
                            <button class="pm-filter-chip" data-filter="theme">Themes</button>
                        </div>
                        <button class="pm-btn" id="pm-refresh-discover-btn">Refresh List</button>
                    </div>
                    <div id="pm-discover-list" class="pm-list-container">Loading...</div>
                </div>

                
                <div class="pm-tab-content" id="tab-themes">
                    <div class="pm-tab-actions">
                        <button class="pm-btn primary" id="pm-add-theme-github-btn">Add from GitHub</button>
                        <button class="pm-btn" id="pm-add-theme-manual-btn">Add Manually</button>
                        <button class="pm-btn" id="pm-export-all-themes-btn">Export All CSS</button>
                    </div>
                    <div id="pm-themes-list" class="pm-list-container"></div>
                </div>

                <div class="pm-tab-content" id="tab-settings">
                    <div class="pm-card" style="height: auto;">
                        <form style="width: 100%; margin: 0;" onsubmit="return false;">
                            <div class="pm-input-group">
                                <label>GitHub Personal Access Token (Optional)</label>
                                <p style="font-size: 13px; color: var(--text-color-secondary, #999); margin-bottom: 10px;">
                                    Provide a PAT to increase API rate limits when updating/importing many plugins.
                                </p>
                                <input type="password" id="pm-pat-input" class="pm-input" placeholder="ghp_xxxxxxxxxxxx" value="${this._escHtml(this.githubPat)}" autocomplete="off">
                            </div>
                            
                            <div class="pm-input-group" style="margin-top: 20px;">
                                <label>Community Repositories</label>
                                <p style="font-size: 13px; color: var(--text-color-secondary, #999); margin-bottom: 10px;">
                                    List of raw Markdown URLs (one per line) to discover community plugins and themes.
                                </p>
                                <textarea id="pm-repos-input" class="pm-textarea" style="min-height: 80px;" placeholder="https://raw.githubusercontent.com/.../README.md">${this._escHtml(this.communityRepos)}</textarea>
                            </div>

                            <div class="pm-input-group" style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--pm-border-default);">
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                                    <input type="checkbox" id="pm-auto-export-toggle" ${this._autoExportEnabled ? 'checked' : ''} />
                                    Auto-Export Backup on Changes
                                </label>
                                <p style="font-size: 13px; color: var(--text-color-secondary, #999); margin: 8px 0;">
                                    Automatically save a full JSON backup whenever plugins or collections are installed, updated, or deleted.
                                </p>
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <button type="button" class="pm-btn" id="pm-auto-export-dir-btn">Choose Directory</button>
                                    <span id="pm-auto-export-dir-label" style="font-size: 13px; color: var(--pm-text-muted);">${this._autoExportDirName ? '📁 ' + this._autoExportDirName : 'No directory selected'}</span>
                                </div>
                            </div>

                            <button type="button" class="pm-btn primary" id="pm-save-settings" style="margin-top: 20px;">Save Settings</button>
                        </form>
                    </div>
                </div>
            </div>
        `;

        const element = panel.getElement();
        if (element) {
            element.innerHTML = html;
            this.bindEvents(element, panel);
            this.loadPlugins(element);
            // Discover tab is loaded lazily on first click (see bindEvents)
        }
    }

    bindEvents(container, panel) {
        // Tabs
        container.querySelector('.pm-tabs').addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.pm-tab');
            if (!tabBtn) return;
            // Remove active classes
            container.querySelectorAll('.pm-tab').forEach(el => el.classList.remove('active'));
            container.querySelectorAll('.pm-tab-content').forEach(el => el.classList.remove('active'));

            // Add active class
            tabBtn.classList.add('active');
            const tabId = tabBtn.getAttribute('data-tab');
            container.querySelector(`#tab-${tabId}`).classList.add('active');

            // Lazy-load Discover tab on first click
            if (tabId === 'discover' && !this._discoverItems) {
                this.loadDiscoverPlugins(container);
            }

            if (tabId === 'global') this._renderGlobalList(container);
            else if (tabId === 'collections') this._renderCollectionsList(container);
            else if (tabId === 'discover') this._renderDiscoverList(container);
            else if (tabId === 'themes') this._renderThemesList(container);
        });

        // Responsive: toggle 'narrow' (icon tabs) and 'wide' (multi-col cards) based on container width
        const pmContainer = container.querySelector('.pm-container');
        if (pmContainer && window.ResizeObserver) {
            this._resizeObserver = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const w = entry.contentRect.width;
                    pmContainer.classList.toggle('narrow', w < 520);
                    pmContainer.classList.toggle('wide', w > 700);
                }
            });
            this._resizeObserver.observe(pmContainer);
        }

        // Settings
        container.querySelector('#pm-save-settings').addEventListener('click', async () => {
            const pat = container.querySelector('#pm-pat-input').value.trim();
            const repos = container.querySelector('#pm-repos-input').value.trim();
            this.communityRepos = repos;
            localStorage.setItem('pm_community_repos', repos);
            this.githubPat = pat;
            
            // To improve security, we save PAT in the plugin configuration
            const conf = this.getConfiguration();
            if (!conf.custom) conf.custom = {};
            conf.custom.githubPat = pat;
            
            // Backup to localstorage in case plugin API fails to save
            if (pat) {
                localStorage.setItem('pm_github_pat_persistent', pat);
            } else {
                localStorage.removeItem('pm_github_pat_persistent');
            }
            
            try {
                const plugin = this.data.getPluginByGuid(this.getGuid());
                if (plugin) {
                    await plugin.saveConfiguration(conf);
                } else if (typeof this.saveConfiguration === 'function') {
                    await this.saveConfiguration(conf);
                }
            } catch (e) {
                console.warn('[Plugins Manager] Failed to save PAT to config:', e);
            }

            if (localStorage.getItem('pm_github_pat')) {
                localStorage.removeItem('pm_github_pat');
            }

            const autoExport = container.querySelector('#pm-auto-export-toggle').checked;
            this._autoExportEnabled = autoExport;
            localStorage.setItem('pm_auto_export', autoExport ? 'true' : 'false');

            this.ui.addToaster({ title: "Settings Saved", dismissible: true, autoDestroyTime: 3000 });
        });

        // Auto-export directory picker
        container.querySelector('#pm-auto-export-dir-btn').addEventListener('click', async () => {
            try {
                if (!window.showDirectoryPicker) {
                    this.ui.addToaster({ title: "Not Supported", message: "Your browser does not support the File System Access API. Try Chrome or Edge.", autoDestroyTime: 5000, dismissible: true });
                    return;
                }
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                this._autoExportDirHandle = handle;
                this._autoExportDirName = handle.name;
                localStorage.setItem('pm_auto_export_dir_name', handle.name);
                await this._storeAutoExportHandle(handle);
                container.querySelector('#pm-auto-export-dir-label').textContent = '📁 ' + handle.name;
                // Auto-enable the toggle
                container.querySelector('#pm-auto-export-toggle').checked = true;
                this._autoExportEnabled = true;
                localStorage.setItem('pm_auto_export', 'true');
                this.ui.addToaster({ title: "Directory Set", message: `Backups will save to: ${handle.name}`, autoDestroyTime: 3000, dismissible: true });
            } catch (e) {
                if (e.name !== 'AbortError') {
                    this.ui.addToaster({ title: "Directory Selection Failed", message: e.message, autoDestroyTime: 4000, dismissible: true });
                }
            }
        });


        container.querySelector('#pm-refresh-discover-btn').addEventListener('click', () => {
            this.loadDiscoverPlugins(container);
        });

        // Discover search
        container.querySelector('#pm-discover-search').addEventListener('input', () => {
            this._filterDiscoverList(container);
        });

        // Discover filter chips
        container.querySelectorAll('.pm-filter-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                container.querySelectorAll('.pm-filter-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this._filterDiscoverList(container);
            });
        });


        container.querySelector('#pm-add-theme-github-btn').addEventListener('click', () => this._addThemeFromGithub(container));
        container.querySelector('#pm-add-theme-manual-btn').addEventListener('click', () => this._addThemeManually(container));
        container.querySelector('#pm-export-all-themes-btn').addEventListener('click', () => this._exportAllThemes());
        this._renderThemesList(container);

        // Actions
        container.querySelector('#pm-install-global-btn').addEventListener('click', () => this.showInstallDialog(container, 'app'));
        container.querySelector('#pm-import-global-btn').addEventListener('click', () => this.showImportDialog(container, 'app'));
        container.querySelector('#pm-export-global-btn').addEventListener('click', () => this.showExportDialog('app'));

        container.querySelector('#pm-install-col-btn').addEventListener('click', () => this.showInstallDialog(container, 'collection'));
        container.querySelector('#pm-import-col-btn').addEventListener('click', () => this.showImportDialog(container, 'collection'));
        container.querySelector('#pm-export-col-btn').addEventListener('click', () => this.showExportDialog('collection'));
    }


    async loadDiscoverPlugins(container) {
        const listContainer = container.querySelector('#pm-discover-list');
        listContainer.innerHTML = 'Fetching community plugins...';

        // Reset search and filters
        const searchInput = container.querySelector('#pm-discover-search');
        if (searchInput) searchInput.value = '';
        container.querySelectorAll('.pm-filter-chip').forEach(c => c.classList.remove('active'));
        const allChip = container.querySelector('.pm-filter-chip[data-filter="all"]');
        if (allChip) allChip.classList.add('active');

        try {
            const repos = this.communityRepos.split('\n').map(u => u.trim()).filter(Boolean);
            if (repos.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No community repositories configured in Settings.</p></div></div>';
                return;
            }

            const items = [];

            for (const repoUrl of repos) {
                try {
                    // Security: only fetch HTTPS URLs to prevent data exfiltration
                    if (!repoUrl.startsWith('https://')) {
                        console.warn('[Plugins Manager] Skipping non-HTTPS community repo:', repoUrl);
                        continue;
                    }

                    // Pre-flight check to ensure we aren't fetching a massive file
                    const headRes = await fetch(repoUrl, { method: 'HEAD' });
                    if (!headRes.ok) continue;

                    const contentType = headRes.headers.get('content-type') || '';
                    if (contentType && !contentType.includes('text/plain') && !contentType.includes('text/markdown')) {
                        console.warn('[Plugins Manager] Skipping repo with invalid content-type:', repoUrl);
                        continue;
                    }

                    const contentLength = headRes.headers.get('content-length');
                    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) { // 10MB limit
                        console.warn('[Plugins Manager] Skipping repo that is too large:', repoUrl);
                        continue;
                    }

                    const res = await fetch(repoUrl);
                    if (!res.ok) continue;
                    const text = await res.text();

                    const lines = text.split('\n');
                    let currentCategory = 'Other';
                    let foundPluginsSection = false;

                    for (let line of lines) {
                        line = line.trim();
                        if (line.startsWith('## Plugins') || line.startsWith('## Themes')) {
                            foundPluginsSection = true;
                        }
                        if (!foundPluginsSection) continue;

                        if (line.startsWith('## ') || line.startsWith('### ')) {
                            currentCategory = line.replace(/#/g, '').trim();
                        } else if (line.startsWith('- [')) {
                            const match = line.match(/- \[(.*?)\]\((.*?)\)(?: - (.*))?/);
                            if (match && match[2].startsWith('https://')) {
                                // Security: only accept HTTPS GitHub URLs in discover list
                                const itemUrl = match[2];
                                const catLower = currentCategory.toLowerCase();
                                let type = 'app';
                                if (catLower.includes('collection')) type = 'collection';
                                else if (catLower.includes('theme')) type = 'theme';

                                // For non-theme items, require valid GitHub URL
                                if (type !== 'theme' && !this._isValidGithubUrl(itemUrl)) continue;

                                items.push({
                                    name: match[1],
                                    url: itemUrl,
                                    description: match[3] || '',
                                    category: currentCategory,
                                    type: type,
                                    sourceRepo: repoUrl
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error fetching discover repo", repoUrl, e);
                }
            }

            // Store items for filtering
            this._discoverItems = items;

            if (items.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No plugins found in the configured community repositories.</p></div></div>';
                return;
            }

            await this._renderDiscoverCards(container, items);

        } catch (err) {
            console.error(err);
            listContainer.innerHTML = "Error loading community plugins.";
        }
    }

    async _filterDiscoverList(container) {
        if (!this._discoverItems) return;

        const searchInput = container.querySelector('#pm-discover-search');
        const activeChip = container.querySelector('.pm-filter-chip.active');
        const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();
        const filterType = activeChip ? activeChip.dataset.filter : 'all';

        let filtered = this._discoverItems;

        // Apply category filter
        if (filterType !== 'all') {
            filtered = filtered.filter(item => item.type === filterType);
        }

        // Apply search filter
        if (searchTerm) {
            filtered = filtered.filter(item => {
                return item.name.toLowerCase().includes(searchTerm) ||
                    item.description.toLowerCase().includes(searchTerm) ||
                    item.category.toLowerCase().includes(searchTerm);
            });
        }

        await this._renderDiscoverCards(container, filtered);
    }

    async _renderDiscoverCards(container, items) {
        const listContainer = container.querySelector('#pm-discover-list');
        listContainer.innerHTML = '';

        // Build a set of installed plugin source URLs and names for quick lookup
        const installedSet = new Set();
        try {
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            [...allGlobals, ...allCollections].forEach(p => {
                try {
                    const conf = p.getExistingCodeAndConfig().json;
                    if (conf.__source_repo) installedSet.add(conf.__source_repo);
                    if (conf.name) installedSet.add(conf.name.toLowerCase());
                } catch (e) { /* skip */ }
            });
        } catch (e) { /* couldn't read installed plugins, proceed without */ }

        if (items.length === 0) {
            listContainer.innerHTML = '<div class="pm-card pm-empty-state"><div class="pm-card-info"><p>No matching plugins or themes found.</p></div></div>';
            return;
        }

        items.forEach(item => {
            const isCollection = item.type === 'collection';
            const isTheme = item.type === 'theme';
            const badgeText = isTheme ? 'Theme' : (isCollection ? 'Collection' : 'Plugin');
            const badgeClass = isTheme ? 'pm-badge-theme' : (isCollection ? 'pm-badge-collection' : 'pm-badge-plugin');

            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>
                        ${this._escHtml(item.name)} 
                        <span class="pm-badge ${badgeClass}">${badgeText}</span>
                    </h3>
                    <p>${this._escHtml(item.description)}</p>
                    <p style="margin-top: 5px; font-size: 11px;"><a href="${this._escHtml(item.url)}" target="_blank" rel="noopener noreferrer">${this._escHtml(item.url)}</a></p>
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actionsContainer = card.querySelector('.pm-card-actions');

            const previewBtn = document.createElement('button');
            previewBtn.className = 'pm-btn';
            previewBtn.innerText = 'Preview';
            previewBtn.style.marginRight = '5px';

            previewBtn.addEventListener('click', () => {
                this.previewTheme(item.url);
            });

            if (isTheme) {
                actionsContainer.appendChild(previewBtn);
            }

            // Check if plugin is on the incompatible list
            const isIncompatible = !!this._incompatiblePlugins[item.url];
            const isInstalled = !isTheme && (installedSet.has(item.url) || installedSet.has(item.name.toLowerCase()));

            const installBtn = document.createElement('button');
            if (isIncompatible) {
                installBtn.className = 'pm-btn';
                installBtn.innerText = 'Incompatible';
                installBtn.disabled = true;
                installBtn.style.opacity = '0.5';
            } else if (isTheme) {
                const isSavedTheme = this._savedThemes.some(t => t.source === item.url || t.name === item.name);
                installBtn.className = isSavedTheme ? 'pm-btn' : 'pm-btn primary';
                installBtn.innerText = isSavedTheme ? 'Re-Save Theme' : 'Save Theme';
            } else if (isInstalled) {
                installBtn.className = 'pm-btn';
                installBtn.innerText = 'Reinstall';
            } else {
                installBtn.className = 'pm-btn primary';
                installBtn.innerText = 'Install';
            }

            // If incompatible, add a Recheck button first
            if (isIncompatible) {
                const recheckBtn = document.createElement('button');
                recheckBtn.className = 'pm-btn';
                recheckBtn.innerText = 'Recheck';
                recheckBtn.style.marginRight = '5px';
                recheckBtn.addEventListener('click', async () => {
                    recheckBtn.innerText = 'Checking...';
                    recheckBtn.disabled = true;
                    try {
                        if (isTheme) {
                            await this._fetchThemeCSS(item.url);
                        } else {
                            await this.fetchGithubRepo(item.url);
                        }
                        // Success — remove from incompatible list
                        delete this._incompatiblePlugins[item.url];
                        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
                        this.ui.addToaster({ title: "Compatible!", message: `${item.name} is now available to install.`, autoDestroyTime: 3000, dismissible: true });
                        this._renderDiscoverCards(container, items);
                    } catch (e) {
                        this.ui.addToaster({ title: "Still Incompatible", message: e.message, autoDestroyTime: 4000, dismissible: true });
                        recheckBtn.innerText = 'Recheck';
                        recheckBtn.disabled = false;
                    }
                });
                actionsContainer.appendChild(recheckBtn);
            }

            actionsContainer.appendChild(installBtn);

            if (!isIncompatible) {
                installBtn.addEventListener('click', async () => {
                    const originalText = installBtn.innerText;
                    installBtn.innerText = isTheme ? 'Fetching...' : 'Installing...';
                    installBtn.disabled = true;

                    try {
                        if (isTheme) {
                            const cssText = this._sanitizeCSS(await this._fetchThemeCSS(item.url));
                            const existingIdx = this._savedThemes.findIndex(t => t.source === item.url || t.name === item.name);

                            if (existingIdx > -1) {
                                this._savedThemes[existingIdx].css = cssText;
                                this._savedThemes[existingIdx].date = new Date().toISOString();
                            } else {
                                this._savedThemes.push({
                                    id: Date.now().toString(36),
                                    name: item.name,
                                    css: cssText,
                                    source: item.url,
                                    date: new Date().toISOString()
                                });
                            }
                            this._saveThemes();
                            this._autoExport();
                            this.ui.addToaster({ title: "Theme Saved!", message: `Saved "${item.name}" to your Theme Library.`, autoDestroyTime: 4000, dismissible: true });

                            installBtn.className = 'pm-btn';
                            installBtn.innerText = 'Saved';
                        } else {
                            const { json, js, css } = await this.fetchGithubRepo(item.url);
                            await this.installPlugin(json, js, { interactive: false, cssCode: css });
                            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
                            installBtn.innerText = 'Installed';
                            this.loadPlugins(container);
                        }
                    } catch (err) {
                        // Add to incompatible list
                        this._incompatiblePlugins[item.url] = { name: item.name, error: err.message, date: new Date().toISOString() };
                        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
                        this.ui.addToaster({ title: "Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
                        // Re-render respecting current filter/search state
                        this._filterDiscoverList(container);
                    }
                });
            }

            listContainer.appendChild(card);
        });
    }

    async loadPlugins(container) {
        try {
            const globals = await this.data.getAllGlobalPlugins();
            const collections = await this.data.getAllCollections();

            this.renderPluginList(container, 'pm-global-list', globals, 'app');
            this.renderPluginList(container, 'pm-collections-list', collections, 'collection');
        } catch (err) {
            console.error(err);
            container.querySelector('#pm-global-list').innerHTML = "Error loading plugins.";
            container.querySelector('#pm-collections-list').innerHTML = "Error loading collections.";
        }
    }

    _saveDisabledPlugins() {
        localStorage.setItem('pm_disabled_plugins', JSON.stringify(this._disabledPlugins || {}));
    }

    _getDisabledPluginsForType(typeFilter) {
        const allDisabled = Object.values(this._disabledPlugins || {});
        return allDisabled.filter(item => {
            if (!item || !item.sourceRepo) return false;
            const type = (item.type || '').toLowerCase();
            const normalized = (type === 'global' || type === 'app') ? 'app' : (type === 'collection' ? 'collection' : 'app');
            return normalized === typeFilter;
        });
    }

    async _disablePlugin(pluginObj, conf, panelContainer) {
        const sourceRepo = conf.__source_repo;
        if (!sourceRepo) {
            this.ui.addToaster({
                title: 'Cannot Disable',
                message: 'Only plugins linked to a GitHub source can be disabled and re-enabled.',
                autoDestroyTime: 5000,
                dismissible: true
            });
            return;
        }

        const pluginName = conf.name || 'this plugin';
        if (!confirm(`Disable ${pluginName}?\n\nThis removes it from the official Plugins panel. You can re-enable it later from Plugins Manager.`)) {
            return;
        }

        const rawType = (conf.type || '').toLowerCase();
        const normalizedType = (rawType === 'collection') ? 'collection' : 'app';

        this._disabledPlugins[sourceRepo] = {
            name: conf.name || 'Unnamed Plugin',
            type: normalizedType,
            sourceRepo,
            sourceFiles: conf.__source_files || null,
            version: conf.version || conf.ver || '',
            dateDisabled: new Date().toISOString()
        };
        this._saveDisabledPlugins();

        await pluginObj.trashPlugin();
        this._autoExport();
        this.ui.addToaster({ title: 'Plugin disabled', message: `${pluginName} can be re-enabled anytime.`, dismissible: true, autoDestroyTime: 3500 });
        this.loadPlugins(panelContainer);
    }

    async _enableDisabledPlugin(disabledPlugin, panelContainer, enableBtn) {
        const sourceRepo = disabledPlugin.sourceRepo;
        try {
            enableBtn.innerHTML = '';
            enableBtn.appendChild(this.ui.createIcon('loader'));
            enableBtn.disabled = true;

            const { json, js, css } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: disabledPlugin.sourceFiles });
            await this.installPlugin(json, js, { interactive: false, cssCode: css });

            delete this._disabledPlugins[sourceRepo];
            this._saveDisabledPlugins();

            this.ui.addToaster({ title: 'Plugin enabled', message: `${json.name || disabledPlugin.name} reinstalled.`, dismissible: true, autoDestroyTime: 3500 });
            this.loadPlugins(panelContainer);
        } catch (e) {
            enableBtn.innerHTML = '';
            enableBtn.innerHTML = '<span class="pm-state-icon" aria-hidden="true">●</span>';
            enableBtn.disabled = false;
            this.ui.addToaster({ title: 'Enable Failed', message: e.message, dismissible: true, autoDestroyTime: 5000 });
        }
    }

    _renderDisabledPluginCards(panelContainer, container, typeFilter) {
        const disabledPlugins = this._getDisabledPluginsForType(typeFilter);
        if (disabledPlugins.length === 0) return;

        disabledPlugins.forEach(disabled => {
            const disabledDate = disabled.dateDisabled ? new Date(disabled.dateDisabled).toLocaleDateString() : 'Unknown date';
            const card = document.createElement('div');
            card.className = 'pm-card pm-card-disabled';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>
                        ${this._escHtml(disabled.name || 'Unnamed Plugin')}
                        <span class="pm-badge">Disabled</span>
                    </h3>
                    <p>Disabled on ${this._escHtml(disabledDate)}. Re-enable to reinstall in the official Plugins panel.</p>
                    ${disabled.sourceRepo ? `<p style="margin-top: 5px; font-size: 11px;"><a href="${this._escHtml(disabled.sourceRepo)}" target="_blank" rel="noopener noreferrer">${this._escHtml(disabled.sourceRepo)}</a></p>` : ''}
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actionsContainer = card.querySelector('.pm-card-actions');
            const enableBtn = document.createElement('button');
            enableBtn.className = 'pm-btn pm-btn-enable';
            enableBtn.title = 'Disabled plugin — click to enable (reinstall)';
            enableBtn.setAttribute('aria-label', 'Disabled plugin. Click to enable and reinstall');
            enableBtn.innerHTML = '<span class="pm-state-icon" aria-hidden="true">●</span>';
            actionsContainer.appendChild(enableBtn);

            enableBtn.addEventListener('click', () => this._enableDisabledPlugin(disabled, panelContainer, enableBtn));
            container.appendChild(card);
        });
    }

    renderPluginList(panelContainer, containerId, plugins, typeFilter) {
        const container = panelContainer.querySelector(`#${containerId}`);
        container.innerHTML = '';

        if (plugins.length === 0 && this._getDisabledPluginsForType(typeFilter).length === 0) {
            container.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No items found.</p></div></div>';
            return;
        }

        plugins.forEach(p => {
            let conf;
            try {
                // For global plugins, getExistingCodeAndConfig works. CollectionPlugin might need getConfiguration()
                // The SDK types suggest getExistingCodeAndConfig is on PluginPluginAPIBase which both extend.
                const codeAndConfig = p.getExistingCodeAndConfig();
                conf = codeAndConfig.json;
            } catch (e) {
                // Fallback
                conf = { name: "Unknown", version: "Unknown" };
            }

            const sourceRepo = conf.__source_repo || '';
            const isLocal = !sourceRepo;

            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3 id="pm-title-${p.getGuid()}">
                        ${this._escHtml(conf.name || 'Unnamed Plugin')} 
                        <span class="pm-badge" id="pm-badge-type-${p.getGuid()}"></span>
                        <span class="pm-badge pm-version-badge" id="vbadge-${p.getGuid()}">v${this._escHtml(conf.version || conf.ver || '0.0.0')}</span>
                    </h3>
                    <p>${this._escHtml(conf.description || 'No description')}</p>
                    ${sourceRepo ? `<p style="margin-top: 5px; font-size: 11px;"><a href="${this._escHtml(sourceRepo)}" target="_blank" rel="noopener noreferrer">${this._escHtml(sourceRepo)}</a></p>` : ''}
                </div>
                <div class="pm-card-actions"></div>
            `;

            // Add native Type Badges
            const typeBadge = card.querySelector(`#pm-badge-type-${p.getGuid()}`);
            if (isLocal) {
                typeBadge.appendChild(this.ui.createIcon('box'));
                typeBadge.appendChild(document.createTextNode(' Local'));
            } else {
                typeBadge.appendChild(this.ui.createIcon('cloud'));
                typeBadge.appendChild(document.createTextNode(' GitHub'));
            }

            const actionsContainer = card.querySelector('.pm-card-actions');

            // Add Native Update Button
            let updateBtn = null;
            if (sourceRepo) {
                updateBtn = document.createElement('button');
                updateBtn.className = 'pm-btn pm-btn-update';
                updateBtn.title = 'Check Update';
                updateBtn.appendChild(this.ui.createIcon('refresh'));
                actionsContainer.appendChild(updateBtn);

                updateBtn.addEventListener('click', () => this.checkAndUpdatePlugin(p, conf, sourceRepo, updateBtn, panelContainer));

                // Reinstall button — force re-download from source without version check
                const reinstallBtn = document.createElement('button');
                reinstallBtn.className = 'pm-btn pm-btn-reinstall';
                reinstallBtn.title = 'Reinstall from source (force overwrite)';
                reinstallBtn.appendChild(this.ui.createIcon('download'));
                actionsContainer.appendChild(reinstallBtn);

                reinstallBtn.addEventListener('click', async () => {
                    if (!confirm(`Reinstall ${conf.name} from source?\n\nThis will overwrite local code with the latest from GitHub, even if the version number hasn't changed.`)) return;
                    try {
                        reinstallBtn.innerHTML = '';
                        reinstallBtn.appendChild(this.ui.createIcon('loader'));
                        reinstallBtn.disabled = true;

                        const { json: remoteJson, js: remoteJs, css: remoteCss } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: conf.__source_files });
                        this._validatePluginJS(remoteJson.name, remoteJs);
                        const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                        await p.savePlugin(sanitizedConf, remoteJs);
                        if (remoteCss) {
                            const sanitizedCSS = this._sanitizeCSS(remoteCss);
                            await p.saveCSS(sanitizedCSS);
                        }
                        this._autoExport();
                        this.ui.addToaster({ title: 'Reinstalled', message: `${conf.name} has been reinstalled from source.`, autoDestroyTime: 3000, dismissible: true });
                        this.loadPlugins(panelContainer);
                    } catch (e) {
                        this.ui.addToaster({ title: 'Reinstall Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
                        reinstallBtn.innerHTML = '';
                        reinstallBtn.appendChild(this.ui.createIcon('download-cloud'));
                        reinstallBtn.disabled = false;
                    }
                });
            }

            // Always offer to link or edit a GitHub repo for updates
            const linkBtn = document.createElement('button');
            linkBtn.className = 'pm-btn';
            linkBtn.title = sourceRepo ? 'Edit GitHub repo link' : 'Link to a GitHub repo for updates';
            linkBtn.appendChild(this.ui.createIcon('link'));
            actionsContainer.appendChild(linkBtn);

            linkBtn.addEventListener('click', async () => {
                const repoUrl = prompt('Enter the GitHub repo URL for this plugin:', sourceRepo || '');
                if (repoUrl === null) return; // cancelled
                if (repoUrl === '') {
                    // Remove link
                    if (!confirm('Clear the repository link? This will disable updates.')) return;
                } else if (!this._isValidGithubUrl(repoUrl)) {
                    this.ui.addToaster({ title: 'Invalid URL', message: 'Please enter a valid github.com URL.', autoDestroyTime: 4000, dismissible: true });
                    return;
                }

                try {
                    const { json: currentJson, code: currentCode } = p.getExistingCodeAndConfig();
                    currentJson.__source_repo = repoUrl;
                    await p.savePlugin(currentJson, currentCode);
                    this.ui.addToaster({ title: 'Repo Updated', message: repoUrl ? `${conf.name} linked to ${repoUrl}.` : `${conf.name} link removed.`, autoDestroyTime: 4000, dismissible: true });
                    this.loadPlugins(panelContainer);
                } catch (e) {
                    this.ui.addToaster({ title: 'Update Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
                }
            });

            // Add Native Delete Button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'pm-btn danger pm-btn-delete';
            deleteBtn.title = 'Delete Plugin';
            deleteBtn.appendChild(this.ui.createIcon('trash')); // trash usually exists in Thymer/Lucide
            actionsContainer.appendChild(deleteBtn);

            deleteBtn.addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete ${conf.name}?`)) {
                    await p.trashPlugin();
                    this._autoExport(); // fire-and-forget
                    this.ui.addToaster({ title: "Plugin deleted", dismissible: true, autoDestroyTime: 3000 });
                    this.loadPlugins(panelContainer);
                }
            });

            // Add Disable button (GitHub-linked plugins only)
            const disableBtn = document.createElement('button');
            disableBtn.className = 'pm-btn pm-btn-disable';
            disableBtn.title = sourceRepo ? 'Enabled plugin — click to disable (remove from Plugins panel)' : 'Link this plugin to GitHub first to enable disable/re-enable';
            disableBtn.setAttribute('aria-label', sourceRepo ? 'Enabled plugin. Click to disable and remove from Plugins panel' : 'Disable unavailable until this plugin is linked to GitHub');
            disableBtn.innerHTML = '<span class="pm-state-icon" aria-hidden="true">●</span>';
            disableBtn.disabled = !sourceRepo;
            actionsContainer.appendChild(disableBtn);

            disableBtn.addEventListener('click', async () => {
                if (!sourceRepo) return;
                await this._disablePlugin(p, conf, panelContainer);
            });

            container.appendChild(card);
        });

        this._renderDisabledPluginCards(panelContainer, container, typeFilter);
    }


    // --- Theme Library ---

    async _saveThemes() {
        const conf = this.getConfiguration();
        if (!conf.custom) conf.custom = {};
        conf.custom.saved_themes = this._savedThemes;
        const plugin = this.data.getPluginByGuid(this.getGuid());
        if (plugin) {
            await plugin.saveConfiguration(conf);
        }
    }

    _renderThemesList(container) {
        const list = container.querySelector('#pm-themes-list');
        if (!list) return;

        if (this._savedThemes.length === 0) {
            list.innerHTML = `
                <div class="pm-card" style="height: auto;">
                    <div class="pm-card-info">
                        <p>No themes saved yet. Use <strong>Add from GitHub</strong> to fetch a theme CSS from a repository, or <strong>Add Manually</strong> to paste your own CSS.</p>
                        <p style="margin-top: 8px; font-size: 12px; color: var(--pm-text-muted);">Once saved, use <strong>Export All CSS</strong> to copy the combined CSS into Thymer's <strong>Edit Theme CSS</strong> setting.</p>
                    </div>
                </div>`;
            return;
        }

        list.innerHTML = '';
        this._savedThemes.forEach((theme, idx) => {
            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>${this._escHtml(theme.name)}
                        <span class="pm-badge pm-version-badge">${theme.source ? 'GitHub' : 'Manual'}</span>
                    </h3>
                    <p style="font-size: 12px; color: var(--pm-text-muted);">
                        ${theme.css.length} chars · Added ${new Date(theme.date).toLocaleDateString()}
                        ${theme.source ? ` · <a href="${this._escHtml(theme.source)}" target="_blank" rel="noopener noreferrer">${this._escHtml(theme.source)}</a>` : ''}
                    </p>
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actions = card.querySelector('.pm-card-actions');

            // Copy CSS button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'pm-btn';
            copyBtn.title = 'Copy this theme CSS to clipboard';
            copyBtn.appendChild(this.ui.createIcon('copy'));
            actions.appendChild(copyBtn);
            copyBtn.addEventListener('click', async () => {
                await navigator.clipboard.writeText(theme.css);
                this.ui.addToaster({ title: 'Copied!', message: `${theme.name} CSS copied to clipboard.`, autoDestroyTime: 3000, dismissible: true });
            });

            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'pm-btn';
            editBtn.title = 'Edit theme';
            editBtn.appendChild(this.ui.createIcon('edit'));
            actions.appendChild(editBtn);
            editBtn.addEventListener('click', () => {
                this._showEditThemeDialog(container, idx);
            });

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'pm-btn danger pm-btn-delete';
            delBtn.title = 'Remove theme';
            delBtn.appendChild(this.ui.createIcon('x'));
            actions.appendChild(delBtn);
            delBtn.addEventListener('click', () => {
                if (confirm(`Remove theme "${theme.name}"?`)) {
                    this._savedThemes.splice(idx, 1);
                    this._saveThemes();
                    this._autoExport();
                    this._renderThemesList(container);
                }
            });

            list.appendChild(card);
        });
    }

    async _addThemeFromGithub(container) {
        const url = prompt('Enter the GitHub repo URL for the theme:');
        if (!url) return;

        this.ui.addToaster({ title: 'Fetching theme CSS...', autoDestroyTime: 2000, dismissible: true });

        try {
            const cssText = this._sanitizeCSS(await this._fetchThemeCSS(url));
            const { owner, repo } = this._parseGithubUrl(url);
            const name = prompt('Name this theme:', repo || 'My Theme');
            if (!name) return;

            this._savedThemes.push({
                id: Date.now().toString(36),
                name,
                css: cssText,
                source: url,
                date: new Date().toISOString()
            });
            this._saveThemes();
            this._autoExport();
            this._renderThemesList(container);
            this.ui.addToaster({ title: 'Theme Saved', message: `"${name}" added to your theme library.`, autoDestroyTime: 3000, dismissible: true });
        } catch (fetchErr) {
            // CSS not auto-detected → fall back to manual paste modal
            this._showManualThemePasteDialog(container, url, fetchErr.message);
        }
    }

    _addThemeManually(container) {
        this._showManualThemePasteDialog(container, null, null);
    }

    _showManualThemePasteDialog(container, sourceUrl, errorMsg) {
        let defaultName = 'My Theme';
        let repoLinkHtml = '';
        if (sourceUrl) {
            try {
                const { repo } = this._parseGithubUrl(sourceUrl);
                if (repo) defaultName = repo;
                repoLinkHtml = `<p style="font-size: 13px; margin-bottom: 10px;">
                                    <a href="${this._escHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">
                                        Open repository in new tab to find the CSS
                                    </a>
                                </p>`;
            } catch (e) { /* ignore parse error */ }
        }

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content">
                    <h3>${sourceUrl ? 'CSS Not Auto-Detected' : 'Add Theme Manually'}</h3>
                    ${errorMsg ? `<p style="font-size: 13px; color: var(--pm-text-muted); margin-bottom: 5px;">Could not auto-detect CSS: ${this._escHtml(errorMsg)}<br>Paste the theme CSS below instead.</p>` : ''}
                    ${repoLinkHtml}
                    <div class="pm-input-group" style="margin-bottom: 10px;">
                        <label>Theme Name</label>
                        <input type="text" id="pm-manual-theme-name" class="pm-input" value="${this._escHtml(defaultName)}" placeholder="My Theme" />
                    </div>
                    <textarea id="pm-manual-theme-css" class="pm-textarea" placeholder="Paste your theme CSS here..."></textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-manual-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-manual-theme-save">Save Theme</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);

        tempDiv.querySelector('#pm-manual-theme-cancel').addEventListener('click', () => document.body.removeChild(tempDiv));
        tempDiv.querySelector('#pm-manual-theme-save').addEventListener('click', () => {
            const name = tempDiv.querySelector('#pm-manual-theme-name').value.trim();
            const css = tempDiv.querySelector('#pm-manual-theme-css').value.trim();
            if (!name || !css) {
                this.ui.addToaster({ title: 'Missing Fields', message: 'Please provide both a name and CSS.', autoDestroyTime: 3000, dismissible: true });
                return;
            }
            this._savedThemes.push({
                id: Date.now().toString(36),
                name,
                css,
                source: sourceUrl || '',
                date: new Date().toISOString()
            });
            this._saveThemes();
            this._autoExport();
            document.body.removeChild(tempDiv);
            this._renderThemesList(container);
            this.ui.addToaster({ title: 'Theme Saved', message: `"${name}" added to your theme library.`, autoDestroyTime: 3000, dismissible: true });
        });
    }

    _showEditThemeDialog(container, idx) {
        const theme = this._savedThemes[idx];
        if (!theme) return;

        const sourceUrl = theme.source || '';
        let repoLinkHtml = '';
        if (sourceUrl) {
            repoLinkHtml = `<p style="font-size: 13px; margin-bottom: 10px;">
                                <a href="${this._escHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">
                                    Open repository in new tab
                                </a>
                            </p>`;
        }

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Edit Theme</h3>
                    ${repoLinkHtml}
                    <div class="pm-input-group" style="margin-bottom: 10px;">
                        <label>Theme Name</label>
                        <input type="text" id="pm-edit-theme-name" class="pm-input" value="${this._escHtml(theme.name)}" placeholder="My Theme" />
                    </div>
                    <textarea id="pm-edit-theme-css" class="pm-textarea" placeholder="Paste your theme CSS here...">${this._escHtml(theme.css)}</textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-edit-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-edit-theme-save">Save Changes</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);

        tempDiv.querySelector('#pm-edit-theme-cancel').addEventListener('click', () => document.body.removeChild(tempDiv));
        tempDiv.querySelector('#pm-edit-theme-save').addEventListener('click', () => {
            const name = tempDiv.querySelector('#pm-edit-theme-name').value.trim();
            const css = tempDiv.querySelector('#pm-edit-theme-css').value.trim();
            if (!name || !css) {
                this.ui.addToaster({ title: 'Missing Fields', message: 'Please provide both a name and CSS.', autoDestroyTime: 3000, dismissible: true });
                return;
            }
            this._savedThemes[idx] = {
                ...this._savedThemes[idx],
                name,
                css,
                date: new Date().toISOString()
            };
            this._saveThemes();
            this._autoExport();
            document.body.removeChild(tempDiv);
            this._renderThemesList(container);
            this.ui.addToaster({ title: 'Theme Updated', message: `"${name}" has been updated.`, autoDestroyTime: 3000, dismissible: true });
        });
    }

    async _exportAllThemes() {
        if (this._savedThemes.length === 0) {
            this.ui.addToaster({ title: 'No Themes', message: 'No themes saved to export.', autoDestroyTime: 3000, dismissible: true });
            return;
        }
        const combined = this._savedThemes.map(t => `/* === ${t.name} === */\n${t.css}`).join('\n\n');

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Export All Themes</h3>
                    <p style="font-size: 13px; color: var(--pm-text-muted); margin-bottom: 10px;">Copy this combined CSS and paste it into Thymer's <strong>Edit Theme CSS</strong> setting.</p>
                    <textarea class="pm-textarea pm-textarea-json" id="pm-all-themes-css" readonly></textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-themes-export-copy">Copy to Clipboard</button>
                        <button class="pm-btn" id="pm-themes-export-download">Download .css</button>
                        <button class="pm-btn primary" id="pm-themes-export-close">Close</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);
        tempDiv.querySelector('#pm-all-themes-css').value = combined;

        tempDiv.querySelector('#pm-themes-export-close').addEventListener('click', () => document.body.removeChild(tempDiv));

        tempDiv.querySelector('#pm-themes-export-copy').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(combined);
            const orig = e.target.innerText;
            e.target.innerText = 'Copied!';
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        tempDiv.querySelector('#pm-themes-export-download').addEventListener('click', () => {
            const blob = new Blob([combined], { type: 'text/css' });
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            const wsName = this._getWorkspaceName();
            const ts = this._getBackupTimestamp();
            a.download = `logseq-backup-themese-${wsName}-${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        });
    }


    async previewTheme(repoUrl) {
        try {
            const { owner, repo } = this._parseGithubUrl(repoUrl);
            if (!owner || !repo) return;

            // Fetch README directly from raw.githubusercontent.com to avoid CORS
            let content = '';
            for (const branch of ['main', 'master']) {
                try {
                    const readmeRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`);
                    if (readmeRes.ok) {
                        content = await readmeRes.text();
                        break;
                    }
                } catch (e) { /* try next branch */ }
            }

            if (!content) throw new Error("No README found");

            // Extract images from markdown
            const imgRegex = /!\[.*?\]\((.*?)\)|<img.*?src="(.*?)".*?>/g;
            const images = [];
            let imgMatch;
            while ((imgMatch = imgRegex.exec(content)) !== null) {
                const src = imgMatch[1] || imgMatch[2];
                if (src && src.startsWith('http')) {
                    images.push(src);
                }
            }

            if (images.length === 0) {
                this.ui.addToaster({ title: "No Previews", message: "No images found in the theme's README.", autoDestroyTime: 3000, dismissible: true });
                return;
            }

            const overlayHtml = `
                <div id="pm-theme-preview-modal" class="pm-modal">
                    <div class="pm-modal-content" style="width: 800px; max-height: 90vh; overflow-y: auto;">
                        <h3>Theme Preview</h3>
                        <div style="display: flex; flex-direction: column; gap: 15px; margin-top: 15px;">
                            ${images.filter(img => img.startsWith('https://')).map(img => `<img src="${this._escHtml(img)}" style="max-width: 100%; border-radius: 4px; border: 1px solid var(--pm-border-default);" />`).join('')}
                        </div>
                        <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
                            <button class="pm-btn primary" id="pm-close-preview">Close</button>
                        </div>
                    </div>
                </div>
            `;

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = overlayHtml;
            document.body.appendChild(tempDiv);

            document.getElementById('pm-close-preview').addEventListener('click', () => {
                document.body.removeChild(tempDiv);
            });

        } catch (e) {
            this.ui.addToaster({ title: "Preview Failed", message: "Could not load theme preview images.", autoDestroyTime: 3000, dismissible: true });
        }
    }

    /**
     * Fetch theme CSS using smart file discovery.
     */
    async _fetchThemeCSS(repoUrl) {
        const { owner, repo, subpath } = this._parseGithubUrl(repoUrl);
        if (!owner || !repo) throw new Error("Invalid GitHub URL.");

        const prefix = subpath ? `${subpath}/` : '';
        const cssFilenames = ['plugin.css', 'styles.css', 'theme.css', 'style.css', `${repo}-plugin.css`, 'Custom CSS'];

        // Strategy 1: Try common CSS filenames via raw.githubusercontent.com
        for (const branch of ['main', 'master']) {
            for (const filename of cssFilenames) {
                const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${prefix}${filename}`;
                try {
                    const res = await fetch(url);
                    if (res.ok) return await res.text();
                } catch (e) { /* try next */ }
            }
        }

        // Strategy 2: Use GitHub API to list directory and find CSS-like files
        try {
            const files = await this._listRepoDirectory(owner, repo, subpath);
            // First try the smart role-based finder
            const cssFile = this._findFileByRole(files, 'css');
            if (cssFile) {
                const res = await fetch(cssFile.download_url);
                if (res.ok) return await res.text();
            }
            // Fallback: if there's exactly one .css file in the repo, use it regardless of name
            const allCssFiles = files.filter(f => f.name && f.name.endsWith('.css'));
            if (allCssFiles.length === 1 && allCssFiles[0].download_url) {
                const res = await fetch(allCssFiles[0].download_url);
                if (res.ok) return await res.text();
            }
        } catch (e) { /* fall through */ }

        throw new Error("No CSS file found in this repository. You can paste the CSS manually instead.");
    }

    // --- Auto-Export ---

    /** Get a reusable export data array for all plugins + collections */
    async _getExportData() {
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();

        const globalsData = allGlobals.map(p => {
            try {
                const { json, code } = p.getExistingCodeAndConfig();
                return { name: json.name, type: json.type || 'app', version: json.version, source_repo: json.__source_repo, code, json };
            } catch (e) { return null; }
        });

        // Build a guid->name map for all collections (for filter_colguid annotation)
        const colGuidToName = {};
        for (const p of allCollections) {
            try {
                const lc = p.getConfiguration();
                const guid = p.getGuid ? p.getGuid() : null;
                if (guid && lc && lc.name) colGuidToName[guid] = lc.name;
            } catch (e) { }
        }

        const collectionsData = allCollections.map(p => {
            try {
                const { json, code } = p.getExistingCodeAndConfig();
                
                // Get the live configuration (which includes dynamically added properties and views)
                // and merge it with the base JSON from the file.
                let mergedJson = { ...json };
                try {
                    const liveConfig = p.getConfiguration();
                    if (liveConfig) {
                        // Merge all live collection schema fields over the static json
                        const schemaKeys = ['name', 'icon', 'color', 'item_name', 'description',
                            'show_sidebar_items', 'show_cmdpal_items', 'sidebar_action',
                            'fields', 'views', 'page_field_ids', 'sidebar_record_sort_field_id',
                            'sidebar_record_sort_dir', 'managed', 'home', 'related_query'];
                        for (const k of schemaKeys) {
                            if (liveConfig[k] !== undefined) mergedJson[k] = liveConfig[k];
                        }
                    }
                } catch (configErr) {
                    console.warn(`[Plugins Manager] Failed to get live config for collection ${json.name}:`, configErr);
                }

                // Annotate link-to-record fields with the target collection name
                // so the GUID can be remapped when importing into a different workspace
                if (Array.isArray(mergedJson.fields)) {
                    mergedJson.fields = mergedJson.fields.map(f => {
                        if (f.filter_colguid && colGuidToName[f.filter_colguid]) {
                            return { ...f, filter_colname: colGuidToName[f.filter_colguid] };
                        }
                        return f;
                    });
                }

                return { name: mergedJson.name, type: 'collection', version: mergedJson.version, source_repo: mergedJson.__source_repo, code, json: mergedJson };
            } catch (e) { return null; }
        });

        const sorted = this._topoSortCollections(collectionsData.filter(Boolean), colGuidToName);
        return [...globalsData, ...sorted];
    }

    /**
     * Topologically sort collection export items so that collections depended upon
     * (via link-to-record filter_colguid) appear before the collections that reference them.
     * Falls back to original order for any cycles or unresolvable references.
     */
    _topoSortCollections(items, colGuidToName) {
        // Build name->item index
        const byName = {};
        for (const item of items) {
            if (item && item.name) byName[item.name] = item;
        }

        // Build adjacency: for each collection, which collection names does it depend on?
        const deps = {};
        for (const item of items) {
            deps[item.name] = new Set();
            const fields = item.json && item.json.fields;
            if (Array.isArray(fields)) {
                for (const f of fields) {
                    const depName = f.filter_colname || (f.filter_colguid && colGuidToName[f.filter_colguid]);
                    if (depName && depName !== item.name && byName[depName]) {
                        deps[item.name].add(depName);
                    }
                }
            }
        }

        // Kahn's algorithm (BFS topological sort)
        const inDegree = {};
        const dependents = {}; // dep -> [items that depend on it]
        for (const item of items) {
            inDegree[item.name] = inDegree[item.name] || 0;
            dependents[item.name] = dependents[item.name] || [];
        }
        for (const item of items) {
            for (const dep of deps[item.name]) {
                inDegree[item.name] = (inDegree[item.name] || 0) + 1;
                dependents[dep] = dependents[dep] || [];
                dependents[dep].push(item.name);
            }
        }

        const queue = items.filter(item => (inDegree[item.name] || 0) === 0).map(i => i.name);
        const result = [];
        const visited = new Set();

        while (queue.length > 0) {
            const name = queue.shift();
            if (visited.has(name)) continue;
            visited.add(name);
            if (byName[name]) result.push(byName[name]);
            for (const dependent of (dependents[name] || [])) {
                inDegree[dependent] = (inDegree[dependent] || 1) - 1;
                if (inDegree[dependent] === 0) queue.push(dependent);
            }
        }

        // Append any remaining items not reached (cycles or isolated)
        for (const item of items) {
            if (!visited.has(item.name)) result.push(item);
        }

        return result;
    }

    /** Get the current workspace name from the hostname */
    _getWorkspaceName() {
        try {
            if (window.location && window.location.hostname) {
                const parts = window.location.hostname.split('.');
                if (parts.length > 0 && parts[0] !== 'localhost' && parts[0] !== '127') {
                    return parts[0];
                }
            }
        } catch (e) { }
        return 'workspace';
    }

    _getBackupTimestamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    _getBackupJsonFilename(section) {
        const wsName = this._getWorkspaceName();
        const ts = this._getBackupTimestamp();
        if (section === 'collection') {
            return `thymer-backup-collections-${wsName}-${ts}.json`;
        }
        if (section === 'theme') {
            return `logseq-backup-themese-${wsName}-${ts}.json`;
        }
        return `thymer-backup-plugins-${wsName}-${ts}.json`;
    }

    /** Auto-export full backup to chosen directory */
    async _autoExport() {
        if (!this._autoExportEnabled) return;
        if (!this._autoExportDirHandle) {
            console.warn('[Plugins Manager] Auto-export enabled but no directory handle available.');
            return;
        }
        try {
            // Re-verify permission (may prompt user once per session)
            const perm = await this._autoExportDirHandle.requestPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                console.warn('[Plugins Manager] Auto-export: write permission denied.');
                return;
            }
            const data = await this._getExportData();
            const jsonStr = JSON.stringify(data, null, 2);
            const filename = this._getBackupJsonFilename('app');
            const fileHandle = await this._autoExportDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(jsonStr);
            await writable.close();
            console.log(`[Plugins Manager] Auto-exported backup to ${this._autoExportDirName}/${filename}`);
        } catch (e) {
            console.error('[Plugins Manager] Auto-export failed:', e);
            this.ui.addToaster({ title: "Auto-Backup Failed", message: e.message, autoDestroyTime: 6000, dismissible: true });
        }
    }

    /** Store directory handle in IndexedDB for persistence across sessions */
    async _storeAutoExportHandle(handle) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('plugin-manager-db', 1);
            req.onupgradeneeded = (e) => { e.target.result.createObjectStore('handles'); };
            req.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction('handles', 'readwrite');
                tx.objectStore('handles').put(handle, 'autoExportDir');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** Restore directory handle from IndexedDB */
    async _restoreAutoExportHandle() {
        try {
            const handle = await new Promise((resolve, reject) => {
                const req = indexedDB.open('plugin-manager-db', 1);
                req.onupgradeneeded = (e) => { e.target.result.createObjectStore('handles'); };
                req.onsuccess = (e) => {
                    const db = e.target.result;
                    const tx = db.transaction('handles', 'readonly');
                    const getReq = tx.objectStore('handles').get('autoExportDir');
                    getReq.onsuccess = () => resolve(getReq.result || null);
                    getReq.onerror = () => reject(getReq.error);
                };
                req.onerror = () => reject(req.error);
            });
            if (handle) this._autoExportDirHandle = handle;
        } catch (e) {
            console.warn('[Plugins Manager] Could not restore auto-export directory handle:', e);
        }
    }

    // --- Utilities ---

    /** Validate JS code is compatible with Thymer's runtime before saving */
    _validatePluginJS(name, jsCode) {
        if (!jsCode) return;
        if (/^\s*import\s+/m.test(jsCode) || /^\s*export\s+/m.test(jsCode)) {
            throw new Error(`"${name || 'Unknown'}" uses ES module syntax (import/export) which is not compatible with Thymer's plugin system.`);
        }
        // Security: removed new Function(jsCode) — it compiles arbitrary code pre-install.
        // Thymer's own runtime will surface syntax errors when the plugin loads.
    }

    /** Security: Whitelist allowed plugin.json config keys and enforce size limits */
    _sanitizePluginConfig(jsonConf) {
        const ALLOWED_KEYS = ['name', 'type', 'description', 'version', 'icon', 'permissions', '__source_repo', '__source_files', 'ver'];
        const COLLECTION_SCHEMA_KEYS = ['color', 'item_name', 'show_sidebar_items', 'show_cmdpal_items',
            'sidebar_action', 'fields', 'views', 'page_field_ids', 'sidebar_record_sort_field_id',
            'sidebar_record_sort_dir', 'managed', 'home', 'related_query', 'default_banner'];
        const sanitized = {};
        for (const key of ALLOWED_KEYS) {
            if (jsonConf[key] !== undefined) {
                sanitized[key] = jsonConf[key];
            }
        }
        const isCollection = (jsonConf.type || '').toLowerCase() === 'collection';
        if (isCollection) {
            for (const key of COLLECTION_SCHEMA_KEYS) {
                if (jsonConf[key] !== undefined) {
                    sanitized[key] = jsonConf[key];
                }
            }
        }
        return sanitized;
    }

    /** Security: Strip dangerous CSS constructs that could exfiltrate data or execute scripts */
    _sanitizeCSS(cssText) {
        if (!cssText) return cssText;
        let sanitized = cssText;
        const warnings = [];

        // Strip @import rules (could load external resources/tracking pixels)
        if (/@import\s/i.test(sanitized)) {
            sanitized = sanitized.replace(/@import\s[^;]*;?/gi, '/* [removed @import] */');
            warnings.push('@import rules were removed for security');
        }

        // Strip expression() calls (IE script execution vector)
        if (/expression\s*\(/i.test(sanitized)) {
            sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '/* [removed expression()] */');
            warnings.push('expression() calls were removed for security');
        }

        // Warn about external url() references (don't block — legitimate for fonts)
        const externalUrls = sanitized.match(/url\s*\(\s*['"]?https?:\/\//gi);
        if (externalUrls && externalUrls.length > 0) {
            warnings.push(`${externalUrls.length} external url() reference(s) found — review these if you did not author this theme`);
        }

        if (warnings.length > 0) {
            this.ui.addToaster({
                title: 'CSS Security Notice',
                message: warnings.join('. ') + '.',
                autoDestroyTime: 6000,
                dismissible: true
            });
        }

        return sanitized;
    }

    /** Escape HTML entities to prevent XSS when injecting user-controlled strings into innerHTML */
    _escHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Validate that a URL points to github.com over HTTPS */
    _isValidGithubUrl(url) {
        return /^https:\/\/github\.com\/[^\/]+\/[^\/]+/.test(url);
    }

    // --- GitHub Utils ---

    /**
     * Parse a GitHub URL into owner, repo, and optional subpath.
     * Supports:
     *   https://github.com/user/repo
     *   https://github.com/user/repo/tree/branch/path/to/subfolder
     *   https://github.com/user/repo/tree/branch/path/to/file.json  (extracts parent dir)
     *   https://github.com/user/repo/blob/branch/path/to/file.json  (extracts parent dir)
     *   https://github.com/user/repo/releases  (strips to owner/repo)
     *   https://github.com/user/repo/issues, /pulls, /wiki, etc.
     */
    _parseGithubUrl(url) {
        // Normalize SSH URLs: git@github.com:user/repo.git → https://github.com/user/repo
        url = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
        // First, strip known GitHub page paths that don't point to code
        const githubPages = /\/(releases|issues|pulls|wiki|actions|settings|discussions|tags|commit|compare|security|projects|milestones|labels|pulse|graphs|network|community)(\/.*)?$/;
        const cleanUrl = url.replace(githubPages, '');

        // Match URLs with /tree/ or /blob/ paths
        const treeMatch = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^\/]+\/(.+?))?\/?\s*$/);
        if (!treeMatch) return { owner: null, repo: null, subpath: '' };

        let subpath = treeMatch[3] || '';

        // If subpath ends with a file extension, strip the filename to get its directory
        if (subpath && /\.[a-zA-Z0-9]+$/.test(subpath)) {
            const lastSlash = subpath.lastIndexOf('/');
            subpath = lastSlash > 0 ? subpath.substring(0, lastSlash) : '';
        }

        return {
            owner: treeMatch[1],
            repo: treeMatch[2],
            subpath: subpath
        };
    }

    /**
     * List files in a GitHub repository directory via the API.
     * Falls back through branches (main, master).
     */
    async _listRepoDirectory(owner, repo, subpath) {
        const apiHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.githubPat) apiHeaders['Authorization'] = `Bearer ${this.githubPat}`;

        const path = subpath || '';
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

        const res = await fetch(apiUrl, { headers: apiHeaders });
        if (!res.ok) throw new Error(`Could not list directory: ${owner}/${repo}/${path}`);

        const files = await res.json();
        if (!Array.isArray(files)) throw new Error("Path is not a directory");
        return files;
    }

    /**
     * Intelligently find a file by its role (json, js, css) from a directory listing.
     *
     * Priority order:
     * 1. Exact standard names: plugin.json, plugin.js, plugin.css
     * 2. Files with `-plugin` suffix: clock-plugin.json, clock-plugin.js
     * 3. Files with correct extension: *.json, *.js, *.css
     * 4. Extensionless Thymer export files by name heuristic:
     *    - json: "Config" or any file whose content parses as JSON
     *    - js:   "Custom Code" or file containing "extends AppPlugin"/"extends CollectionPlugin"
     *    - css:  "Custom CSS" or "Custom Style"
     */
    _findFileByRole(files, role) {
        const onlyFiles = files.filter(f => f.type === 'file');

        const extMap = { json: '.json', js: '.js', css: '.css' };
        const stdName = `plugin${extMap[role]}`;

        // 1. Exact standard name
        const exact = onlyFiles.find(f => f.name.toLowerCase() === stdName);
        if (exact) return exact;

        // 2. Files with *-plugin suffix
        const pluginSuffix = onlyFiles.find(f => f.name.toLowerCase().endsWith(`-plugin${extMap[role]}`));
        if (pluginSuffix) return pluginSuffix;

        // 3. Files with the correct extension
        const byExt = onlyFiles.filter(f => f.name.toLowerCase().endsWith(extMap[role]));
        if (byExt.length === 1) return byExt[0]; // Unambiguous single match
        // If multiple, prefer one containing 'plugin' in the name
        if (byExt.length > 1) {
            const withPlugin = byExt.find(f => f.name.toLowerCase().includes('plugin'));
            if (withPlugin) return withPlugin;
            return byExt[0]; // Fallback to first
        }

        // 4. Extensionless files by naming convention (e.g., Thymer export format)
        const nameHeuristics = {
            json: ['config'],
            js: ['custom code', 'code'],
            css: ['custom css', 'custom style', 'style', 'css']
        };

        const heuristic = nameHeuristics[role] || [];
        for (const hint of heuristic) {
            const match = onlyFiles.find(f => f.name.toLowerCase() === hint && !f.name.includes('.'));
            if (match) return match;
        }

        return null;
    }

    async _fetchGithubFile(owner, repo, branch, path) {
        // Use API when PAT is available (required for private repos), else raw URL
        if (this.githubPat) {
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
            const res = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${this.githubPat}`,
                    'Accept': 'application/vnd.github.v3.raw'
                }
            });
            if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
            return await res.text();
        }

        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
        const res = await fetch(rawUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
        return await res.text();
    }

    async fetchGithubRepo(url, { sourceFiles } = {}) {
        if (!this._isValidGithubUrl(url)) throw new Error("URL must point to github.com");
        const { owner, repo, subpath } = this._parseGithubUrl(url);
        if (!owner || !repo) throw new Error("Invalid GitHub URL. Expected format: https://github.com/user/repo");

        // PAT auth headers — only for api.github.com, NOT for raw.githubusercontent.com (triggers CORS preflight)
        const apiHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.githubPat) {
            apiHeaders['Authorization'] = `Bearer ${this.githubPat}`;
        }

        const prefix = subpath ? `${subpath}/` : '';
        const label = `${owner}/${repo}${subpath ? '/' + subpath : ''}`;

        // Helper: build __source_files metadata for caching discovered filenames
        const buildSourceFiles = (branch, jsonName, jsName, cssName) => {
            const sf = { branch, json: jsonName, js: jsName };
            if (cssName) sf.css = cssName;
            return sf;
        };

        // ----- Strategy 0: Use cached filenames from a previous discovery (fastest — no probing needed) -----
        if (sourceFiles && sourceFiles.branch && sourceFiles.json && sourceFiles.js) {
            try {
                const pluginJson = JSON.parse(await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.json}`));
                const pluginJs = await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.js}`);
                pluginJson.__source_repo = url;
                pluginJson.__source_files = buildSourceFiles(sourceFiles.branch, sourceFiles.json, sourceFiles.js, sourceFiles.css);
                const result = { json: pluginJson, js: pluginJs };
                if (sourceFiles.css) {
                    try {
                        result.css = await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.css}`);
                    } catch (e) { /* CSS is optional */ }
                }
                return result;
            } catch (e) { /* cached names failed, fall through to full discovery */ }
        }

        // ----- Strategy 1: Try common filename patterns via raw.githubusercontent.com (fast, no API needed) -----
        // Build candidate filename lists based on common conventions:
        //   - Standard: plugin.json / plugin.js
        //   - SDK pattern: {repo}-plugin.json / {repo}-plugin.js
        //   - Thymer export names (extensionless): Config / Custom Code
        const jsonCandidates = ['plugin.json', `${repo}-plugin.json`, 'Config'];
        const jsCandidates = ['plugin.js', `${repo}-plugin.js`, 'Custom Code'];

        for (const branch of ['main', 'master']) {
            // Try each JSON candidate until one responds OK
            let foundJson = null;
            let foundJsonName = null;
            for (const jsonName of jsonCandidates) {
                try {
                    const text = await this._fetchGithubFile(owner, repo, branch, `${prefix}${jsonName}`);
                    try {
                        foundJson = JSON.parse(text);
                        foundJsonName = jsonName;
                        break;
                    } catch (e) { /* not valid JSON, try next */ }
                } catch (e) { /* try next */ }
            }
            if (!foundJson) continue;

            // Try each JS candidate until one responds OK
            for (const jsName of jsCandidates) {
                try {
                    const pluginJs = await this._fetchGithubFile(owner, repo, branch, `${prefix}${jsName}`);
                    foundJson.__source_repo = url;

                    // Also try to grab CSS while we're here
                    const cssCandidates = ['plugin.css', 'styles.css', `${repo}-plugin.css`, 'Custom CSS'];
                    const result = { json: foundJson, js: pluginJs };
                    let foundCssName = null;
                    for (const cssName of cssCandidates) {
                        try {
                            result.css = await this._fetchGithubFile(owner, repo, branch, `${prefix}${cssName}`);
                            foundCssName = cssName;
                            break;
                        } catch (e) { /* CSS is optional */ }
                    }

                    // Cache the discovered filenames for future fetches
                    foundJson.__source_files = buildSourceFiles(branch, foundJsonName, jsName, foundCssName);
                    return result;
                } catch (e) { /* try next */ }
            }
        }

        // ----- Strategy 2: Use GitHub API to discover files in the directory -----
        let files;
        try {
            files = await this._listRepoDirectory(owner, repo, subpath);
        } catch (e) {
            throw new Error(`Could not find plugin files in ${label}. Standard names (plugin.json/plugin.js) not found, and directory listing failed.`);
        }

        // Find the JSON config file
        const jsonFile = this._findFileByRole(files, 'json');
        if (!jsonFile) throw new Error(`No config file (.json) found in ${label}`);

        // Find the JS code file
        const jsFile = this._findFileByRole(files, 'js');
        if (!jsFile) throw new Error(`No code file (.js) found in ${label}`);

        // Fetch the actual file contents
        const jsonRes = await fetch(jsonFile.download_url);
        if (!jsonRes.ok) throw new Error(`Failed to download ${jsonFile.name}`);

        let pluginJson;
        const jsonText = await jsonRes.text();
        try {
            pluginJson = JSON.parse(jsonText);
        } catch (e) {
            throw new Error(`${jsonFile.name} is not valid JSON`);
        }

        const jsRes = await fetch(jsFile.download_url);
        if (!jsRes.ok) throw new Error(`Failed to download ${jsFile.name}`);
        const pluginJs = await jsRes.text();

        // Optionally grab CSS
        const cssFile = this._findFileByRole(files, 'css');

        pluginJson.__source_repo = url;
        // Cache discovered filenames — detect branch from download_url
        const branchMatch = jsonFile.download_url && jsonFile.download_url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
        pluginJson.__source_files = buildSourceFiles(
            branchMatch ? branchMatch[1] : 'main',
            jsonFile.name,
            jsFile.name,
            cssFile ? cssFile.name : null
        );

        const result = { json: pluginJson, js: pluginJs };
        if (cssFile) {
            try {
                const cssRes = await fetch(cssFile.download_url);
                if (cssRes.ok) result.css = await cssRes.text();
            } catch (e) { /* CSS is optional */ }
        }

        return result;
    }

    // --- Core Features ---

    async showInstallDialog(container, typeFilter) {
        const url = prompt(`Enter GitHub URL for the ${typeFilter === 'app' ? 'Global Plugin' : 'Collection Plugin'} (e.g. https://github.com/user/repo):`);
        if (!url) return;

        try {
            this.ui.addToaster({ title: "Fetching plugin...", autoDestroyTime: 2000, dismissible: true });
            const { json, js, css } = await this.fetchGithubRepo(url);

            // Validate type
            let pType = json.type;
            if (!pType) {
                if (/extends\s+AppPlugin/.test(js)) pType = "app";
                else if (/extends\s+(CollectionPlugin|JournalCorePlugin)/.test(js)) pType = "collection";
            }

            const isGlobal = pType === 'app' || pType === 'global';
            const filterIsGlobal = typeFilter === 'app';

            if (isGlobal !== filterIsGlobal) {
                if (!confirm(`Warning: This repository appears to be a ${isGlobal ? 'Global Plugin' : 'Collection Plugin'}, but you are trying to install it as a ${filterIsGlobal ? 'Global Plugin' : 'Collection Plugin'}. Continue anyway?`)) {
                    return;
                }
            }

            await this.installPlugin(json, js, { cssCode: css });
            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
            this.loadPlugins(container);
        } catch (err) {
            this.ui.addToaster({ title: "Install Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
        }
    }

    async installPlugin(jsonConf, jsCode, { interactive = true, cssCode = null } = {}) {
        // Skip the Plugins Manager itself — it doesn't need to be reinstalled
        const name = (jsonConf.name || '').toLowerCase();
        if (name === 'plugins manager') {
            return 'skipped';
        }

        // Check for duplicates
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();

        const existingPlugin = [...allGlobals, ...allCollections].find(p => {
            try {
                const conf = p.getExistingCodeAndConfig().json;
                // Match either by strict repo URL or exact name
                return (jsonConf.__source_repo && conf.__source_repo === jsonConf.__source_repo) || conf.name === jsonConf.name;
            } catch (e) {
                return false;
            }
        });

        let targetPlugin = null;

        if (existingPlugin) {
            if (!interactive || confirm(`"${jsonConf.name}" already exists. Update/overwrite with the imported version?`)) {
                targetPlugin = existingPlugin;
            } else {
                return 'skipped';
            }
        }

        if (!targetPlugin) {
            // Attempt to derive the type if it's missing in plugin.json
            let pType = jsonConf.type;
            if (!pType) {
                // Check for class extension patterns (handles various whitespace/formatting)
                if (/extends\s+AppPlugin/.test(jsCode)) {
                    pType = "app";
                } else if (/extends\s+(CollectionPlugin|JournalCorePlugin)/.test(jsCode)) {
                    pType = "collection";
                }
            }

            // If still unknown, ask the user
            if (!pType || (pType !== 'app' && pType !== 'global' && pType !== 'collection')) {
                if (!interactive) {
                    pType = 'app'; // Default in non-interactive contexts
                } else {
                    const choice = confirm(`Could not auto-detect the type for "${jsonConf.name || 'Unknown'}".\n\nClick OK for Global Plugin, or Cancel for Collection Plugin.`);
                    pType = choice ? 'app' : 'collection';
                }
            }

            if (pType === 'app' || pType === 'global') {
                targetPlugin = await this.data.createGlobalPlugin();
            } else if (pType === 'collection') {
                targetPlugin = await this.data.createCollection();
            }

            if (!targetPlugin) throw new Error("Failed to create plugin container in workspace.");
        }

        // Validate JS before saving — catch issues that would crash Thymer's runtime
        this._validatePluginJS(jsonConf.name, jsCode);

        // Security: sanitize config to only keep expected fields
        const sanitizedConf = this._sanitizePluginConfig(jsonConf);

        // Security: enforce code size limit (500KB)
        if (jsCode && jsCode.length > 500 * 1024) {
            throw new Error(`"${jsonConf.name || 'Unknown'}" code exceeds the 500KB size limit.`);
        }

        await targetPlugin.savePlugin(sanitizedConf, jsCode);

        // For collections: apply the full schema (fields/views/etc.) via saveConfiguration
        const pTypeNorm = (jsonConf.type || '').toLowerCase();
        if (pTypeNorm === 'collection' && sanitizedConf.fields) {
            try {
                // Remap filter_colguid for link-to-record fields: the exported GUID is from the
                // source workspace; resolve using the annotated filter_colname in the target workspace
                const hasColNames = sanitizedConf.fields.some(f => f.filter_colname);
                if (hasColNames) {
                    const targetCollections = await this.data.getAllCollections();
                    const nameToGuid = {};
                    for (const tc of targetCollections) {
                        try {
                            const tc_conf = tc.getConfiguration();
                            const tc_guid = tc.getGuid ? tc.getGuid() : null;
                            if (tc_guid && tc_conf && tc_conf.name) nameToGuid[tc_conf.name] = tc_guid;
                        } catch (e) { }
                    }
                    sanitizedConf.fields = sanitizedConf.fields.map(f => {
                        if (f.filter_colname && nameToGuid[f.filter_colname]) {
                            const { filter_colname, ...rest } = f;
                            return { ...rest, filter_colguid: nameToGuid[f.filter_colname] };
                        }
                        const { filter_colname, ...rest } = f;
                        return rest;
                    });
                }
                await targetPlugin.saveConfiguration(sanitizedConf);
            } catch (e) {
                console.warn(`[Plugins Manager] saveConfiguration for collection "${jsonConf.name}" failed:`, e);
            }
        }

        // Security: sanitize and save CSS if provided
        if (cssCode) {
            const sanitizedCSS = this._sanitizeCSS(cssCode);
            await targetPlugin.saveCSS(sanitizedCSS);
        }

        this._autoExport();  // fire-and-forget
        return targetPlugin;
    }

    async showImportDialog(container, typeFilter) {
        const overlayHtml = `
            <div id="pm-import-modal" class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Import ${typeFilter === 'app' ? 'Global Plugins' : 'Collection Plugins'}</h3>
                    <p>Paste GitHub URLs (one per line), paste a JSON export array, or upload a JSON backup file.</p>
                    <textarea id="pm-import-textarea" class="pm-textarea" placeholder="https://github.com/user/repo1\nhttps://github.com/user/repo2"></textarea>
                    
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--pm-border-default);">
                        <label style="display: block; font-size: 13px; margin-bottom: 5px; color: var(--pm-text-muted);">Or upload a backup file:</label>
                        <input type="file" id="pm-import-file" accept=".json" style="font-size: 13px; color: inherit; width: 100%;" />
                    </div>

                    <div style="margin-top: 15px; display: flex; align-items: center; justify-content: space-between;">
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
                            <input type="checkbox" id="pm-import-full-override" />
                            <span style="color: #ef4444; font-weight: bold;">Full Override (Delete existing)</span>
                        </label>
                        <div style="display: flex; gap: 10px;">
                            <button class="pm-btn" id="pm-import-cancel">Cancel</button>
                            <button class="pm-btn primary" id="pm-import-confirm">Import</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);
        this._importModal = tempDiv; // Track for cleanup in onUnload

        document.getElementById('pm-import-cancel').addEventListener('click', () => {
            document.body.removeChild(tempDiv);
            this._importModal = null;
        });

        // Handle file upload immediately dumping text into the textarea for preview/processing
        document.getElementById('pm-import-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('pm-import-textarea').value = ev.target.result;
            };
            reader.readAsText(file);
        });

        document.getElementById('pm-import-confirm').addEventListener('click', async () => {
            const val = document.getElementById('pm-import-textarea').value.trim();
            if (!val) return;

            const isFullOverride = document.getElementById('pm-import-full-override').checked;
            if (isFullOverride) {
                if (!confirm(`WARNING: Full Override will delete existing ${typeFilter === 'app' ? 'Global Plugins' : 'Collections'} that are NOT in this backup. This cannot be undone. Are you sure?`)) {
                    return;
                }
            }

            document.getElementById('pm-import-confirm').innerText = "Importing...";
            document.getElementById('pm-import-confirm').disabled = true;

            let successCount = 0;
            let failedNames = [];
            let skippedNames = [];
            let deletedCount = 0;

            if (val.startsWith('[')) {
                // JSON full backup import
                try {
                    const parsed = JSON.parse(val);

                    if (isFullOverride) {
                        const backupNames = parsed.map(p => (p.json && p.json.name) || p.name).filter(Boolean);

                        if (typeFilter === 'app' || typeFilter === 'all') {
                            const allGlobals = await this.data.getAllGlobalPlugins();
                            for (const p of allGlobals) {
                                try {
                                    const pName = p.getExistingCodeAndConfig().json.name;
                                    if (!backupNames.includes(pName) && pName.toLowerCase() !== 'plugins manager') {
                                        await p.trashPlugin();
                                        deletedCount++;
                                    }
                                } catch (e) { }
                            }
                        }

                        if (typeFilter === 'collection' || typeFilter === 'all') {
                            const allCollections = await this.data.getAllCollections();
                            for (const c of allCollections) {
                                try {
                                    const cName = c.getExistingCodeAndConfig().json.name;
                                    if (!backupNames.includes(cName)) {
                                        await c.trashPlugin();
                                        deletedCount++;
                                    }
                                } catch (e) { }
                            }
                        }
                    }

                    for (const p of parsed) {
                        const pName = (p.json && p.json.name) || p.name || 'Unknown';
                        try {
                            const result = await this.installPlugin(p.json, p.code, { interactive: !isFullOverride });
                            if (result === 'skipped') { skippedNames.push(pName); }
                            else { successCount++; }
                        } catch (e) {
                            console.error(e);
                            failedNames.push(pName);
                        }
                    }
                } catch (e) {
                    this.ui.addToaster({ title: "Import Failed", message: "Invalid JSON format", autoDestroyTime: 5000 });
                    document.body.removeChild(tempDiv);
                    return;
                }
            } else {
                // URLs import
                const urls = val.split('\n').map(u => u.trim()).filter(Boolean);
                for (const url of urls) {
                    const shortUrl = url.replace(/https?:\/\/github\.com\//, '');
                    try {
                        const { json, js, css } = await this.fetchGithubRepo(url);
                        const pName = json.name || shortUrl;
                        const result = await this.installPlugin(json, js, { interactive: !isFullOverride, cssCode: css });
                        if (result === 'skipped') { skippedNames.push(pName); }
                        else { successCount++; }
                    } catch (e) {
                        console.error(e);
                        failedNames.push(shortUrl);
                    }
                }
            }

            document.body.removeChild(tempDiv);
            this._importModal = null;
            const parts = [`Installed: ${successCount}`];
            if (deletedCount > 0) parts.push(`Deleted: ${deletedCount}`);
            if (skippedNames.length > 0) parts.push(`Skipped: ${skippedNames.join(', ')}`);
            if (failedNames.length > 0) parts.push(`Failed: ${failedNames.join(', ')}`);
            this.ui.addToaster({
                title: "Import Complete",
                message: parts.join('. '),
                dismissible: true,
                autoDestroyTime: failedNames.length > 0 ? 8000 : 5000
            });
            this.loadPlugins(container);
        });
    }

    async checkAndUpdatePlugin(pluginObj, currentConf, sourceRepo, btnEl, container) {
        try {
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('loader'));
            btnEl.disabled = true;

            const { json: remoteJson, js: remoteJs, css: remoteCss } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: currentConf.__source_files });

            if (remoteJson.version === currentConf.version) {
                this.ui.addToaster({ title: "Up to date", message: `${currentConf.name} is already on the latest version.`, autoDestroyTime: 3000, dismissible: true });
                btnEl.innerHTML = '';
                btnEl.appendChild(this.ui.createIcon('check'));
                setTimeout(() => {
                    btnEl.innerHTML = '';
                    btnEl.appendChild(this.ui.createIcon('refresh'));
                    btnEl.disabled = false;
                }, 3000);
                return;
            }

            // Update available!
            const badge = document.getElementById(`vbadge-${pluginObj.getGuid()}`);
            if (badge) {
                badge.innerText = `Update Available (v${remoteJson.version})`;
                badge.classList.add('update');
            }

            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('arrow-up'));
            btnEl.classList.add('update-btn');
            btnEl.disabled = false;

            // Overwrite click handler to apply update
            btnEl.onclick = async () => {
                // Local modifications warning check (simple length/hash comparison could go here in future)
                if (confirm(`Update ${currentConf.name} from v${currentConf.version} to v${remoteJson.version}?\n\nWarning: This will overwrite any local code modifications.`)) {
                    this._validatePluginJS(remoteJson.name, remoteJs);
                    const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                    await pluginObj.savePlugin(sanitizedConf, remoteJs);

                    if (remoteCss) {
                        const sanitizedCSS = this._sanitizeCSS(remoteCss);
                        await pluginObj.saveCSS(sanitizedCSS);
                    }

                    this._autoExport();  // fire-and-forget
                    this.ui.addToaster({ title: "Update Successful", message: `${currentConf.name} updated to v${remoteJson.version}`, autoDestroyTime: 3000, dismissible: true });
                    this.loadPlugins(container);
                }
            };

        } catch (err) {
            console.error(err);
            this.ui.addToaster({ title: "Update Check Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('refresh'));
            btnEl.disabled = false;
        }
    }

    async showExportDialog(typeFilter) {
        const allData = await this._getExportData();
        let candidateData;
        if (typeFilter === 'app') {
            candidateData = allData.filter(d => d.type !== 'collection');
        } else if (typeFilter === 'collection') {
            candidateData = allData.filter(d => d.type === 'collection');
        } else {
            candidateData = allData;
        }

        const typeLabel = typeFilter === 'app' ? 'Global Plugins' : 'Collection Plugins';

        // Build the selection list HTML
        const selectionRows = candidateData.map((d, i) => `
            <label style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--pm-border-default); cursor:pointer;">
                <input type="checkbox" class="pm-export-cb" data-index="${i}" checked />
                <span style="flex:1; font-size:13px;">${this._escHtml(d.name || 'Unnamed')}</span>
                <span style="font-size:11px; color:var(--pm-text-muted);">${this._escHtml(d.type || '')}</span>
            </label>
        `).join('');

        const overlayHtml = `
            <div id="pm-export-modal" class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Export ${typeLabel}</h3>

                    <div style="margin-bottom:14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <label style="font-weight:bold; font-size:13px;">Select plugins to export</label>
                            <div style="display:flex; gap:8px;">
                                <button class="pm-btn" id="pm-sel-all" style="padding:2px 8px; font-size:11px;">All</button>
                                <button class="pm-btn" id="pm-sel-none" style="padding:2px 8px; font-size:11px;">None</button>
                            </div>
                        </div>
                        <div id="pm-export-selection" style="max-height:180px; overflow-y:auto; border:1px solid var(--pm-border-default); border-radius:6px; padding:0 10px;">
                            ${selectionRows || '<p style="font-size:13px;color:var(--pm-text-muted);padding:8px 0;">No plugins found.</p>'}
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Repository URLs (for importing to another workspace)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-urls" style="padding: 2px 8px; font-size: 11px;">Copy URLs</button>
                                <button class="pm-btn" id="pm-download-urls" style="padding: 2px 8px; font-size: 11px;">Download URLs</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-urls" id="pm-urls-text" readonly></textarea>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Full Backup (JSON with complete code &amp; config)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-json" style="padding: 2px 8px; font-size: 11px;">Copy JSON</button>
                                <button class="pm-btn primary" id="pm-download-json" style="padding: 2px 8px; font-size: 11px;">Download Backup</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-json" id="pm-full-backup-text" readonly></textarea>
                    </div>
                    
                    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                        <button class="pm-btn" id="pm-export-close">Close</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);

        // Helper: compute selected export data and refresh the textareas
        const refreshTextareas = () => {
            const checked = [...tempDiv.querySelectorAll('.pm-export-cb:checked')].map(cb => candidateData[parseInt(cb.dataset.index)]);
            const urls = checked.map(d => d.source_repo).filter(Boolean).join('\n');
            const fullBackup = JSON.stringify(checked, null, 2);
            tempDiv.querySelector('#pm-urls-text').value = urls;
            tempDiv.querySelector('#pm-full-backup-text').value = fullBackup;
        };

        // Initial fill
        refreshTextareas();

        // Checkbox changes
        tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.addEventListener('change', refreshTextareas));

        // Select All / None
        tempDiv.querySelector('#pm-sel-all').addEventListener('click', () => {
            tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.checked = true);
            refreshTextareas();
        });
        tempDiv.querySelector('#pm-sel-none').addEventListener('click', () => {
            tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.checked = false);
            refreshTextareas();
        });

        tempDiv.querySelector('#pm-export-close').addEventListener('click', () => {
            document.body.removeChild(tempDiv);
        });

        // Copy actions
        tempDiv.querySelector('#pm-copy-urls').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(tempDiv.querySelector('#pm-urls-text').value);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        tempDiv.querySelector('#pm-copy-json').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(tempDiv.querySelector('#pm-full-backup-text').value);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        // Download actions
        tempDiv.querySelector('#pm-download-urls').addEventListener('click', () => {
            const content = tempDiv.querySelector('#pm-urls-text').value;
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `thymer-${typeFilter}-urls-${this._getWorkspaceName()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        tempDiv.querySelector('#pm-download-json').addEventListener('click', () => {
            const content = tempDiv.querySelector('#pm-full-backup-text').value;
            const blob = new Blob([content], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = this._getBackupJsonFilename(typeFilter);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }
}
