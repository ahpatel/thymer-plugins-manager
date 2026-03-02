class Plugin extends AppPlugin {
    
    onLoad() {
        this.githubPat = localStorage.getItem('pm_github_pat') || '';
        this.communityRepos = localStorage.getItem('pm_community_repos') || 'https://raw.githubusercontent.com/ed-nico/awesome-thymer/main/README.md';
        
        // Register the panel type
        this.ui.registerCustomPanelType("plugin-manager-panel", (panel) => {
            this.renderUI(panel);
        });

        // Add a sidebar button to launch it
        this.ui.addSidebarItem({
            label: "Plugin Manager",
            icon: "box",
            tooltip: "Manage your Thymer plugins",
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
    
    async startAutomatedUpdateChecker() {
        // Run daily
        const lastCheck = localStorage.getItem('pm_last_update_check');
        const now = Date.now();
        if (!lastCheck || now - parseInt(lastCheck) > 24 * 60 * 60 * 1000) {
            await this.checkForAllUpdatesInBackground();
            localStorage.setItem('pm_last_update_check', now.toString());
        }
        
        // Setup interval to check every 12 hours while open
        setInterval(() => this.checkForAllUpdatesInBackground(), 12 * 60 * 60 * 1000);
    }
    
    async checkForAllUpdatesInBackground() {
        try {
            const updatesAvailable = {};
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            const allPlugins = [...allGlobals, ...allCollections];
            
            for (const p of allPlugins) {
                try {
                    const { json } = p.getExistingCodeAndConfig();
                    const repo = json.__source_repo;
                    if (repo) {
                        const { json: remoteJson } = await this.fetchGithubRepo(repo);
                        if (remoteJson.version && remoteJson.version !== json.version) {
                            updatesAvailable[p.getGuid()] = remoteJson.version;
                        }
                    }
                } catch(e) { /* ignore individual plugin errors in background */ }
            }
            
            localStorage.setItem('pm_updates_available', JSON.stringify(updatesAvailable));
        } catch(e) {
            console.error("Background update check failed", e);
        }
    }

    renderUI(panel) {
        const html = `
            <div class="pm-container">
                <div class="pm-header">
                    <h1>Plugin Manager</h1>
                </div>
                
                <div class="pm-tabs">
                    <div class="pm-tab active" data-tab="global">Global Plugins</div>
                    <div class="pm-tab" data-tab="collections">Collections</div>
                    <div class="pm-tab" data-tab="themes">Themes</div>
                    <div class="pm-tab" data-tab="discover">Discover</div>
                    <div class="pm-tab" data-tab="settings">Settings</div>
                </div>

                <div class="pm-tab-content active" id="tab-global">
                    <div class="pm-tab-actions">
                        <button class="pm-btn primary" id="pm-install-global-btn">Install Global Plugin</button>
                        <button class="pm-btn" id="pm-import-global-btn">Import Apps</button>
                        <button class="pm-btn" id="pm-export-global-btn">Export Apps</button>
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
                    <div class="pm-tab-actions" style="justify-content: space-between; align-items: center;">
                        <span style="font-size: 13px; color: var(--text-muted, #999);">Community Plugins and Themes</span>
                        <button class="pm-btn" id="pm-refresh-discover-btn">Refresh List</button>
                    </div>
                    <div id="pm-discover-list" class="pm-list-container">Loading...</div>
                </div>

                
                <div class="pm-tab-content" id="tab-themes">
                    <div class="pm-tab-actions">
                        <button class="pm-btn primary" id="pm-import-theme-btn">Import Theme CSS</button>
                        <button class="pm-btn" id="pm-export-theme-btn">Export Theme CSS</button>
                    </div>
                    <div class="pm-card" style="height: auto;">
                        <div class="pm-card-info">
                            <p>Note: Thymer currently manages Global Theme CSS outside of the Plugin API. Use the Discover tab to find themes, or use the buttons above to fetch CSS from a GitHub repository to easily copy into your workspace's <strong>Edit Theme CSS</strong> menu.</p>
                        </div>
                    </div>
                </div>

                <div class="pm-tab-content" id="tab-settings">
                    <div class="pm-card" style="height: auto;">
                        <form style="width: 100%; margin: 0;" onsubmit="return false;">
                            <div class="pm-input-group">
                                <label>GitHub Personal Access Token (Optional)</label>
                                <p style="font-size: 13px; color: var(--text-color-secondary, #999); margin-bottom: 10px;">
                                    Provide a PAT to increase API rate limits when updating/importing many plugins.
                                </p>
                                <input type="password" id="pm-pat-input" class="pm-input" placeholder="ghp_xxxxxxxxxxxx" value="${this.githubPat}" autocomplete="off">
                            </div>
                            
                            <div class="pm-input-group" style="margin-top: 20px;">
                                <label>Community Repositories</label>
                                <p style="font-size: 13px; color: var(--text-color-secondary, #999); margin-bottom: 10px;">
                                    List of raw Markdown URLs (one per line) to discover community plugins and themes.
                                </p>
                                <textarea id="pm-repos-input" class="pm-textarea" style="min-height: 80px;" placeholder="https://raw.githubusercontent.com/.../README.md">${this.communityRepos}</textarea>
                            </div>

                            <button type="button" class="pm-btn primary" id="pm-save-settings">Save Settings</button>
                        </form>
                    </div>
                </div>
            </div>
        `;

        const element = panel.getElement();
        if (element) {
            element.innerHTML = html;
            this.bindEvents(element);
            this.loadPlugins(element);
            this.loadDiscoverPlugins(element);
        }
    }

    bindEvents(container) {
        // Tabs
        container.querySelectorAll('.pm-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                container.querySelectorAll('.pm-tab').forEach(t => t.classList.remove('active'));
                container.querySelectorAll('.pm-tab-content').forEach(c => c.classList.remove('active'));
                
                e.target.classList.add('active');
                container.querySelector(`#tab-${e.target.dataset.tab}`).classList.add('active');
            });
        });

        // Settings
        container.querySelector('#pm-save-settings').addEventListener('click', () => {
            const pat = container.querySelector('#pm-pat-input').value.trim();
            const repos = container.querySelector('#pm-repos-input').value.trim();
            this.communityRepos = repos;
            localStorage.setItem('pm_community_repos', repos);
            this.githubPat = pat;
            localStorage.setItem('pm_github_pat', pat);
            this.ui.addToaster({ title: "Settings Saved", dismissible: true, autoDestroyTime: 3000 });
        });
        
        
        container.querySelector('#pm-refresh-discover-btn').addEventListener('click', () => {
            this.loadDiscoverPlugins(container);
        });

        
        container.querySelector('#pm-import-theme-btn').addEventListener('click', () => {
            this.showThemeImportDialog();
        });
        
        container.querySelector('#pm-export-theme-btn').addEventListener('click', () => {
            this.showThemeExportDialog();
        });

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
        
        try {
            const repos = this.communityRepos.split('\n').map(u => u.trim()).filter(Boolean);
            if (repos.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No community repositories configured in Settings.</p></div></div>';
                return;
            }

            const items = [];
            
            for (const repoUrl of repos) {
                try {
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
                            if (match && match[2].startsWith('http')) {
                                items.push({
                                    name: match[1],
                                    url: match[2],
                                    description: match[3] || '',
                                    category: currentCategory,
                                    sourceRepo: repoUrl
                                });
                            }
                        }
                    }
                } catch(e) {
                    console.error("Error fetching discover repo", repoUrl, e);
                }
            }
            
            if (items.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No plugins found in the configured community repositories.</p></div></div>';
                return;
            }
            
            listContainer.innerHTML = '';
            
            items.forEach(item => {
                const isCollection = item.category.toLowerCase().includes('collection');
                const isTheme = item.category.toLowerCase().includes('theme');
                const badgeText = isTheme ? 'Theme' : (isCollection ? 'Collection' : 'App');
                
                const card = document.createElement('div');
                card.className = 'pm-card';
                card.innerHTML = `
                    <div class="pm-card-info">
                        <h3>
                            ${item.name} 
                            <span class="pm-badge">${badgeText}</span>
                        </h3>
                        <p>${item.description}</p>
                        <p style="margin-top: 5px; font-size: 11px;"><a href="${item.url}" target="_blank">${item.url}</a></p>
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

                const installBtn = document.createElement('button');
                installBtn.className = 'pm-btn primary';
                if (isTheme) {
                    installBtn.innerText = 'Copy CSS';
                } else {
                    installBtn.innerText = 'Install';
                }
                actionsContainer.appendChild(installBtn);
                
                installBtn.addEventListener('click', async () => {
                    const originalText = installBtn.innerText;
                    installBtn.innerText = isTheme ? 'Fetching...' : 'Installing...';
                    installBtn.disabled = true;
                    
                    try {
                        if (isTheme) {
                            const match = item.url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                            if (!match) throw new Error("Invalid GitHub URL.");
                            const owner = match[1];
                            const repo = match[2].replace(/\.git$/, '');
                            const headers = {};
                            if (this.githubPat) headers['Authorization'] = `token ${this.githubPat}`;
                            
                            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/`;
                            const res = await fetch(apiUrl, { headers });
                            if (!res.ok) throw new Error("Could not fetch repo contents.");
                            
                            const files = await res.json();
                            const cssFile = files.find(f => f.name.endsWith('.css'));
                            if (!cssFile) throw new Error("No .css file found in the root of this repository.");
                            
                            const cssRes = await fetch(cssFile.download_url, { headers });
                            if (!cssRes.ok) throw new Error("Failed to download CSS file.");
                            
                            const cssText = await cssRes.text();
                            await navigator.clipboard.writeText(cssText);
                            this.ui.addToaster({ title: "CSS Copied!", message: "Theme CSS copied to clipboard. Press Ctrl+P -> Edit Theme CSS -> Paste.", autoDestroyTime: 5000, dismissible: true });
                            installBtn.innerText = 'Copied';
                        } else {
                            const { json, js } = await this.fetchGithubRepo(item.url);
                            await this.installPlugin(json, js);
                            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
                            installBtn.innerText = 'Installed';
                            this.loadPlugins(container);
                        }
                    } catch (err) {
                        this.ui.addToaster({ title: "Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
                        installBtn.innerText = originalText;
                        installBtn.disabled = false;
                    }
                });

                
                listContainer.appendChild(card);
            });

        } catch (err) {
            console.error(err);
            listContainer.innerHTML = "Error loading community plugins.";
        }
    }

    async loadPlugins(container) {
        try {
            const globals = await this.data.getAllGlobalPlugins();
            const collections = await this.data.getAllCollections();
            
            this.renderPluginList(container, 'pm-global-list', globals);
            this.renderPluginList(container, 'pm-collections-list', collections);
        } catch (err) {
            console.error(err);
            container.querySelector('#pm-global-list').innerHTML = "Error loading plugins.";
            container.querySelector('#pm-collections-list').innerHTML = "Error loading collections.";
        }
    }

    renderPluginList(panelContainer, containerId, plugins) {
        const container = panelContainer.querySelector(`#${containerId}`);
        container.innerHTML = '';
        
        if (plugins.length === 0) {
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
                        ${conf.name || 'Unnamed Plugin'} 
                        <span class="pm-badge" id="pm-badge-type-${p.getGuid()}"></span>
                        <span class="pm-badge pm-version-badge" id="vbadge-${p.getGuid()}">v${conf.version || '0.0.0'}</span>
                    </h3>
                    <p>${conf.description || 'No description'}</p>
                    ${sourceRepo ? `<p style="margin-top: 5px; font-size: 11px;"><a href="${sourceRepo}" target="_blank">${sourceRepo}</a></p>` : ''}
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
            }
            
            // Add Native Delete Button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'pm-btn danger pm-btn-delete';
            deleteBtn.title = 'Delete Plugin';
            deleteBtn.appendChild(this.ui.createIcon('x')); // 'x' or 'trash' might not exist, 'x' is close/delete in Thymer usually
            actionsContainer.appendChild(deleteBtn);
            
            deleteBtn.addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete ${conf.name}?`)) {
                    p.trashPlugin();
                    this.ui.addToaster({ title: "Plugin deleted", dismissible: true, autoDestroyTime: 3000 });
                    this.loadPlugins(panelContainer);
                }
            });
            
            container.appendChild(card);
        });
    }


    async showThemeImportDialog() {
        const overlayHtml = `
            <div id="pm-theme-import-modal" class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Import Theme CSS</h3>
                    <p style="font-size: 13px; color: var(--text-muted, #999); margin-bottom: 15px;">
                        Paste a GitHub repository URL for a theme. We will fetch its CSS and copy it to your clipboard so you can paste it into <strong>Edit Theme CSS</strong>.
                    </p>
                    <input type="text" id="pm-theme-repo-input" class="pm-input" placeholder="https://github.com/user/thymer-theme" />
                    
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-theme-fetch">Fetch CSS</button>
                    </div>
                </div>
            </div>
        `;
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);
        
        document.getElementById('pm-theme-cancel').addEventListener('click', () => {
            document.body.removeChild(tempDiv);
        });

        document.getElementById('pm-theme-fetch').addEventListener('click', async () => {
            const url = document.getElementById('pm-theme-repo-input').value.trim();
            if (!url) return;
            
            const btn = document.getElementById('pm-theme-fetch');
            btn.innerText = "Fetching...";
            btn.disabled = true;
            
            try {
                const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                if (!match) throw new Error("Invalid GitHub URL.");
                
                const owner = match[1];
                const repo = match[2].replace(/\.git$/, '');
                
                const headers = {};
                if (this.githubPat) headers['Authorization'] = `token ${this.githubPat}`;
                
                // Fetch repo contents to find CSS file
                const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/`;
                const res = await fetch(apiUrl, { headers });
                if (!res.ok) throw new Error("Could not fetch repo contents.");
                
                const files = await res.json();
                const cssFile = files.find(f => f.name.endsWith('.css'));
                
                if (!cssFile) throw new Error("No .css file found in the root of this repository.");
                
                const cssRes = await fetch(cssFile.download_url, { headers });
                if (!cssRes.ok) throw new Error("Failed to download CSS file.");
                
                const cssText = await cssRes.text();
                
                await navigator.clipboard.writeText(cssText);
                
                document.body.removeChild(tempDiv);
                this.ui.addToaster({ title: "CSS Copied!", message: "Theme CSS copied to clipboard. Press Ctrl+P -> Edit Theme CSS -> Paste.", autoDestroyTime: 5000, dismissible: true });
                
            } catch(e) {
                console.error(e);
                this.ui.addToaster({ title: "Theme Fetch Failed", message: e.message, autoDestroyTime: 5000, dismissible: true });
                btn.innerText = "Fetch CSS";
                btn.disabled = false;
            }
        });
    }

    showThemeExportDialog() {
        const overlayHtml = `
            <div id="pm-theme-export-modal" class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Export Theme CSS</h3>
                    <p style="font-size: 13px; color: var(--text-muted, #999); margin-bottom: 15px;">
                        Because the SDK cannot read your global Custom Theme CSS directly, you must paste it here to download it as a backup file.
                    </p>
                    <textarea id="pm-theme-export-textarea" class="pm-textarea" placeholder="Paste your CSS here..."></textarea>
                    
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-theme-export-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-theme-export-download">Download .css</button>
                    </div>
                </div>
            </div>
        `;
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);
        
        document.getElementById('pm-theme-export-cancel').addEventListener('click', () => {
            document.body.removeChild(tempDiv);
        });

        document.getElementById('pm-theme-export-download').addEventListener('click', () => {
            const css = document.getElementById('pm-theme-export-textarea').value.trim();
            if (!css) return;
            
            const blob = new Blob([css], { type: 'text/css' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `thymer-theme-backup.css`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            document.body.removeChild(tempDiv);
        });
    }


    async previewTheme(repoUrl) {
        try {
            const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
            if (!match) return;
            const owner = match[1];
            const repo = match[2].replace(/\.git$/, '');
            const headers = {};
            if (this.githubPat) headers['Authorization'] = `token ${this.githubPat}`;
            
            const readmeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers });
            if (!readmeRes.ok) throw new Error("No README");
            
            const readmeData = await readmeRes.json();
            const content = atob(readmeData.content);
            
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
                            ${images.map(img => `<img src="${img}" style="max-width: 100%; border-radius: 4px; border: 1px solid var(--border-default, #333);" />`).join('')}
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
            
        } catch(e) {
            this.ui.addToaster({ title: "Preview Failed", message: "Could not load theme preview images.", autoDestroyTime: 3000, dismissible: true });
        }
    }

    // --- GitHub Utils ---
    
    async fetchGithubRepo(url) {
        // Normalize URL: https://github.com/user/repo
        const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) throw new Error("Invalid GitHub URL. Expected format: https://github.com/user/repo");
        
        const owner = match[1];
        const repo = match[2].replace(/\.git$/, '');
        
        const headers = {};
        if (this.githubPat) {
            headers['Authorization'] = `token ${this.githubPat}`;
        }

        // Try to fetch plugin.json from main then master
        let branch = 'main';
        let jsonUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/plugin.json`;
        let jsUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/plugin.js`;
        
        let jsonRes = await fetch(jsonUrl, { headers });
        if (!jsonRes.ok) {
            branch = 'master';
            jsonUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/plugin.json`;
            jsUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/plugin.js`;
            jsonRes = await fetch(jsonUrl, { headers });
        }
        
        if (!jsonRes.ok) throw new Error(`Could not find plugin.json on main or master branches in ${owner}/${repo}`);
        
        const pluginJson = await jsonRes.json();
        
        const jsRes = await fetch(jsUrl, { headers });
        if (!jsRes.ok) throw new Error(`Could not find plugin.js in ${owner}/${repo}`);
        
        const pluginJs = await jsRes.text();
        
        // Add metadata
        pluginJson.__source_repo = url;
        
        return {
            json: pluginJson,
            js: pluginJs
        };
    }

    // --- Core Features ---

    async showInstallDialog(container, typeFilter) {
        const url = prompt(`Enter GitHub URL for the ${typeFilter === 'app' ? 'Global Plugin' : 'Collection Plugin'} (e.g. https://github.com/user/repo):`);
        if (!url) return;

        try {
            this.ui.addToaster({ title: "Fetching plugin...", autoDestroyTime: 2000, dismissible: true });
            const { json, js } = await this.fetchGithubRepo(url);
            
            // Validate type
            let pType = json.type;
            if (!pType) {
                if (js.includes("extends AppPlugin")) pType = "app";
                else if (js.includes("extends CollectionPlugin")) pType = "collection";
            }
            
            const isGlobal = pType === 'app' || pType === 'global';
            const filterIsGlobal = typeFilter === 'app';
            
            if (isGlobal !== filterIsGlobal) {
                if (!confirm(`Warning: This repository appears to be a ${isGlobal ? 'Global Plugin' : 'Collection Plugin'}, but you are trying to install it as a ${filterIsGlobal ? 'Global Plugin' : 'Collection Plugin'}. Continue anyway?`)) {
                    return;
                }
            }
            
            await this.installPlugin(json, js);
            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
            this.loadPlugins(container);
        } catch (err) {
            this.ui.addToaster({ title: "Install Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
        }
    }
    
    async installPlugin(jsonConf, jsCode) {
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
            if (confirm(`A plugin named "${jsonConf.name}" already exists in the workspace. Do you want to update/overwrite it with this imported version?`)) {
                targetPlugin = existingPlugin;
            } else {
                throw new Error("Installation cancelled by user.");
            }
        }
        
        if (!targetPlugin) {
            // Attempt to derive the type if it's missing in plugin.json
            let pType = jsonConf.type;
            if (!pType) {
                if (jsCode.includes("extends AppPlugin")) {
                    pType = "app";
                } else if (jsCode.includes("extends CollectionPlugin")) {
                    pType = "collection";
                }
            }
            
            if (pType === 'app' || pType === 'global') {
                targetPlugin = await this.data.createGlobalPlugin();
            } else if (pType === 'collection') {
                targetPlugin = await this.data.createCollection();
            } else {
                throw new Error(`Unknown plugin type: ${pType || 'undefined'}. Ensure plugin.json has a "type" field or plugin.js extends AppPlugin/CollectionPlugin.`);
            }
            
            if (!targetPlugin) throw new Error("Failed to create plugin container in workspace.");
        }
        
        await targetPlugin.savePlugin(jsonConf, jsCode);
        return targetPlugin;
    }

    async showImportDialog(container, typeFilter) {
        const overlayHtml = `
            <div id="pm-import-modal" class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Import ${typeFilter === 'app' ? 'Global Plugins' : 'Collection Plugins'}</h3>
                    <p>Paste GitHub URLs (one per line), paste a JSON export array, or upload a JSON backup file.</p>
                    <textarea id="pm-import-textarea" class="pm-textarea" placeholder="https://github.com/user/repo1\nhttps://github.com/user/repo2"></textarea>
                    
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-default, #333);">
                        <label style="display: block; font-size: 13px; margin-bottom: 5px; color: var(--text-muted, #999);">Or upload a backup file:</label>
                        <input type="file" id="pm-import-file" accept=".json" style="font-size: 13px; color: inherit; width: 100%;" />
                    </div>

                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-import-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-import-confirm">Import</button>
                    </div>
                </div>
            </div>
        `;
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        document.body.appendChild(tempDiv);
        
        document.getElementById('pm-import-cancel').addEventListener('click', () => {
            document.body.removeChild(tempDiv);
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
            
            document.getElementById('pm-import-confirm').innerText = "Importing...";
            document.getElementById('pm-import-confirm').disabled = true;
            
            let successCount = 0;
            let failCount = 0;

            if (val.startsWith('[')) {
                // JSON full backup import
                try {
                    const parsed = JSON.parse(val);
                    for (const p of parsed) {
                        try {
                            const isGlobal = p.type === 'app' || p.type === 'global';
                            const filterIsGlobal = typeFilter === 'app';
                            if (isGlobal !== filterIsGlobal) {
                                console.warn(`Skipping ${p.name}: Wrong type`);
                                failCount++;
                                continue;
                            }
                            await this.installPlugin(p.json, p.code);
                            successCount++;
                        } catch(e) {
                            console.error(e);
                            failCount++;
                        }
                    }
                } catch(e) {
                    this.ui.addToaster({ title: "Import Failed", message: "Invalid JSON format", autoDestroyTime: 5000 });
                    document.body.removeChild(tempDiv);
                    return;
                }
            } else {
                // URLs import
                const urls = val.split('\n').map(u => u.trim()).filter(Boolean);
                for (const url of urls) {
                    try {
                        const { json, js } = await this.fetchGithubRepo(url);
                        
                        let pType = json.type;
                        if (!pType) {
                            if (js.includes("extends AppPlugin")) pType = "app";
                            else if (js.includes("extends CollectionPlugin")) pType = "collection";
                        }
                        
                        const isGlobal = pType === 'app' || pType === 'global';
                        const filterIsGlobal = typeFilter === 'app';
                        if (isGlobal !== filterIsGlobal) {
                            console.warn(`Skipping ${json.name}: Wrong type`);
                            failCount++;
                            continue;
                        }
                        
                        await this.installPlugin(json, js);
                        successCount++;
                    } catch(e) {
                        console.error(e);
                        failCount++;
                    }
                }
            }
            
            document.body.removeChild(tempDiv);
            this.ui.addToaster({ 
                title: "Import Complete", 
                message: `Successfully installed ${successCount}. Failed: ${failCount}`,
                dismissible: true, 
                autoDestroyTime: 5000 
            });
            this.loadPlugins(container);
        });
    }

    async checkAndUpdatePlugin(pluginObj, currentConf, sourceRepo, btnEl, container) {
        try {
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('loader'));
            btnEl.disabled = true;
            
            const { json: remoteJson, js: remoteJs } = await this.fetchGithubRepo(sourceRepo);
            
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
            if(badge) {
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
                    await pluginObj.savePlugin(remoteJson, remoteJs);
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
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();
        
        let targetPlugins = [];
        if (typeFilter === 'app') {
            targetPlugins = allGlobals;
        } else if (typeFilter === 'collection') {
            targetPlugins = allCollections;
        } else {
            targetPlugins = [...allGlobals, ...allCollections];
        }
        
        const exportData = targetPlugins.map(p => {
            try {
                const { json, code } = p.getExistingCodeAndConfig();
                return {
                    name: json.name,
                    type: json.type,
                    version: json.version,
                    source_repo: json.__source_repo,
                    code: code,
                    json: json
                };
            } catch(e) {
                return null;
            }
        }).filter(Boolean);
        
        // Simple list of URLs format
        const urls = exportData.map(d => d.source_repo).filter(Boolean).join('\n');
        
        // Full Backup Format
        const fullBackup = JSON.stringify(exportData, null, 2);
        
        const typeLabel = typeFilter === 'app' ? 'Global Plugins' : 'Collection Plugins';
        
        const overlayHtml = `
            <div id="pm-export-modal" class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Export ${typeLabel}</h3>
                    
                    <div style="margin-bottom: 20px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Repository URLs (for importing to another workspace)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-urls" style="padding: 2px 8px; font-size: 11px;">Copy URLs</button>
                                <button class="pm-btn" id="pm-download-urls" style="padding: 2px 8px; font-size: 11px;">Download URLs</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-urls" id="pm-urls-text" readonly>${urls}</textarea>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Full Backup (JSON with complete code & config)</label>
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
        
        document.getElementById('pm-full-backup-text').value = fullBackup;
        
        document.getElementById('pm-export-close').addEventListener('click', () => {
            document.body.removeChild(tempDiv);
        });
        
        // Copy actions
        document.getElementById('pm-copy-urls').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(urls);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });
        
        document.getElementById('pm-copy-json').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(fullBackup);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });
        
        // Download actions
        document.getElementById('pm-download-urls').addEventListener('click', () => {
            const blob = new Blob([urls], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `thymer-${typeFilter}-urls.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
        
        document.getElementById('pm-download-json').addEventListener('click', () => {
            const blob = new Blob([fullBackup], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `thymer-${typeFilter}-backup.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }
}
