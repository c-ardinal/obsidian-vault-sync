'use strict';

var obsidian = require('obsidian');

/**
 * Cryptographic primitives for VaultSync using Web Crypto API (SubtleCrypto).
 */
async function generateMasterKey() {
    return await window.crypto.subtle.generateKey({
        name: "AES-GCM",
        length: 256,
    }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}
async function deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordKey = await window.crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    return await window.crypto.subtle.deriveKey({
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256",
    }, passwordKey, {
        name: "AES-GCM",
        length: 256,
    }, true, ["wrapKey", "unwrapKey", "encrypt", "decrypt"]);
}
async function encryptData(key, data) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({
        name: "AES-GCM",
        iv: iv,
    }, key, data);
    return { iv, ciphertext: ciphertext };
}
async function decryptData(key, data, iv) {
    return (await window.crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: iv,
    }, key, data));
}
async function hashPassword(password) {
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    // consistent base64 encoding
    return btoa(String.fromCharCode(...hashArray));
}
/**
 * Derive an outer encryption key from hashedPassword using SHA-256.
 * Used to encrypt vault-lock file for opaque storage.
 * Key independence: outerKey = SHA-256(hashedPassword), innerKey = PBKDF2(hashedPassword, salt)
 */
async function deriveOuterKey(hashedPassword) {
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashedPassword));
    return await window.crypto.subtle.importKey("raw", hashBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;
/** Set text content with \n → line breaks */
function setTextWithBreaks(el, text) {
    el.empty();
    const lines = text.split("\n");
    lines.forEach((line, i) => {
        if (i > 0)
            el.createEl("br");
        el.appendText(line);
    });
}
/**
 * Migration Setup Modal
 */
class E2EESetupModal extends obsidian.Modal {
    plugin;
    password = "";
    progressBar;
    statusText;
    fileText;
    statsText;
    startTime = 0;
    lastLogTime = 0;
    passwordInput;
    strengthIndicator;
    startBtn;
    asciiWarning;
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    t(key) {
        return this.plugin.i18n?.(key) || key;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.t("e2eeSetupTitle") });
        const desc = contentEl.createEl("p");
        setTextWithBreaks(desc, this.t("e2eeSetupDesc"));
        // Check for active or interrupted migration
        const migrationService = this.plugin.syncManager.migrationService;
        if (migrationService && migrationService.isMigrating) {
            contentEl.createEl("div", {
                text: this.t("e2eeSetupMigratingBg"),
                cls: "vault-sync-warning",
            });
            const p = migrationService.currentProgress;
            if (p) {
                contentEl.createEl("div", { text: `${p.current} / ${p.total} files` });
            }
            return;
        }
        // Check for interrupted
        this.checkInterrupted(contentEl);
        // Password input with show/hide toggle
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeSetupPasswordLabel"))
            .setDesc(this.t("e2eeSetupPasswordDesc"))
            .addText((text) => {
            this.passwordInput = text.inputEl;
            text.inputEl.type = "password";
            text.inputEl.setAttribute("autocomplete", "new-password");
            text.onChange((v) => {
                // ASCII-only filter
                if (!ASCII_PRINTABLE.test(v)) {
                    const filtered = v.replace(/[^\x20-\x7E]/g, "");
                    text.setValue(filtered);
                    this.password = filtered;
                    this.showAsciiWarning(true);
                }
                else {
                    this.password = v;
                    this.showAsciiWarning(false);
                }
                this.updateButtonState();
                this.updateStrengthIndicator(this.password);
            });
        })
            .addExtraButton((btn) => {
            btn.setIcon("eye");
            btn.setTooltip("Show/Hide");
            btn.onClick(() => {
                if (!this.passwordInput)
                    return;
                const isHidden = this.passwordInput.type === "password";
                this.passwordInput.type = isHidden ? "text" : "password";
                btn.setIcon(isHidden ? "eye-off" : "eye");
            });
        });
        // ASCII-only warning (hidden by default)
        this.asciiWarning = contentEl.createDiv({ cls: "vault-sync-ascii-warning" });
        this.asciiWarning.style.cssText = "color:var(--text-error);font-size:0.85em;display:none;margin-top:-8px;margin-bottom:8px;";
        this.asciiWarning.setText(this.t("e2eeSetupAsciiOnly"));
        // Allowed characters hint
        const hint = contentEl.createDiv();
        hint.style.cssText = "color:var(--text-muted);font-size:0.8em;margin-top:-8px;margin-bottom:8px;white-space:pre-line;";
        hint.setText(this.t("e2eeSetupPasswordHint"));
        // Password strength indicator
        this.strengthIndicator = contentEl.createDiv({ cls: "vault-sync-password-strength" });
        // Progress UI (initially hidden)
        const mgContainer = contentEl.createDiv({ cls: "vault-sync-migration-container" });
        const barWrapper = mgContainer.createDiv({ cls: "vault-sync-progress-wrapper" });
        this.progressBar = barWrapper.createDiv({ cls: "vault-sync-progress-bar" });
        this.statusText = mgContainer.createDiv({ cls: "vault-sync-migration-status" });
        this.fileText = mgContainer.createDiv({ cls: "vault-sync-migration-file" });
        this.statsText = mgContainer.createDiv({ cls: "vault-sync-migration-status" });
        mgContainer.hide();
        // Start Migration button (disabled until password >= 8 chars)
        new obsidian.Setting(contentEl).addButton((btn) => {
            this.startBtn = btn;
            btn.setButtonText(this.t("e2eeSetupStartButton"))
                .setCta()
                .setDisabled(true)
                .onClick(async () => {
                const closeBtn = this.modalEl.querySelector(".modal-close-button");
                if (closeBtn)
                    closeBtn.style.display = "none";
                if (this.passwordInput)
                    this.passwordInput.disabled = true;
                // Prevent closing on outside click
                this.closeOnOutsideClick = false;
                const bg = this.containerEl.querySelector(".modal-bg");
                if (bg)
                    bg.style.pointerEvents = "none";
                mgContainer.show();
                btn.setDisabled(true);
                btn.setButtonText(this.t("e2eeSetupMigratingButton"));
                this.startTime = Date.now();
                this.lastLogTime = 0;
                try {
                    const hashedPassword = await hashPassword(this.password);
                    this.plugin.syncManager.currentTrigger = "migration";
                    await this.plugin.syncManager.notify("noticeMigrationStarted");
                    const adapter = await this.plugin.syncManager.migrationService.startMigration(hashedPassword);
                    await this.plugin.syncManager.migrationService.runMigration(adapter, (p) => {
                        const percent = Math.round((p.current / p.total) * 100);
                        this.progressBar.style.width = `${percent}%`;
                        this.statusText.setText(`${p.current} / ${p.total} (${percent}%)`);
                        this.fileText.setText(p.fileName);
                        const elapsedSec = (Date.now() - this.startTime) / 1000;
                        if (elapsedSec > 1 && p.current > 0) {
                            const speed = p.current / elapsedSec;
                            const remaining = p.total - p.current;
                            const etaSec = Math.round(remaining / speed);
                            const etaMin = Math.floor(etaSec / 60);
                            const etaRemainSec = etaSec % 60;
                            const etaStr = etaMin > 0 ? `${etaMin}m ${etaRemainSec}s` : `${etaSec}s`;
                            const completionTime = new Date(Date.now() + etaSec * 1000).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                            });
                            const statsMsg = `ETA: ${etaStr} (${completionTime})`;
                            this.statsText.setText(statsMsg);
                            const now = Date.now();
                            if (now - this.lastLogTime > 10000) {
                                this.plugin.syncManager.log(`Migration: ${percent}% (${p.current}/${p.total}). ${statsMsg}`, "info");
                                this.lastLogTime = now;
                            }
                        }
                    });
                    this.statusText.setText(this.t("e2eeSetupFinalizing"));
                    this.fileText.setText("");
                    this.statsText.setText(this.t("e2eeSetupSwapping"));
                    await this.plugin.syncManager.migrationService.finalizeMigration(adapter);
                    // Save password to SecureStorage for auto-unlock
                    if (this.plugin.syncManager.secureStorage) {
                        try {
                            await this.plugin.syncManager.secureStorage.setExtraSecret("e2ee-password", hashedPassword);
                            await this.plugin.syncManager.log("E2EE Password saved to SecureStorage.", "info");
                        }
                        catch (err) {
                            console.error("Failed to save password to SecureStorage", err);
                            await this.plugin.syncManager.notify("e2eeSetupKeychainFailed");
                        }
                    }
                    this.plugin.settings.e2eeEnabled = true;
                    await this.plugin.saveSettings();
                    await this.plugin.syncManager.notify("noticeMigrationComplete");
                    this.close();
                    this.plugin.refreshSettingsUI();
                }
                catch (e) {
                    const closeBtn = this.modalEl.querySelector(".modal-close-button");
                    if (closeBtn)
                        closeBtn.style.display = "";
                    this.closeOnOutsideClick = true;
                    const bg = this.containerEl.querySelector(".modal-bg");
                    if (bg)
                        bg.style.pointerEvents = "";
                    if (this.passwordInput)
                        this.passwordInput.disabled = false;
                    await this.plugin.syncManager.log(`Migration failed: ${e.message || e}`, "error");
                    await this.plugin.syncManager.notify("noticeMigrationFailed");
                    console.error(e);
                    btn.setDisabled(false);
                    btn.setButtonText(this.t("e2eeSetupStartButton"));
                    this.statusText.setText(this.t("e2eeSetupError"));
                    this.statsText.setText("");
                }
            });
        });
    }
    showAsciiWarning(show) {
        if (this.asciiWarning) {
            this.asciiWarning.style.display = show ? "" : "none";
        }
    }
    updateButtonState() {
        if (this.startBtn) {
            this.startBtn.setDisabled(this.password.length < 8);
        }
    }
    updateStrengthIndicator(password) {
        if (!this.strengthIndicator)
            return;
        this.strengthIndicator.empty();
        const checker = this.plugin.checkPasswordStrength;
        if (!checker || !password)
            return;
        const result = checker(password);
        // Strength bar
        const barContainer = this.strengthIndicator.createDiv({ cls: "vault-sync-strength-bar-container" });
        barContainer.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";
        const colors = {
            weak: "var(--text-error)",
            fair: "var(--text-warning)",
            good: "var(--text-success)",
            strong: "var(--interactive-accent)",
        };
        const segmentCount = { weak: 1, fair: 2, good: 3, strong: 4 };
        const filled = segmentCount[result.strength] || 0;
        const color = colors[result.strength] || "var(--text-muted)";
        for (let i = 0; i < 4; i++) {
            const seg = barContainer.createDiv();
            seg.style.cssText = `height:4px;flex:1;border-radius:2px;background:${i < filled ? color : "var(--background-modifier-border)"};`;
        }
        // Strength label
        const strengthKey = `passwordStrength${result.strength.charAt(0).toUpperCase() + result.strength.slice(1)}`;
        const label = this.t(strengthKey);
        const labelEl = this.strengthIndicator.createDiv();
        labelEl.style.cssText = `font-size:0.85em;color:${color};`;
        labelEl.setText(label);
        // Feedback messages
        if (result.feedback.length > 0) {
            const feedbackEl = this.strengthIndicator.createDiv();
            feedbackEl.style.cssText = "font-size:0.8em;color:var(--text-muted);margin-top:2px;";
            const messages = result.feedback.map((key) => this.t(key));
            feedbackEl.setText(messages.join(". "));
        }
    }
    async checkInterrupted(contentEl) {
        const migrationService = this.plugin.syncManager.migrationService;
        if (!migrationService)
            return;
        const interrupted = await migrationService.checkForInterruptedMigration();
        if (interrupted) {
            contentEl.empty();
            contentEl.createEl("h2", { text: this.t("e2eeInterruptedTitle") });
            const desc = contentEl.createEl("div", { cls: "vault-sync-warning" });
            setTextWithBreaks(desc, this.t("e2eeInterruptedDesc"));
            new obsidian.Setting(contentEl)
                .setName(this.t("e2eeInterruptedCleanLabel"))
                .setDesc(this.t("e2eeInterruptedCleanDesc"))
                .addButton((btn) => btn
                .setButtonText(this.t("e2eeInterruptedResetButton"))
                .setCta()
                .onClick(async () => {
                btn.setDisabled(true);
                btn.setButtonText(this.t("e2eeInterruptedCleaning"));
                try {
                    await migrationService.cancelMigration();
                    await this.plugin.syncManager.notify("e2eeInterruptedDone");
                    this.close();
                }
                catch (e) {
                    await this.plugin.syncManager.log(`[E2EE] Cleanup failed: ${e.message || e}`, "error");
                    new obsidian.Notice(`${e.message || e}`);
                }
            }));
        }
    }
}
/**
 * Unlock Modal
 */
class E2EEUnlockModal extends obsidian.Modal {
    plugin;
    password = "";
    passwordInput;
    autoUnlock = false;
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.autoUnlock = !!this.plugin.settings?.e2eeAutoUnlock;
    }
    t(key) {
        return this.plugin.i18n?.(key) || key;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.t("e2eeUnlockTitle") });
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeUnlockPasswordLabel"))
            .addText((text) => {
            this.passwordInput = text.inputEl;
            text.inputEl.type = "password";
            text.inputEl.setAttribute("autocomplete", "current-password");
            text.onChange((v) => (this.password = v));
        })
            .addExtraButton((btn) => {
            btn.setIcon("eye");
            btn.setTooltip("Show/Hide");
            btn.onClick(() => {
                if (!this.passwordInput)
                    return;
                const isHidden = this.passwordInput.type === "password";
                this.passwordInput.type = isHidden ? "text" : "password";
                btn.setIcon(isHidden ? "eye-off" : "eye");
            });
        });
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeUnlockAutoUnlock"))
            .addToggle((toggle) => {
            toggle.setValue(this.autoUnlock);
            toggle.onChange((v) => (this.autoUnlock = v));
        });
        new obsidian.Setting(contentEl).addButton((btn) => btn
            .setButtonText(this.t("e2eeUnlockButton"))
            .setCta()
            .onClick(async () => {
            try {
                const blob = await this.plugin.syncManager.vaultLockService.downloadLockFile();
                const hashedPassword = await hashPassword(this.password);
                await this.plugin.syncManager.cryptoEngine.unlockVault(blob, hashedPassword);
                await this.plugin.syncManager.notify("e2eeUnlockSuccess");
                // Sync auto-unlock setting (non-critical, don't block unlock)
                try {
                    this.plugin.settings.e2eeAutoUnlock = this.autoUnlock;
                    await this.plugin.saveSettings();
                    if (this.autoUnlock && this.plugin.syncManager.secureStorage) {
                        await this.plugin.syncManager.secureStorage.setExtraSecret("e2ee-password", hashedPassword);
                    }
                    else if (!this.autoUnlock && this.plugin.syncManager.secureStorage) {
                        await this.plugin.syncManager.secureStorage.deleteExtraSecret("e2ee-password");
                    }
                }
                catch (err) {
                    console.error("Failed to save auto-unlock preference", err);
                }
                this.close();
                this.plugin.refreshSettingsUI?.();
            }
            catch (e) {
                await this.plugin.syncManager.notify("e2eeUnlockFailed");
                console.error(e);
            }
        }));
    }
}
/**
 * Password Change Modal
 */
class E2EEPasswordChangeModal extends obsidian.Modal {
    plugin;
    newPassword = "";
    confirmPassword = "";
    passwordInput;
    confirmInput;
    strengthIndicator;
    changeBtn;
    asciiWarning;
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    t(key) {
        return this.plugin.i18n?.(key) || key;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.t("e2eeChangePasswordTitle") });
        const desc = contentEl.createEl("p");
        setTextWithBreaks(desc, this.t("e2eeChangePasswordDesc"));
        // New password input with show/hide toggle
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeChangePasswordNewLabel"))
            .addText((text) => {
            this.passwordInput = text.inputEl;
            text.inputEl.type = "password";
            text.inputEl.setAttribute("autocomplete", "new-password");
            text.onChange((v) => {
                if (!ASCII_PRINTABLE.test(v)) {
                    const filtered = v.replace(/[^\x20-\x7E]/g, "");
                    text.setValue(filtered);
                    this.newPassword = filtered;
                    this.showAsciiWarning(true);
                }
                else {
                    this.newPassword = v;
                    this.showAsciiWarning(false);
                }
                this.updateButtonState();
                this.updateStrengthIndicator(this.newPassword);
            });
        })
            .addExtraButton((btn) => {
            btn.setIcon("eye");
            btn.setTooltip("Show/Hide");
            btn.onClick(() => {
                if (!this.passwordInput)
                    return;
                const isHidden = this.passwordInput.type === "password";
                this.passwordInput.type = isHidden ? "text" : "password";
                btn.setIcon(isHidden ? "eye-off" : "eye");
            });
        });
        // ASCII-only warning (hidden by default)
        this.asciiWarning = contentEl.createDiv({ cls: "vault-sync-ascii-warning" });
        this.asciiWarning.style.cssText = "color:var(--text-error);font-size:0.85em;display:none;margin-top:-8px;margin-bottom:8px;";
        this.asciiWarning.setText(this.t("e2eeSetupAsciiOnly"));
        // Password strength indicator
        this.strengthIndicator = contentEl.createDiv({ cls: "vault-sync-password-strength" });
        // Confirm password
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeChangePasswordConfirmLabel"))
            .addText((text) => {
            this.confirmInput = text.inputEl;
            text.inputEl.type = "password";
            text.inputEl.setAttribute("autocomplete", "new-password");
            text.onChange((v) => {
                this.confirmPassword = v;
                this.updateButtonState();
            });
        });
        // Change Password button
        new obsidian.Setting(contentEl).addButton((btn) => {
            this.changeBtn = btn;
            btn.setButtonText(this.t("e2eeChangePasswordButton"))
                .setCta()
                .setDisabled(true)
                .onClick(async () => {
                btn.setDisabled(true);
                btn.setButtonText("...");
                try {
                    const engine = this.plugin.syncManager.cryptoEngine;
                    const hashedPassword = await hashPassword(this.newPassword);
                    const newBlob = await engine.updatePassword(hashedPassword);
                    await this.plugin.syncManager.vaultLockService.uploadLockFile(newBlob);
                    // Update saved auto-unlock password if enabled
                    if (this.plugin.settings.e2eeAutoUnlock && this.plugin.syncManager.secureStorage) {
                        try {
                            await this.plugin.syncManager.secureStorage.setExtraSecret("e2ee-password", hashedPassword);
                        }
                        catch (_) { /* non-critical */ }
                    }
                    await this.plugin.syncManager.notify("noticeE2EEPasswordChanged");
                    this.close();
                }
                catch (e) {
                    new obsidian.Notice(`Error: ${e.message || e}`);
                    btn.setDisabled(false);
                    btn.setButtonText(this.t("e2eeChangePasswordButton"));
                }
            });
        });
    }
    showAsciiWarning(show) {
        if (this.asciiWarning) {
            this.asciiWarning.style.display = show ? "" : "none";
        }
    }
    updateButtonState() {
        if (this.changeBtn) {
            const valid = this.newPassword.length >= 8
                && this.newPassword === this.confirmPassword;
            this.changeBtn.setDisabled(!valid);
        }
    }
    updateStrengthIndicator(password) {
        if (!this.strengthIndicator)
            return;
        this.strengthIndicator.empty();
        const checker = this.plugin.checkPasswordStrength;
        if (!checker || !password)
            return;
        const result = checker(password);
        const barContainer = this.strengthIndicator.createDiv({ cls: "vault-sync-strength-bar-container" });
        barContainer.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";
        const colors = {
            weak: "var(--text-error)", fair: "var(--text-warning)",
            good: "var(--text-success)", strong: "var(--interactive-accent)",
        };
        const segmentCount = { weak: 1, fair: 2, good: 3, strong: 4 };
        const filled = segmentCount[result.strength] || 0;
        const color = colors[result.strength] || "var(--text-muted)";
        for (let i = 0; i < 4; i++) {
            const seg = barContainer.createDiv();
            seg.style.cssText = `height:4px;flex:1;border-radius:2px;background:${i < filled ? color : "var(--background-modifier-border)"};`;
        }
        const strengthKey = `passwordStrength${result.strength.charAt(0).toUpperCase() + result.strength.slice(1)}`;
        const label = this.t(strengthKey);
        const labelEl = this.strengthIndicator.createDiv();
        labelEl.style.cssText = `font-size:0.85em;color:${color};`;
        labelEl.setText(label);
        if (result.feedback.length > 0) {
            const feedbackEl = this.strengthIndicator.createDiv();
            feedbackEl.style.cssText = "font-size:0.8em;color:var(--text-muted);margin-top:2px;";
            feedbackEl.setText(result.feedback.map((key) => this.t(key)).join(". "));
        }
    }
}
/**
 * Recovery Code Export Modal
 */
class E2EERecoveryExportModal extends obsidian.Modal {
    plugin;
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    t(key) {
        return this.plugin.i18n?.(key) || key;
    }
    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.t("e2eeRecoveryExportTitle") });
        contentEl.createEl("p", { text: this.t("e2eeRecoveryExportDesc") });
        // Warning banner
        const warningEl = contentEl.createDiv({ cls: "vault-sync-recovery-warning" });
        warningEl.style.cssText = "background:var(--background-modifier-error);padding:8px 12px;border-radius:4px;margin-bottom:12px;";
        warningEl.setText(this.t("e2eeRecoveryWarning"));
        const engine = this.plugin.syncManager.cryptoEngine;
        // Recovery code (read-only textarea)
        const code = await engine.exportRecoveryCode();
        const codeArea = contentEl.createEl("textarea");
        codeArea.value = code;
        codeArea.readOnly = true;
        codeArea.rows = 2;
        codeArea.style.cssText = "width:100%;font-family:monospace;font-size:14px;margin-bottom:8px;";
        // Key fingerprint
        const fp = await engine.getKeyFingerprint();
        contentEl.createEl("div", {
            text: `Key Fingerprint: ${fp}`,
            cls: "setting-item-description",
        });
        // Copy + Close buttons
        new obsidian.Setting(contentEl)
            .addButton((btn) => btn.setButtonText(this.t("e2eeRecoveryCopy")).onClick(() => {
            navigator.clipboard.writeText(code);
            btn.setButtonText(this.t("e2eeRecoveryCopied"));
            setTimeout(() => btn.setButtonText(this.t("e2eeRecoveryCopy")), 2000);
        }))
            .addButton((btn) => btn.setButtonText(this.t("e2eeRecoveryClose")).onClick(() => this.close()));
    }
}
/**
 * Recovery Code Import (Restore) Modal
 */
class E2EERecoveryImportModal extends obsidian.Modal {
    plugin;
    recoveryCode = "";
    newPassword = "";
    confirmPassword = "";
    passwordInput;
    strengthIndicator;
    restoreBtn;
    asciiWarning;
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    t(key) {
        return this.plugin.i18n?.(key) || key;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.t("e2eeRecoveryImportTitle") });
        contentEl.createEl("p", { text: this.t("e2eeRecoveryImportDesc") });
        // Recovery code input
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeRecoveryCodeLabel"))
            .addTextArea((text) => {
            text.inputEl.rows = 2;
            text.inputEl.style.cssText = "width:100%;font-family:monospace;";
            text.onChange((val) => {
                this.recoveryCode = val.trim();
                this.updateButtonState();
            });
        });
        // New password
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeChangePasswordNewLabel"))
            .addText((text) => {
            this.passwordInput = text.inputEl;
            text.inputEl.type = "password";
            text.inputEl.setAttribute("autocomplete", "new-password");
            text.onChange((v) => {
                if (!ASCII_PRINTABLE.test(v)) {
                    const filtered = v.replace(/[^\x20-\x7E]/g, "");
                    text.setValue(filtered);
                    this.newPassword = filtered;
                    this.showAsciiWarning(true);
                }
                else {
                    this.newPassword = v;
                    this.showAsciiWarning(false);
                }
                this.updateButtonState();
                this.updateStrengthIndicator(this.newPassword);
            });
        })
            .addExtraButton((btn) => {
            btn.setIcon("eye");
            btn.setTooltip("Show/Hide");
            btn.onClick(() => {
                if (!this.passwordInput)
                    return;
                const isHidden = this.passwordInput.type === "password";
                this.passwordInput.type = isHidden ? "text" : "password";
                btn.setIcon(isHidden ? "eye-off" : "eye");
            });
        });
        // ASCII-only warning
        this.asciiWarning = contentEl.createDiv({ cls: "vault-sync-ascii-warning" });
        this.asciiWarning.style.cssText = "color:var(--text-error);font-size:0.85em;display:none;margin-top:-8px;margin-bottom:8px;";
        this.asciiWarning.setText(this.t("e2eeSetupAsciiOnly"));
        // Password strength indicator
        this.strengthIndicator = contentEl.createDiv({ cls: "vault-sync-password-strength" });
        // Confirm password
        new obsidian.Setting(contentEl)
            .setName(this.t("e2eeChangePasswordConfirmLabel"))
            .addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.setAttribute("autocomplete", "new-password");
            text.onChange((v) => {
                this.confirmPassword = v;
                this.updateButtonState();
            });
        });
        // Restore button
        new obsidian.Setting(contentEl).addButton((btn) => {
            this.restoreBtn = btn;
            btn.setButtonText(this.t("e2eeRecoveryRestoreButton"))
                .setCta()
                .setDisabled(true)
                .onClick(async () => {
                btn.setDisabled(true);
                btn.setButtonText("...");
                try {
                    const engine = this.plugin.syncManager.cryptoEngine;
                    const newBlob = await engine.recoverFromCode(this.recoveryCode, this.newPassword);
                    await this.plugin.syncManager.vaultLockService.uploadLockFile(newBlob);
                    // Save new password for auto-unlock
                    if (this.plugin.syncManager.secureStorage) {
                        try {
                            const hashedPassword = await hashPassword(this.newPassword);
                            await this.plugin.syncManager.secureStorage.setExtraSecret("e2ee-password", hashedPassword);
                        }
                        catch (_) { /* non-critical */ }
                    }
                    await this.plugin.syncManager.notify("noticeE2EERecoveryComplete");
                    this.close();
                    this.plugin.refreshSettingsUI?.();
                }
                catch (e) {
                    new obsidian.Notice(`Recovery failed: ${e.message || e}`);
                    btn.setDisabled(false);
                    btn.setButtonText(this.t("e2eeRecoveryRestoreButton"));
                }
            });
        });
    }
    showAsciiWarning(show) {
        if (this.asciiWarning) {
            this.asciiWarning.style.display = show ? "" : "none";
        }
    }
    updateButtonState() {
        if (this.restoreBtn) {
            const valid = this.recoveryCode.length > 0
                && this.newPassword.length >= 8
                && this.newPassword === this.confirmPassword;
            this.restoreBtn.setDisabled(!valid);
        }
    }
    updateStrengthIndicator(password) {
        if (!this.strengthIndicator)
            return;
        this.strengthIndicator.empty();
        const checker = this.plugin.checkPasswordStrength;
        if (!checker || !password)
            return;
        const result = checker(password);
        const barContainer = this.strengthIndicator.createDiv({ cls: "vault-sync-strength-bar-container" });
        barContainer.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";
        const colors = {
            weak: "var(--text-error)", fair: "var(--text-warning)",
            good: "var(--text-success)", strong: "var(--interactive-accent)",
        };
        const segmentCount = { weak: 1, fair: 2, good: 3, strong: 4 };
        const filled = segmentCount[result.strength] || 0;
        const color = colors[result.strength] || "var(--text-muted)";
        for (let i = 0; i < 4; i++) {
            const seg = barContainer.createDiv();
            seg.style.cssText = `height:4px;flex:1;border-radius:2px;background:${i < filled ? color : "var(--background-modifier-border)"};`;
        }
        const strengthKey = `passwordStrength${result.strength.charAt(0).toUpperCase() + result.strength.slice(1)}`;
        const label = this.t(strengthKey);
        const labelEl = this.strengthIndicator.createDiv();
        labelEl.style.cssText = `font-size:0.85em;color:${color};`;
        labelEl.setText(label);
        if (result.feedback.length > 0) {
            const feedbackEl = this.strengthIndicator.createDiv();
            feedbackEl.style.cssText = "font-size:0.8em;color:var(--text-muted);margin-top:2px;";
            feedbackEl.setText(result.feedback.map((key) => this.t(key)).join(". "));
        }
    }
}

class MasterKeyManager {
    masterKey = null;
    isUnlocked() {
        return this.masterKey !== null;
    }
    async initializeNewVault(password) {
        const mk = await generateMasterKey();
        this.masterKey = mk;
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const wk = await deriveKey(password, salt);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const wrappedKeyBuffer = await window.crypto.subtle.wrapKey("raw", mk, wk, {
            name: "AES-GCM",
            iv,
        });
        const lockData = {
            salt: this.arrayBufferToBase64(salt),
            encryptedMasterKey: this.arrayBufferToBase64(wrappedKeyBuffer),
            iv: this.arrayBufferToBase64(iv),
            algo: "PBKDF2-SHA256-100k-AES-GCM-256",
        };
        return await this.wrapLockFile(lockData, password);
    }
    async updatePassword(password) {
        if (!this.masterKey)
            throw new Error("Vault is locked. Unlock first.");
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const wk = await deriveKey(password, salt);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const wrappedKeyBuffer = await window.crypto.subtle.wrapKey("raw", this.masterKey, wk, {
            name: "AES-GCM",
            iv,
        });
        const lockData = {
            salt: this.arrayBufferToBase64(salt),
            encryptedMasterKey: this.arrayBufferToBase64(wrappedKeyBuffer),
            iv: this.arrayBufferToBase64(iv),
            algo: "PBKDF2-SHA256-100k-AES-GCM-256",
        };
        return await this.wrapLockFile(lockData, password);
    }
    async unlockVault(encryptedBlob, password) {
        // Outer layer: fast password check via AES-GCM(SHA-256(hashedPassword))
        let lockData;
        try {
            lockData = await this.unwrapLockFile(encryptedBlob, password);
        }
        catch (e) {
            this.masterKey = null;
            throw new Error("Invalid password");
        }
        // Inner layer: PBKDF2-derived key unwraps the master key
        const salt = this.base64ToArrayBuffer(lockData.salt);
        const iv = this.base64ToArrayBuffer(lockData.iv);
        const wrappedKeyBuffer = this.base64ToArrayBuffer(lockData.encryptedMasterKey);
        const wk = await deriveKey(password, new Uint8Array(salt));
        try {
            this.masterKey = await window.crypto.subtle.unwrapKey("raw", wrappedKeyBuffer, wk, { name: "AES-GCM", iv: new Uint8Array(iv) }, "AES-GCM", true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
        }
        catch (e) {
            this.masterKey = null;
            throw new Error("Invalid password");
        }
    }
    async encrypt(data) {
        if (!this.masterKey)
            throw new Error("Locked");
        return await encryptData(this.masterKey, data);
    }
    async decrypt(ciphertext, iv) {
        if (!this.masterKey)
            throw new Error("Locked");
        return await decryptData(this.masterKey, ciphertext, iv);
    }
    async exportRecoveryCode() {
        if (!this.masterKey)
            throw new Error("Vault is locked.");
        const rawKey = await window.crypto.subtle.exportKey("raw", this.masterKey);
        return btoa(String.fromCharCode(...new Uint8Array(rawKey)));
    }
    async recoverFromCode(recoveryCode, newPassword) {
        const rawBytes = Uint8Array.from(atob(recoveryCode), c => c.charCodeAt(0));
        if (rawBytes.byteLength !== 32)
            throw new Error("Invalid recovery code length.");
        const restoredKey = await window.crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
        this.masterKey = restoredKey;
        const hashedPassword = await hashPassword(newPassword);
        return this.updatePassword(hashedPassword);
    }
    async getKeyFingerprint() {
        if (!this.masterKey)
            throw new Error("Vault is locked.");
        const rawKey = await window.crypto.subtle.exportKey("raw", this.masterKey);
        const hash = await window.crypto.subtle.digest("SHA-256", rawKey);
        return Array.from(new Uint8Array(hash).slice(0, 4))
            .map(b => b.toString(16).padStart(2, "0")).join("");
    }
    showSetupModal(plugin) {
        new E2EESetupModal(plugin.app, plugin).open();
    }
    showUnlockModal(plugin) {
        new E2EEUnlockModal(plugin.app, plugin).open();
    }
    showPasswordChangeModal(plugin) {
        new E2EEPasswordChangeModal(plugin.app, plugin).open();
    }
    showRecoveryExportModal(plugin) {
        new E2EERecoveryExportModal(plugin.app, plugin).open();
    }
    showRecoveryImportModal(plugin) {
        new E2EERecoveryImportModal(plugin.app, plugin).open();
    }
    getSettingsSections(plugin) {
        const t = (key) => plugin.t?.(key) || plugin.syncManager?.t?.(key) || key;
        return [
            {
                id: "security",
                title: t("settingSecuritySection") || "Security (E2EE)",
                items: [
                    {
                        key: "e2eeStatusDisp",
                        type: "info",
                        label: t("settingE2EEStatus") || "Encryption Status",
                        desc: t("settingE2EEStatusGuide") || "Manage via Command Palette.",
                        getDesc: (s, p) => {
                            if (!s.e2eeEnabled)
                                return t("settingE2EEStatusDisabled") || "Disabled";
                            if (p.syncManager?.cryptoEngine?.isUnlocked?.())
                                return t("settingE2EEStatusUnlocked") || "Unlocked";
                            return t("settingE2EEStatusLocked") || "Locked";
                        },
                    },
                ],
            },
        ];
    }
    // --- Outer encryption: vault-lock file wrapping ---
    async wrapLockFile(lockData, hashedPassword) {
        const outerKey = await deriveOuterKey(hashedPassword);
        const plaintext = new TextEncoder().encode(JSON.stringify(lockData));
        const { iv, ciphertext } = await encryptData(outerKey, plaintext.buffer);
        // Combine: [iv (12 bytes)][ciphertext]
        const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);
        return btoa(String.fromCharCode(...combined));
    }
    async unwrapLockFile(blob, hashedPassword) {
        const outerKey = await deriveOuterKey(hashedPassword);
        const binaryStr = atob(blob);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++)
            bytes[i] = binaryStr.charCodeAt(i);
        const iv = bytes.slice(0, 12);
        const ciphertext = bytes.slice(12);
        const plaintext = await decryptData(outerKey, ciphertext.buffer, iv);
        return JSON.parse(new TextDecoder().decode(plaintext));
    }
    // --- Helpers ---
    arrayBufferToBase64(buffer) {
        return btoa(String.fromCharCode(...new Uint8Array(buffer)));
    }
    base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

// Register the engine to a global object so the main plugin can find it
const engine = new MasterKeyManager();
console.log("VaultSync E2EE Engine ready for loading.");

module.exports = engine;
//# sourceMappingURL=e2ee-engine.js.map
