# Thymer Plugin Manager

A powerful utility plugin for Thymer that allows you to install, manage, update, import, and export your Global Plugins and Collection Plugins from a single unified interface.

## Features

- **Centralized Management**: View all your installed Global Plugins and Collection Plugins in a clean, tabbed interface.
- **Easy Installation**: Install new plugins simply by pasting their GitHub repository URL. The manager automatically detects if it's an App Plugin or a Collection Plugin.
- **Automated Updates**: Automatically checks for plugin updates in the background (daily) and displays a badge when a newer version is available on GitHub.
- **One-Click Updates**: Seamlessly update any plugin to its latest GitHub version without losing your configuration.
- **Bulk Import**: Import multiple plugins at once by pasting a list of GitHub URLs or uploading a JSON backup file. Automatically resolves duplicates and handles version merging.
- **Export & Backup**: Export your installed plugins as a list of repository URLs, or download a full JSON backup containing all configuration and code to safely migrate your environment.
- **GitHub PAT Support**: Provide an optional GitHub Personal Access Token to bypass unauthenticated API rate limits.

## Installation

Since this plugin manages other plugins, it must be installed manually first.

1. Create a new **App Plugin** in your Thymer workspace.
2. Build the plugin using `npm run build` (or grab the pre-built `dist/plugin.js`).
3. Paste the contents of `dist/plugin.js` into the **JavaScript** section of the Thymer plugin configuration.
4. Paste the contents of `styles.css` into the **Custom CSS** section.
5. Save the plugin. A new "Plugin Manager" option will appear in your Thymer sidebar.

## Usage

Once installed, click the **Plugin Manager** icon in your left sidebar to open the dashboard.

### Tabs

- **Global Plugins**: Manage workspace-level app plugins.
- **Collections**: Manage collection-specific plugins.
- **Settings**: Configure your GitHub Personal Access Token.

### Actions

- **Install**: Paste a GitHub repository URL (e.g., `https://github.com/user/repo`). The manager will automatically fetch `plugin.json` and `plugin.js` from the `main` or `master` branch.
- **Import**: Click to paste a list of URLs or click "Or upload a backup file" to select a JSON export file.
- **Export**: Generates a downloadable `.txt` of URLs or a `.json` backup of your entire plugin environment.
- **Update**: If a cloud icon appears with an "Update Available" badge, click the refresh arrow to pull the latest code.
- **Delete**: Remove a plugin from your workspace permanently.

## Development

To modify the Plugin Manager itself:

1. Ensure you have the `thymer-plugin-sdk` installed locally.
2. Run `npm install` to install dependencies.
3. Use `npm run build` to bundle `plugin.js` via esbuild into the `dist/` directory.

```bash
cd thymer-plugins-manager
npm run build
```
