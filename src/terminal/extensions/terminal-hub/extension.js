// Terminal Hub: keeps one terminal open, starts with side bars closed,
// and installs Claude Code Manager from Open VSX like any other extension.
// Plain JavaScript on purpose: built-in extensions without a tsconfig are copied as-is.
'use strict';

const vscode = require('vscode');

const MANAGER_ID = 'vishalguptax.claude-manager';
const MANAGER_VIEW = 'workbench.view.extension.claudeCodeManager';

function config() {
	return vscode.workspace.getConfiguration('terminalHub');
}

async function ensureManager() {
	if (vscode.extensions.getExtension(MANAGER_ID)) {
		return true;
	}
	if (!config().get('installManager', true)) {
		return false;
	}
	try {
		await vscode.commands.executeCommand('workbench.extensions.installExtension', MANAGER_ID);
		return !!vscode.extensions.getExtension(MANAGER_ID);
	} catch (error) {
		console.warn('[terminalHub] installing Claude Code Manager failed', error);
		return false;
	}
}

function activate(context) {
	context.subscriptions.push(
		vscode.window.onDidCloseTerminal(() => {
			// Keep the window useful: a closed last terminal gets replaced instead of leaving an empty window.
			const tabsOpen = vscode.window.tabGroups.all.some(group => group.tabs.length > 0);
			if (config().get('keepOneTerminal', true) && vscode.window.terminals.length === 0 && !tabsOpen) {
				vscode.commands.executeCommand('workbench.action.terminal.new');
			}
		}),
		vscode.commands.registerCommand('terminalHub.installManager', async () => {
			const ok = await ensureManager();
			vscode.window.showInformationMessage(ok ? 'Claude Code Manager is installed.' : 'Claude Code Manager could not be installed. Check the network and the Open VSX gallery.');
			if (ok) {
				await vscode.commands.executeCommand(MANAGER_VIEW);
			}
		})
	);

	// Terminal first: start with both side bars closed unless configured otherwise.
	setTimeout(async () => {
		await ensureManager();
		if (config().get('closeSideBarsOnStartup', true)) {
			try {
				await vscode.commands.executeCommand('workbench.action.closeSidebar');
				await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			} catch {
				// layout commands unavailable: keep the restored layout
			}
		}
	}, 1500);
}

function deactivate() { }

module.exports = { activate, deactivate };
