import { Plugin, ProtyleMethod, Dialog, Menu, fetchSyncPost, openTab, openMobileFileById, getFrontend, getAllEditor, showMessage, type IProtyle } from "siyuan";
import "./index.scss";
import SettingPanel from "./SettingPanel.svelte";
import { normalizeSettings, type OutlineSettings } from "./defaultSettings";
import { ListOutlineController } from "./listOutline";
import { HeadingOutlineController, type HeadingEditor } from "./headingOutline";
import { HeadingOutlineDockView, type OpenHeadingLevelMenu } from "./headingDock";
import { HeadingGutterController } from "./headingGutter";
import type { HeadingFoldState } from "./headingTree";
import { HEADING_OUTLINE_ICON, HEADING_OUTLINE_ICON_ID } from "./icons";
import { insertOutlineSibling, insertIntoOutlineEditor, type OutlineInsertTarget, type OpenInsertMenu } from "./outlineInsert";

const SETTINGS_FILE = "settings.json";
const HEADING_FOLDS_FILE = "heading-folds.json";
const HEADING_LEVEL_LABELS = ["一级标题块", "二级标题块", "三级标题块", "四级标题块", "五级标题块", "六级标题块"];

export default class ListOutlinePlugin extends Plugin {
    settings: OutlineSettings = normalizeSettings();
    private outline?: ListOutlineController;
    private headingOutline?: HeadingOutlineController;
    private headingDock?: HeadingOutlineDockView;
    private headingGutters?: HeadingGutterController;
    private disposed = false;
    private settingsQueue: Promise<unknown> = Promise.resolve();
    private headingFoldQueue: Promise<unknown> = Promise.resolve();
    private headingFoldStates: Record<string, HeadingFoldState> = {};
    private dialogs = new Set<Dialog>();
    private insertMenu?: Menu;
    private headingLevelMenu?: Menu;
    private inserting = new Set<string>();
    private headingDockRegistered = false;

    private registerHeadingDock() {
        if (this.headingDockRegistered) return;
        const dockId = `${this.name}_heading_dock1`;
        this.addDock({
            id: dockId,
            config: {
                position: "RightTop",
                size: { width: 260, height: 0 },
                icon: HEADING_OUTLINE_ICON_ID,
                title: "大纲增强",
            },
            data: { plugin: this },
            type: dockId,
            init: dock => {
                this.headingDock = new HeadingOutlineDockView(dock.element as HTMLElement, {
                    getEditors: this.getHeadingEditors,
                    getSettings: () => this.settings,
                    setListDepth: depth => this.saveSettings({ ...this.settings, headingListDepth: depth }),
                    setKeepCurrentHeadingExpanded: enabled => this.saveSettings({
                        ...this.settings, keepCurrentHeadingExpanded: enabled,
                    }),
                    getFoldState: documentId => this.headingFoldStates[documentId],
                    saveFoldState: this.saveHeadingFoldState,
                    openInsertMenu: this.openInsertMenu,
                    openHeadingLevelMenu: this.openHeadingLevelMenu,
                    isMobile: () => getFrontend().includes("mobile"),
                    newNodeID: () => window.Lute.NewNodeID(),
                    renderMath: element => ProtyleMethod.mathRender(element),
                    request: this.request,
                    navigate: (id, folded, documentTop) => {
                        const mobile = getFrontend().includes("mobile");
                        const action = mobile ? "cb-get-hl" : "cb-get-focus";
                        const actions: Parameters<typeof openMobileFileById>[2] = folded
                            ? [action, "cb-get-all", "cb-get-html", "cb-get-outline"]
                            : [action, "cb-get-outline", "cb-get-setid", "cb-get-context", "cb-get-html"];
                        if (mobile) openMobileFileById(this.app, id, actions);
                        else void openTab({ app: this.app, doc: { id, action: actions,
                            ...(documentTop ? { zoomIn: true } : {}) } });
                    },
                    reportError: message => showMessage(message, 5000, "error"),
                });
            },
            destroy: () => {
                this.headingDock?.destroy();
                this.headingDock = undefined;
            },
            update: () => {
                this.headingDock?.syncEditors();
            },
            resize: () => {
                this.headingDock?.scheduleHighlight();
            },
        });
        this.headingDockRegistered = true;
    }

    private unregisterHeadingDock() {
        if (!this.headingDockRegistered) return;
        // 先断开引用，避免 removeDock 触发 destroy 回调时重复销毁视图。
        const dock = this.headingDock;
        this.headingDock = undefined;
        try {
            this.removeDock(`${this.name}_heading_dock1`);
        } finally {
            dock?.destroy();
            this.headingDockRegistered = false;
        }
    }

    async onload() {
        this.disposed = false;
        try {
            this.settings = normalizeSettings(await this.loadData(SETTINGS_FILE) || {});
        } catch (error) {
            console.error("列表大纲：加载设置失败", error);
        }
        try {
            const stored = await this.loadData(HEADING_FOLDS_FILE);
            if (stored && typeof stored === "object" && !Array.isArray(stored)) {
                for (const [documentId, value] of Object.entries(stored)) {
                    if (!value || typeof value !== "object" || !Array.isArray((value as HeadingFoldState).collapsedIds)) continue;
                    this.headingFoldStates[documentId] = {
                        collapsedIds: (value as HeadingFoldState).collapsedIds.filter(id => typeof id === "string"),
                        showLists: (value as HeadingFoldState).showLists === true,
                        expandedListIds: Array.isArray((value as HeadingFoldState).expandedListIds)
                            ? (value as HeadingFoldState).expandedListIds!.filter(id => typeof id === "string") : [],
                        expandedTabIds: Array.isArray((value as HeadingFoldState).expandedTabIds)
                            ? (value as HeadingFoldState).expandedTabIds!.filter(id => typeof id === "string") : [],
                    };
                }
            }
        } catch (error) {
            console.error("列表大纲：加载标题折叠状态失败", error);
        }
        if (this.disposed) return;

        this.addIcons(HEADING_OUTLINE_ICON);
        if (this.settings.enableHeadingDock) this.registerHeadingDock();

        for (const event of this.protyleEvents) this.eventBus.on(event, this.onProtyle);
        this.eventBus.on("ws-main", this.onWorkspaceMessage);
        this.syncFeatures();
    }

    private protyleEvents = ["loaded-protyle-static", "loaded-protyle-dynamic", "switch-protyle", "switch-protyle-mode", "destroy-protyle"] as const;

    private onProtyle = (event: CustomEvent<{ protyle: IProtyle }>) => {
        this.headingGutters?.syncEditors();
        this.headingOutline?.syncEditors(event.detail.protyle.element);
        this.headingDock?.syncEditors(event.detail.protyle.element);
        if (event.type.startsWith("loaded-")) {
            this.headingOutline?.scheduleRefresh();
            this.headingDock?.scheduleRefresh();
        }
        this.outline?.scheduleSync();
    };

    private onWorkspaceMessage = (event: CustomEvent<{ cmd: string }>) => {
        // 原生大纲在 savedoc 后重新读取标题，兼顾同步、撤销和标题编号变更。
        if (["savedoc", "transactions", "reload", "rename"].includes(event.detail.cmd)) {
            this.headingOutline?.scheduleRefresh();
            this.headingDock?.scheduleRefresh();
            this.outline?.scheduleSync();
        }
    };

    onLayoutReady() {
        this.headingGutters?.syncEditors();
        this.headingOutline?.syncEditors();
        this.headingDock?.syncEditors();
        this.outline?.scheduleSync();
    }

    private request = async (url: string, data: Record<string, unknown>) => {
        const response = await fetchSyncPost(url, data);
        if (!response || response.code !== 0) throw new Error(response?.msg || "请求失败");
        return response.data;
    };

    private getHeadingEditors = (): HeadingEditor[] => getAllEditor().flatMap(editor => {
        const protyle = editor?.protyle;
        if (!protyle?.block?.rootID || !protyle.element) return [];
        const preview = !!protyle.preview?.element && !protyle.preview.element.classList.contains("fn__none");
        const content = preview ? protyle.preview.element : protyle.wysiwyg?.element;
        if (!content) return [];
        return [{ element: protyle.element, content, rootID: protyle.block.rootID,
            documentTitle: String(protyle.title?.editElement?.textContent ?? protyle.background?.ial?.title ?? ""),
            notebook: protyle.notebookId, preview, disabled: protyle.disabled,
            transaction: editor.transaction.bind(editor) }];
    });

    private syncFeatures() {
        this.insertMenu?.close();
        this.headingLevelMenu?.close();
        if (this.settings.enableHeadingGutters && !this.headingGutters) {
            this.headingGutters = new HeadingGutterController({
                getEditors: () => getAllEditor().flatMap(editor => editor?.protyle ? [editor.protyle] : []),
            });
        }
        if (!this.settings.enableHeadingGutters) {
            this.headingGutters?.destroy();
            this.headingGutters = undefined;
        }
        if (this.settings.enableHeadingDock) this.registerHeadingDock();
        else this.unregisterHeadingDock();
        if (this.settings.enableListOutline && !this.outline) this.outline = new ListOutlineController({
            renderMath: element => ProtyleMethod.mathRender(element),
            getSettings: () => this.settings,
            request: this.request,
            openInsertMenu: this.openInsertMenu,
            navigate: id => {
                if (getFrontend().includes("mobile")) {
                    openMobileFileById(this.app, id, ["cb-get-hl"]);
                } else {
                    void openTab({ app: this.app, doc: { id, action: ["cb-get-hl"] } });
                }
            },
            reportError: message => showMessage(message, 5000, "error"),
        });
        if (!this.settings.enableListOutline) {
            this.outline?.destroy();
            this.outline = undefined;
        }
        if (this.settings.enableHeadingOutline && !this.headingOutline) this.headingOutline = new HeadingOutlineController({
            getEditors: this.getHeadingEditors,
            isMobile: () => getFrontend().includes("mobile"),
            newNodeID: () => window.Lute.NewNodeID(),
            renderMath: element => ProtyleMethod.mathRender(element),
            getSettings: () => this.settings,
            setListDepth: depth => this.saveSettings({ ...this.settings, headingListDepth: depth }),
            getFoldState: documentId => this.headingFoldStates[documentId],
            saveFoldState: this.saveHeadingFoldState,
            openInsertMenu: this.openInsertMenu,
            openHeadingLevelMenu: this.openHeadingLevelMenu,
            request: this.request,
            navigate: (id, folded) => {
                const mobile = getFrontend().includes("mobile");
                const action = mobile ? "cb-get-hl" : "cb-get-focus";
                const actions: Parameters<typeof openMobileFileById>[2] = folded
                    ? [action, "cb-get-all", "cb-get-html", "cb-get-outline"]
                    : [action, "cb-get-outline", "cb-get-setid", "cb-get-context", "cb-get-html"];
                if (mobile) openMobileFileById(this.app, id, actions);
                else void openTab({ app: this.app, doc: { id, action: actions } });
            },
            reportError: message => showMessage(message, 5000, "error"),
        });
        if (!this.settings.enableHeadingOutline) {
            this.headingOutline?.destroy();
            this.headingOutline = undefined;
        }
        this.outline?.refreshSettings();
        this.headingOutline?.refreshSettings();
        this.headingDock?.refreshSettings();
    }

    onunload() {
        this.disposed = true;
        this.insertMenu?.close();
        this.headingLevelMenu?.close();
        this.headingGutters?.destroy();
        this.headingGutters = undefined;
        this.outline?.destroy();
        this.outline = undefined;
        this.headingOutline?.destroy();
        this.headingOutline = undefined;
        this.unregisterHeadingDock();
        for (const event of this.protyleEvents) this.eventBus.off(event, this.onProtyle);
        this.eventBus.off("ws-main", this.onWorkspaceMessage);
        this.dialogs.forEach(dialog => dialog.destroy());
        this.dialogs.clear();
    }

    async saveSettings(settings: OutlineSettings) {
        const next = normalizeSettings(settings);
        const save = this.settingsQueue.then(async () => {
            await this.saveData(SETTINGS_FILE, next);
            this.settings = next;
            if (!this.disposed) this.syncFeatures();
        });
        this.settingsQueue = save.catch(() => {});
        await save;
        return next;
    }

    private saveHeadingFoldState = (documentId: string, state: HeadingFoldState): Promise<unknown> => {
        this.headingFoldStates[documentId] = state;
        this.headingDock?.applyFoldState(documentId, state);
        this.headingOutline?.applyFoldState(documentId, state);
        const snapshot = { ...this.headingFoldStates };
        const save = this.headingFoldQueue.then(() => this.saveData(HEADING_FOLDS_FILE, snapshot));
        this.headingFoldQueue = save.catch(() => {});
        return save;
    };

    private canInsert(target: OutlineInsertTarget) {
        const headingAvailable = this.settings.enableHeadingOutline || this.settings.enableHeadingDock;
        if (this.disposed || !(target.kind === "heading" ? headingAvailable :
            this.settings.enableListOutline || (headingAvailable && this.settings.headingListDepth > 0))) return false;
        const protyle = getAllEditor().find(editor => editor?.protyle?.element === target.editor || editor?.protyle?.element.contains(target.editor))?.protyle;
        return !!protyle && protyle.element.isConnected && !protyle.disabled && !protyle.options?.action?.includes("cb-get-history");
    }

    private openInsertMenu: OpenInsertMenu = (event, target, onInserted, onClose) => {
        event.preventDefault();
        event.stopPropagation();
        this.insertMenu?.close();
        let closed = false;
        const handleClose = () => {
            if (closed) return;
            closed = true;
            if (this.insertMenu === menu) this.insertMenu = undefined;
            onClose?.();
        };
        const menu = new Menu(`${this.name}-outline-insert`, handleClose);
        this.insertMenu = menu;
        const noun = target.kind === "heading" ? "同级标题" : "同级列表项";
        for (const direction of ["before", "after"] as const) menu.addItem({
            icon: direction === "before" ? "iconBefore" : "iconAfter",
            label: `${direction === "before" ? "向前" : "向后"}插入${noun}`,
            disabled: !this.canInsert(target) || this.inserting.has(target.id),
            click: async () => {
                if (!this.canInsert(target) || this.inserting.has(target.id)) return;
                this.inserting.add(target.id);
                let inserted = false;
                try {
                    let insertedInEditor = false;
                    const id = await insertOutlineSibling(target, direction, this.request,
                        () => (window as any).Lute.NewNodeID(), () => this.canInsert(target), operation => {
                            const editor = getAllEditor().find(item => item.protyle?.element === target.editor || item.protyle?.element.contains(target.editor));
                            const content = editor?.protyle.wysiwyg?.element;
                            if (!content || !editor.protyle.preview?.element.classList.contains("fn__none")) return false;
                            insertedInEditor = insertIntoOutlineEditor(content, operation,
                                (insert, undo) => editor.transaction([insert], [undo]));
                            return insertedInEditor;
                        });
                    inserted = true;
                    if (this.disposed) return;
                    onInserted();
                    if (insertedInEditor) return;
                    if (getFrontend().includes("mobile")) openMobileFileById(this.app, id, ["cb-get-focus", "cb-get-context", "cb-get-html"]);
                    else await openTab({ app: this.app, doc: { id, action: ["cb-get-focus", "cb-get-context", "cb-get-html"] } });
                } catch (error) {
                    console.error("大纲插入失败", error);
                    if (!this.disposed) showMessage(inserted ? "已插入新块，但自动定位失败，请在文档中查看。" : `插入失败：${error.message || "请重试"}`, 5000, "error");
                } finally { this.inserting.delete(target.id); }
            },
        });
        menu.open({ x: event.clientX, y: event.clientY });
    };

    private openHeadingLevelMenu: OpenHeadingLevelMenu = (target, currentLevel, selectLevel, onClose) => {
        this.headingLevelMenu?.close();
        const menu = new Menu(`${this.name}-heading-expand-level`, () => {
            if (this.headingLevelMenu === menu) this.headingLevelMenu = undefined;
            onClose?.();
        });
        this.headingLevelMenu = menu;
        for (let level = 1; level <= 6; level++) {
            menu.addItem({
                icon: `iconH${level}`,
                label: HEADING_LEVEL_LABELS[level - 1],
                current: currentLevel === level,
                click: () => selectLevel(level),
            });
        }
        const rect = target.getBoundingClientRect();
        menu.open({ x: rect.left, y: rect.bottom, h: rect.height });
    };

    openSetting() {
        let panel: SettingPanel;
        const dialog = new Dialog({
            title: "悬浮大纲设置",
            content: '<div class="list-outline-settings"></div>',
            width: "560px",
            destroyCallback: () => {
                panel?.$destroy();
                this.dialogs.delete(dialog);
            },
        });
        dialog.element.classList.add("list-outline-settings-dialog");
        panel = new SettingPanel({
            target: dialog.element.querySelector(".list-outline-settings"),
            props: { plugin: this },
        });
        this.dialogs.add(dialog);
    }
}
