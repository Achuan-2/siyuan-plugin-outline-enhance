import { expandCollapsedAncestors, filterCollapsedEntries, filterHeadingListEntries, findClosestHeadingOutlineTargetId, findEmbeddedOutlineTarget,
    flattenHeadingTree, getCollapsibleEntryIds, getEffectiveCollapsedIds, getHeadingOutlineTargetSelector, includeListsInHeadingTree,
    type HeadingEntry, type HeadingFoldState } from "./headingTree";
import { getDefaultSettings, MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import type { HeadingEditor } from "./headingOutline";
import type { OpenInsertMenu } from "./outlineInsert";
import { createOutlineFoldButton, createOutlineLabel } from "./outlineView";
import { applyListUpdateOperations, canDragListItem, createHeadingMovePlan, createListItemMovePlan,
    type HeadingDropPosition, type OutlineMoveOperation } from "./headingDrag";

export type OpenHeadingLevelMenu = (
    target: HTMLElement,
    currentLevel: number,
    selectLevel: (level: number) => void,
    onClose?: () => void,
) => void;

export interface HeadingDockOptions {
    getEditors(): HeadingEditor[];
    request(url: string, data: Record<string, unknown>): Promise<any>;
    navigate(id: string, folded: boolean, documentTop?: boolean): void;
    reportError(message: string): void;
    openInsertMenu?: OpenInsertMenu;
    openHeadingLevelMenu?: OpenHeadingLevelMenu;
    getSettings?(): OutlineSettings;
    setListDepth?(depth: number): Promise<unknown>;
    setKeepCurrentHeadingExpanded?(enabled: boolean): Promise<unknown>;
    getFoldState?(documentId: string): HeadingFoldState | undefined;
    saveFoldState?(documentId: string, state: HeadingFoldState): Promise<unknown>;
    isMobile?(): boolean;
    newNodeID?(): string;
    renderMath?(element: HTMLElement): void;
}

interface OutlineDragState {
    editor: HeadingEditor;
    sourceKind: "heading" | "list";
    sourceID: string;
    sourceRow: HTMLButtonElement;
    startX: number;
    startY: number;
    dragging: boolean;
    ghost?: HTMLElement;
    targetID?: string;
    position?: HeadingDropPosition;
}

function createToolbarButton(
    label: string,
    icon: string,
    action: string,
    onClick: (button: HTMLButtonElement, event: MouseEvent) => void,
) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "block__icon b3-tooltips b3-tooltips__s";
    button.dataset.action = action;
    button.setAttribute("aria-label", label);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${icon}`);
    svg.append(use);
    button.append(svg);
    button.addEventListener("click", event => onClick(button, event));
    return button;
}

export class HeadingOutlineDockView {
    public readonly rootElement = document.createElement("div");
    private header = document.createElement("div");
    private documentTitle = document.createElement("button");
    private documentTitleText = document.createElement("span");
    private body = document.createElement("div");
    private status = document.createElement("div");
    private listDepthSelect = document.createElement("select");
    private searchInput = document.createElement("input");
    private editor: HeadingEditor | null = null;
    private entries: HeadingEntry[] = [];
    private currentEntryId = "";
    private collapsedEntryIds = new Set<string>();
    private expandedListEntryIds = new Set<string>();
    private expandedTabIds = new Set<string>();
    private expandedHeadingLevel = 6;
    private showListEntries = false;
    private keepCurrentExpandButton?: HTMLButtonElement;
    private searchQuery = "";
    private version = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private heartbeat: ReturnType<typeof setInterval>;
    private frame = 0;
    private disposed = false;
    private observer: MutationObserver;
    private editorTargetElement: HTMLElement | null = null;
    private dragState?: OutlineDragState;
    private suppressClick = false;

    constructor(
        public readonly container: HTMLElement,
        private options: HeadingDockOptions,
    ) {
        this.rootElement.className = "heading-outline-dock fn__flex-1 fn__flex-column";
        this.rootElement.setAttribute("aria-label", "大纲增强 Dock");

        // 顶部工具栏
        this.header.className = "heading-outline-dock__header block__icons";
        const logo = document.createElement("span");
        logo.className = "block__logo";
        logo.textContent = "大纲增强";

        const space = document.createElement("span");
        space.className = "fn__flex-1";

        this.listDepthSelect.className = "b3-select heading-outline-dock__list-depth";
        this.listDepthSelect.setAttribute("aria-label", "大纲增强列表层级");
        this.listDepthSelect.title = "选择大纲增强中显示的列表层级";
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            const option = document.createElement("option");
            option.value = String(depth);
            option.textContent = depth === 0 ? "不显示列表" : `列表 ${depth} 层`;
            this.listDepthSelect.add(option);
        }
        this.listDepthSelect.value = String(this.settings.headingListDepth);
        this.listDepthSelect.addEventListener("change", async () => {
            this.listDepthSelect.disabled = true;
            try {
                const depth = Number(this.listDepthSelect.value);
                await this.options.setListDepth?.(depth);
                if (!this.disposed) {
                    this.showListEntries = depth > 0;
                    this.expandedTabIds.clear();
                    this.saveFoldState();
                    await this.refresh();
                }
            } catch (error) {
                if (!this.disposed) this.options.reportError("列表层级设置保存失败，请重试。");
            } finally {
                this.listDepthSelect.disabled = false;
                this.listDepthSelect.value = String(this.settings.headingListDepth);
            }
        });

        this.keepCurrentExpandButton = createToolbarButton("保存当前层级展开", "iconFocus", "keep-current-expand", async () => {
            const enabled = !this.settings.keepCurrentHeadingExpanded;
            this.keepCurrentExpandButton!.disabled = true;
            try {
                await this.options.setKeepCurrentHeadingExpanded?.(enabled);
                if (!this.disposed) {
                    this.syncKeepCurrentExpandButton();
                    if (enabled) this.highlight(true, true);
                }
            } catch (error) {
                if (!this.disposed) this.options.reportError("保存当前层级展开设置失败，请重试。");
            } finally {
                if (!this.disposed) this.keepCurrentExpandButton!.disabled = false;
            }
        });
        this.syncKeepCurrentExpandButton();
        const expandLevelBtn = createToolbarButton("展开标题层级", "iconExpandLevel", "expand-level", (button, event) => {
            // 思源会在全局 click 处理器中关闭菜单；阻止本次点击继续冒泡，
            // 否则刚打开的标题层级菜单会在同一次点击中立即被关闭。
            event.preventDefault();
            event.stopPropagation();
            this.options.openHeadingLevelMenu?.(button, this.expandedHeadingLevel,
                level => this.expandToHeadingLevel(level));
        });
        const expandAllBtn = createToolbarButton("全部展开", "iconExpand", "expand-all", () => this.expandAll());
        const collapseAllBtn = createToolbarButton("全部折叠", "iconContract", "collapse-all", () => this.collapseAll());
        const refreshBtn = createToolbarButton("刷新大纲", "iconRefresh", "refresh", () => void this.refresh());
        const minimizeBtn = createToolbarButton("最小化大纲增强", "iconMin", "minimize", () => {});
        // Plugin.addDock 会代理 data-type="min" 的点击，并用真实运行时 type
        // 调用所属 Dock 的 toggleModel，与思源原生 Dock 的最小化行为一致。
        minimizeBtn.dataset.type = "min";

        this.header.append(logo, space);
        this.header.append(this.keepCurrentExpandButton, expandLevelBtn, expandAllBtn, collapseAllBtn, refreshBtn);
        if (!this.options.isMobile?.()) this.header.append(minimizeBtn);

        this.documentTitle.type = "button";
        this.documentTitle.className = "b3-list-item heading-outline-dock__document-title";
        this.documentTitle.hidden = true;
        const documentIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        documentIcon.classList.add("b3-list-item__graphic", "heading-outline-dock__icon");
        documentIcon.setAttribute("aria-hidden", "true");
        const documentUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
        documentUse.setAttribute("href", "#iconFile");
        documentIcon.append(documentUse);
        this.documentTitleText.className = "b3-list-item__text heading-outline-dock__text";
        this.documentTitle.append(documentIcon, this.documentTitleText);
        this.documentTitle.addEventListener("click", () => {
            const editor = this.editor;
            if (!editor) return;
            if (editor.preview) {
                const content = editor.content.querySelector<HTMLElement>(".b3-typography") || editor.content;
                content.scrollTop = 0;
                return;
            }
            // 原生控件内部调用 goHome，必要时会重新加载长文档顶部。
            const goHome = editor.element.querySelector<HTMLElement>(".protyle-scroll__up");
            if (goHome) {
                goHome.click();
                return;
            }
            this.options.navigate(editor.rootID, true, true);
        });

        // 搜索栏
        const searchContainer = document.createElement("div");
        searchContainer.className = "heading-outline-dock__search";
        const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        searchIcon.classList.add("heading-outline-dock__search-icon");
        searchIcon.setAttribute("aria-hidden", "true");
        const searchUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
        searchUse.setAttribute("href", "#iconSearch");
        searchIcon.append(searchUse);

        this.searchInput.className = "b3-text-field heading-outline-dock__search-input";
        this.searchInput.type = "search";
        this.searchInput.placeholder = "搜索标题…";
        this.searchInput.setAttribute("aria-label", "搜索标题");
        this.searchInput.addEventListener("input", () => {
            this.searchQuery = this.searchInput.value.trim();
            this.render();
        });
        this.searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Escape" && this.searchInput.value) {
                event.stopPropagation();
                this.searchInput.value = "";
                this.searchQuery = "";
                this.render();
            }
        });
        searchContainer.append(searchIcon, this.searchInput);
        if (options.setListDepth) searchContainer.append(this.listDepthSelect);

        // 列表主体与状态栏
        this.body.className = "heading-outline-dock__body b3-list b3-list--background fn__flex-1";
        this.status.className = "heading-outline-dock__status";
        this.status.setAttribute("role", "status");

        this.rootElement.append(this.header, this.documentTitle, searchContainer, this.body, this.status);
        this.container.append(this.rootElement);

        this.body.addEventListener("click", this.onClick);
        this.body.addEventListener("contextmenu", this.onContextMenu);
        this.body.addEventListener("mousedown", this.onOutlineMouseDown);
        document.addEventListener("click", this.onEditorClick);

        this.observer = new MutationObserver(records => {
            if (records.some(record => this.settings.headingListDepth > 0 || record.type !== "characterData" ||
                record.target.parentElement?.closest('[data-type="NodeHeading"],h1,h2,h3,h4,h5,h6'))) this.scheduleRefresh();
        });

        this.heartbeat = setInterval(() => this.syncEditors(), 500);
        this.syncEditors();
    }

    private get settings(): OutlineSettings {
        return this.options.getSettings?.() || getDefaultSettings();
    }

    private visible(editor: HeadingEditor) {
        return editor.element.isConnected && !editor.element.closest('.fn__none, [hidden]') &&
            editor.content.getClientRects().length > 0;
    }

    syncEditors(preferred?: HTMLElement) {
        if (this.disposed) return;
        const editors = this.options.getEditors().filter(editor => this.visible(editor));
        const editor = editors.find(item => preferred && (item.element === preferred || item.element.contains(preferred))) ||
            editors.find(item => item.element === this.editor?.element) ||
            editors.find(item => document.activeElement && item.element.contains(document.activeElement)) || editors[0] || null;

        if (!editor && !this.editor) {
            this.render();
            return;
        }

        if (editor && this.editor && editor.element === this.editor.element && editor.rootID === this.editor.rootID &&
            editor.preview === this.editor.preview && editor.content === this.editor.content) {
            const movabilityChanged = editor.disabled !== this.editor.disabled ||
                !!editor.transaction !== !!this.editor.transaction;
            // heartbeat 每次都会创建新的描述对象；原位同步可变状态，避免长拖动被误判为切换编辑器。
            this.editor.disabled = editor.disabled;
            this.editor.transaction = editor.transaction;
            this.editor.documentTitle = editor.documentTitle;
            this.renderDocumentTitle();
            if (movabilityChanged) {
                this.render();
                return;
            }
            this.highlight();
            return;
        }
        this.version++;
        clearTimeout(this.timer);
        this.observer.disconnect();
        this.editor = editor;
        this.renderDocumentTitle();
        this.entries = [];
        this.currentEntryId = "";
        const foldState = editor ? this.options.getFoldState?.(editor.rootID) : undefined;
        this.collapsedEntryIds = new Set(foldState?.collapsedIds || []);
        this.expandedListEntryIds = new Set(foldState?.expandedListIds || []);
        this.expandedTabIds = new Set(foldState?.expandedTabIds || []);
        this.showListEntries = foldState?.showLists ?? false;
        this.body.replaceChildren();
        this.body.removeAttribute("data-loading");
        this.status.textContent = "";
        if (!editor) {
            this.render();
            return;
        }
        this.observer.observe(editor.content, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ["data-type", "data-subtype", "data-content", "style", "custom-list-outline-depth", "src", "data-src", "alt", "title",
                "tabs-title", "tabs-active-id", "data-tabs-hidden"],
        });
        void this.refresh();
    }

    private onEditorClick = (event: MouseEvent) => {
        if (event.target instanceof HTMLElement && !this.rootElement.contains(event.target)) {
            this.editorTargetElement = event.target;
            this.syncEditors(event.target);
            this.highlight(true, true);
        }
    };

    scheduleRefresh() {
        if (this.disposed || !this.editor) return;
        this.version++;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 600);
    }

    async refresh() {
        if (this.disposed || !this.editor) return;
        clearTimeout(this.timer);
        const editor = this.editor;
        const version = ++this.version;
        const settings = this.settings;
        try {
            const [nodes, snapshot] = await Promise.all([
                this.options.request("/api/outline/getDocOutline", {
                    id: editor.rootID, preview: editor.preview, ...(editor.notebook ? { notebook: editor.notebook } : {}),
                }),
                settings.headingListDepth > 0 ? this.options.request("/api/block/getBlockDOM", {
                    id: editor.rootID, ...(editor.notebook ? { notebook: editor.notebook } : {}),
                }) : Promise.resolve(null),
            ]);
            if (this.disposed || version !== this.version) return;
            this.entries = flattenHeadingTree(nodes);
            if (settings.headingListDepth > 0) {
                this.entries = includeListsInHeadingTree(this.entries, snapshot?.dom || "", settings.headingListDepth,
                    editor.content, editor.preview ? editor.rootID : undefined);
            }
            this.status.textContent = "";
            this.render();
            this.body.removeAttribute("data-loading");
        } catch (error) {
            if (this.disposed || version !== this.version) return;
            console.error("大纲增强 Dock：读取失败", error);
            this.status.textContent = "读取大纲增强失败，可点击刷新重试";
            this.render();
            this.body.removeAttribute("data-loading");
        }
    }

    refreshSettings() {
        this.syncKeepCurrentExpandButton();
        const depth = this.settings.headingListDepth;
        if (Number(this.listDepthSelect.value) !== depth) {
            this.showListEntries = depth > 0;
            this.expandedListEntryIds.clear();
            this.expandedTabIds.clear();
            this.saveFoldState();
        }
        this.listDepthSelect.value = String(depth);
        if (this.settings.headingListDepth === 0) {
            this.entries = this.entries.filter(entry => !["paragraph", "list", "tab"].includes(entry.kind || ""));
            this.render();
        }
        void this.refresh();
    }

    private expandAll() {
        this.collapsedEntryIds.clear();
        this.showListEntries = true;
        this.expandedTabIds = new Set(this.entries.filter(entry => entry.kind === "tab").map(entry => entry.id));
        this.saveFoldState();
        this.render();
    }

    private collapseAll() {
        this.collapsedEntryIds = getCollapsibleEntryIds(this.entries);
        this.expandedListEntryIds.clear();
        this.expandedTabIds.clear();
        this.showListEntries = false;
        this.saveFoldState();
        this.render();
    }

    /** 与思源原生大纲一致：H1-H5 折叠该级及更深标题，H6 表示全部展开。 */
    private expandToHeadingLevel(targetLevel: number) {
        const level = Math.max(1, Math.min(6, Math.trunc(targetLevel)));
        this.expandedHeadingLevel = level;
        this.showListEntries = true;
        this.collapseToHeadingLevel(level);
        this.expandedTabIds = level === 6
            ? new Set(this.entries.filter(entry => entry.kind === "tab").map(entry => entry.id)) : new Set();
        this.saveFoldState();
        this.render();
    }

    private collapseToHeadingLevel(level: number) {
        this.collapsedEntryIds.clear();
        if (level < 6) {
            const collapsibleIds = getCollapsibleEntryIds(this.entries);
            for (const entry of this.entries) {
                const isHeading = !entry.kind || entry.kind === "heading";
                if (isHeading && entry.level >= level && collapsibleIds.has(entry.id)) {
                    this.collapsedEntryIds.add(entry.id);
                }
            }
        }
    }

    private syncKeepCurrentExpandButton() {
        const button = this.keepCurrentExpandButton;
        if (!button) return;
        const enabled = this.settings.keepCurrentHeadingExpanded;
        button.classList.toggle("block__icon--active", enabled);
        button.setAttribute("aria-pressed", String(enabled));
    }

    private saveFoldState() {
        if (!this.editor || !this.options.saveFoldState) return;
        void this.options.saveFoldState(this.editor.rootID, {
            collapsedIds: [...this.collapsedEntryIds], showLists: this.showListEntries,
            expandedListIds: [...this.expandedListEntryIds],
            expandedTabIds: [...this.expandedTabIds],
        }).catch(error => {
            console.error("大纲增强 Dock：保存折叠状态失败", error);
            if (!this.disposed) this.options.reportError("大纲折叠状态保存失败，请重试。");
        });
    }

    applyFoldState(documentId: string, state: HeadingFoldState) {
        if (this.editor?.rootID !== documentId || this.disposed) return;
        const collapsed = new Set(state.collapsedIds);
        const expandedLists = new Set(state.expandedListIds || []);
        const expandedTabs = new Set(state.expandedTabIds || []);
        if (this.showListEntries === state.showLists && collapsed.size === this.collapsedEntryIds.size &&
            [...collapsed].every(id => this.collapsedEntryIds.has(id)) &&
            expandedLists.size === this.expandedListEntryIds.size &&
            [...expandedLists].every(id => this.expandedListEntryIds.has(id)) &&
            expandedTabs.size === this.expandedTabIds.size &&
            [...expandedTabs].every(id => this.expandedTabIds.has(id))) return;
        this.collapsedEntryIds = collapsed;
        this.expandedListEntryIds = expandedLists;
        this.expandedTabIds = expandedTabs;
        this.showListEntries = state.showLists;
        this.render();
    }

    private renderDocumentTitle() {
        this.documentTitle.hidden = !this.editor;
        const title = this.editor?.documentTitle?.trim() || "未命名文档";
        if (this.documentTitleText.textContent !== title) this.documentTitleText.textContent = title;
        this.documentTitle.title = `${title}\n点击返回文档顶部`;
        this.documentTitle.setAttribute("aria-label", `${title}，返回文档顶部`);
    }

    private render() {
        if (this.disposed) return;

        if (!this.editor) {
            this.status.textContent = "暂无活动文档";
            this.status.hidden = false;
            this.body.replaceChildren();
            return;
        }

        const query = this.searchQuery.toLowerCase();
        const { visible: visibleTree, listOwnerIds } = filterHeadingListEntries(this.entries,
            this.showListEntries, this.expandedListEntryIds, this.expandedTabIds);
        const visibleCollapsibleIds = getCollapsibleEntryIds(visibleTree);
        const collapsibleIds = new Set(visibleCollapsibleIds);
        const allCollapsibleIds = getCollapsibleEntryIds(this.entries);
        for (const id of listOwnerIds) if (allCollapsibleIds.has(id)) collapsibleIds.add(id);
        for (const entry of visibleTree) {
            if (entry.kind === "tab" && allCollapsibleIds.has(entry.id)) collapsibleIds.add(entry.id);
        }
        for (const id of this.collapsedEntryIds) {
            if (!allCollapsibleIds.has(id)) this.collapsedEntryIds.delete(id);
        }
        const effectiveCollapsedIds = getEffectiveCollapsedIds(visibleTree, this.collapsedEntryIds, this.expandedTabIds);
        const filteredEntries = query
            ? this.entries.filter(e => e.text.toLowerCase().includes(query))
            : filterCollapsedEntries(visibleTree, effectiveCollapsedIds);

        if (!this.entries.length) {
            this.status.textContent = this.status.textContent || "当前文档暂无标题";
            this.status.hidden = false;
            this.body.replaceChildren();
            return;
        }

        if (!filteredEntries.length) {
            this.status.textContent = query ? "无匹配结果" : "当前文档暂无标题";
            this.status.hidden = false;
            this.body.replaceChildren();
            return;
        }

        this.status.hidden = true;
        const fragment = document.createDocumentFragment();
        for (const entry of filteredEntries) {
            const container = document.createElement("div");
            container.className = "heading-outline-dock__entry";
            container.style.setProperty("--outline-indent", `${12 + (entry.depth - 1) * 16}px`);
            const item = document.createElement("button");
            item.type = "button";
            item.className = "b3-list-item heading-outline-dock__item";
            item.dataset.id = entry.id;
            if (entry.embedId) item.dataset.embedId = entry.embedId;
            const sourceKind = !entry.kind || entry.kind === "heading" ? "heading" :
                entry.kind === "list" && canDragListItem(this.editor.content, entry.id) ? "list" : null;
            const movable = !!sourceKind && !entry.embedId && !this.editor.preview && !this.editor.disabled &&
                !!this.editor.transaction && !this.options.isMobile?.();
            if (movable) item.dataset.draggableOutline = sourceKind;
            item.style.paddingLeft = "calc(var(--outline-indent) + 18px)";

            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.classList.add("b3-list-item__graphic", "heading-outline-dock__icon");
            icon.setAttribute("aria-hidden", "true");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            use.setAttribute("href", entry.kind === "tab" ? "#iconTabItem" :
                entry.kind === "paragraph" ? "#iconParagraph" :
                entry.kind === "list" ? "#iconListItem" : `#iconH${entry.level}`);
            icon.append(use);

            const text = createOutlineLabel(entry, this.searchQuery,
                "b3-list-item__text heading-outline-dock__text");

            item.append(icon, text);
            if (!entry.images?.length || entry.images.some(image => image.title)) {
                item.title = movable ? `${entry.text}\n拖动可调整${sourceKind === "list" ? "列表项" : "标题"}顺序和层级` : entry.text;
            }
            item.setAttribute("aria-label", `第 ${entry.depth} 层：${entry.text}`);
            if (!query && collapsibleIds.has(entry.id)) {
                const expanded = !effectiveCollapsedIds.has(entry.id) && visibleCollapsibleIds.has(entry.id);
                container.append(createOutlineFoldButton(entry, expanded,
                    "heading-outline-dock__fold"));
            }
            container.append(item);
            fragment.append(container);
        }
        const scrollTop = this.body.scrollTop;
        this.body.replaceChildren(fragment);
        this.options.renderMath?.(this.body);
        this.body.scrollTop = scrollTop;
        this.highlight();
    }

    private onClick = async (event: MouseEvent) => {
        if (this.suppressClick) {
            event.preventDefault();
            event.stopPropagation();
            this.suppressClick = false;
            return;
        }
        const toggle = (event.target as Element).closest<HTMLButtonElement>("button[data-outline-toggle]");
        if (toggle) {
            event.preventDefault();
            event.stopPropagation();
            const id = toggle.dataset.outlineToggle!;
            const entry = this.entries.find(item => item.id === id);
            if (entry?.kind === "tab") {
                if (this.expandedTabIds.has(id)) this.expandedTabIds.delete(id);
                else this.expandedTabIds.add(id);
                this.collapsedEntryIds.delete(id);
                this.saveFoldState();
                this.render();
                return;
            }
            const { visible, listOwnerIds } = filterHeadingListEntries(this.entries,
                this.showListEntries, this.expandedListEntryIds, this.expandedTabIds);
            if (this.collapsedEntryIds.has(id)) {
                this.collapsedEntryIds.delete(id);
                if (listOwnerIds.has(id)) this.expandedListEntryIds.add(id);
            } else if (!this.showListEntries && listOwnerIds.has(id) &&
                !getCollapsibleEntryIds(visible).has(id)) {
                this.expandedListEntryIds.add(id);
            } else this.collapsedEntryIds.add(id);
            this.saveFoldState();
            this.render();
            return;
        }
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        const editor = this.editor;
        if (!row || !editor) return;
        const id = row.dataset.id!;
        if (!id) { void this.refresh(); return; }
        if (row.dataset.embedId) {
            const target = findEmbeddedOutlineTarget(editor.content, id, row.dataset.embedId);
            if (target?.getClientRects().length) {
                target.scrollIntoView({ block: "center", behavior: "smooth" });
                target.animate?.([{ backgroundColor: "var(--b3-theme-primary-light)" },
                    { backgroundColor: "transparent" }], { duration: 1000 });
                return;
            }
        }
        if (editor.preview) {
            const heading = Array.from(editor.content.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === id);
            if (heading) { heading.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
        }
        try {
            const result = await this.options.request("/api/block/checkBlockFold", {
                id, ...(editor.notebook ? { notebook: editor.notebook } : {}),
            });
            if (!this.disposed && this.editor === editor) this.options.navigate(id, !!result?.isFolded);
        } catch (error) {
            console.error("大纲增强 Dock：定位失败", error);
            if (!this.disposed) this.options.reportError("大纲条目定位失败，请重试。");
        }
    };

    private createOutlineMovePlan(
        state: OutlineDragState,
        targetID: string,
        position: HeadingDropPosition,
        preview = false,
    ): { operations: OutlineMoveOperation[]; undoOperations: OutlineMoveOperation[] } | null {
        if (state.sourceKind === "heading") {
            const plan = createHeadingMovePlan(this.entries, state.sourceID, targetID, position);
            return plan ? { operations: [plan.operation], undoOperations: [plan.undoOperation] } : null;
        }
        return createListItemMovePlan(state.editor.content, state.sourceID, targetID, position,
            preview ? () => "drag-preview-list" : (this.options.newNodeID || (() => "")));
    }

    private onOutlineMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || this.searchQuery || this.body.dataset.loading === "true") return;
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-draggable-outline]");
        const editor = this.editor;
        if (!row?.dataset.id || !editor?.transaction || editor.disabled || editor.preview) return;
        const sourceKind = row.dataset.draggableOutline;
        if (sourceKind !== "heading" && sourceKind !== "list") return;
        if ((event.target as Element).closest("button[data-outline-toggle]")) return;
        this.cancelOutlineDrag();
        this.dragState = {
            editor,
            sourceKind,
            sourceID: row.dataset.id,
            sourceRow: row,
            startX: event.clientX,
            startY: event.clientY,
            dragging: false,
        };
        document.addEventListener("mousemove", this.onOutlineMouseMove);
        document.addEventListener("mouseup", this.onOutlineMouseUp, { once: true });
        window.addEventListener("blur", this.onOutlineDragBlur, { once: true });
    };

    private onOutlineMouseMove = (event: MouseEvent) => {
        const state = this.dragState;
        if (!state || this.editor !== state.editor || !state.sourceRow.isConnected) {
            this.cancelOutlineDrag();
            return;
        }
        if (!state.dragging && Math.abs(event.clientX - state.startX) < 3 &&
            Math.abs(event.clientY - state.startY) < 3) return;
        event.preventDefault();
        event.stopPropagation();
        if (!state.dragging) {
            state.dragging = true;
            state.sourceRow.style.opacity = "0.38";
            this.body.dataset.dragging = "true";
            const ghost = state.sourceRow.cloneNode(true) as HTMLElement;
            ghost.className = "b3-list-item heading-outline-dock__item heading-outline-dock__drag-ghost";
            ghost.removeAttribute("data-id");
            ghost.removeAttribute("data-draggable-outline");
            ghost.style.width = `${Math.max(160, state.sourceRow.getBoundingClientRect().width)}px`;
            document.body.append(ghost);
            state.ghost = ghost;
        }
        state.ghost!.style.left = `${event.clientX + 10}px`;
        state.ghost!.style.top = `${event.clientY + 10}px`;
        this.scrollDuringOutlineDrag(event.clientY);
        this.clearOutlineDropIndicator();

        const eventTarget = event.target instanceof Element ? event.target : null;
        const target = eventTarget?.closest<HTMLButtonElement>(
            `button[data-draggable-outline="${state.sourceKind}"]`
        );
        if (target === state.sourceRow) {
            state.sourceRow.classList.add("dragover__current");
            return;
        }
        if (!target || !this.body.contains(target) || !target.dataset.id) return;
        const rect = target.getBoundingClientRect();
        const edge = rect.height * 0.2;
        const position: HeadingDropPosition = event.clientY < rect.top + edge ? "before" :
            event.clientY > rect.bottom - edge ? "after" : "inside";
        if (!this.createOutlineMovePlan(state, target.dataset.id, position, true)) {
            target.classList.add("dragover__current");
            return;
        }
        target.classList.add(position === "before" ? "dragover__top" :
            position === "after" ? "dragover__bottom" : "dragover");
        state.targetID = target.dataset.id;
        state.position = position;
    };

    private onOutlineMouseUp = () => {
        const state = this.dragState;
        const plan = state?.dragging && state.targetID && state.position
            ? this.createOutlineMovePlan(state, state.targetID, state.position)
            : null;
        const canCommit = !!plan && state?.editor === this.editor && state.editor.transaction;
        if (state?.dragging) {
            this.suppressClick = true;
            setTimeout(() => { this.suppressClick = false; }, 0);
        }
        this.cancelOutlineDrag();
        if (!canCommit || !state || !plan) return;
        let transactionSubmitted = false;
        try {
            this.body.dataset.loading = "true";
            if (state.sourceKind === "list") applyListUpdateOperations(state.editor.content, plan.operations);
            state.editor.transaction!(plan.operations, plan.undoOperations);
            transactionSubmitted = true;
            // 与思源原生大纲一致，避免事务回写期间标题编辑区仍保持可编辑状态。
            state.editor.content.querySelectorAll<HTMLElement>(
                '[data-type="NodeHeading"] [contenteditable="true"][spellcheck]'
            ).forEach(heading => heading.setAttribute("contenteditable", "false"));
            this.scheduleRefresh();
        } catch (error) {
            if (state.sourceKind === "list" && !transactionSubmitted) {
                try { applyListUpdateOperations(state.editor.content, plan.undoOperations); }
                catch (rollbackError) { console.error("大纲增强 Dock：恢复列表 DOM 失败", rollbackError); }
            }
            this.body.removeAttribute("data-loading");
            console.error("大纲增强 Dock：移动大纲条目失败", error);
            this.options.reportError("大纲条目移动失败，请重试。");
        }
    };

    private onOutlineDragBlur = () => this.cancelOutlineDrag();

    private scrollDuringOutlineDrag(clientY: number) {
        const rect = this.body.getBoundingClientRect();
        const edge = Math.min(36, rect.height / 4);
        if (clientY < rect.top + edge) this.body.scrollTop -= 12;
        else if (clientY > rect.bottom - edge) this.body.scrollTop += 12;
    }

    private clearOutlineDropIndicator() {
        this.body.querySelectorAll(".dragover__top, .dragover__bottom, .dragover, .dragover__current").forEach(item => {
            item.classList.remove("dragover__top", "dragover__bottom", "dragover", "dragover__current");
        });
        if (this.dragState) {
            this.dragState.targetID = undefined;
            this.dragState.position = undefined;
        }
    }

    private cancelOutlineDrag() {
        document.removeEventListener("mousemove", this.onOutlineMouseMove);
        document.removeEventListener("mouseup", this.onOutlineMouseUp);
        window.removeEventListener("blur", this.onOutlineDragBlur);
        this.clearOutlineDropIndicator();
        if (this.dragState) {
            this.dragState.sourceRow.style.opacity = "";
            this.dragState.ghost?.remove();
        }
        this.body.removeAttribute("data-dragging");
        this.dragState = undefined;
    }

    private onContextMenu = (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!row?.dataset.id || !this.editor) return;
        const rootID = this.editor.rootID;
        const kind = this.entries.find(entry => entry.id === row.dataset.id && entry.embedId === row.dataset.embedId)?.kind || "heading";
        if (kind === "tab" || kind === "paragraph" || row.dataset.embedId) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        this.options.openInsertMenu?.(event, {
            id: row.dataset.id, kind, editor: this.editor.element, notebook: this.editor.notebook,
        }, () => {
            if (!this.disposed && this.editor?.rootID === rootID) void this.refresh();
        });
    };

    scheduleHighlight = () => {
        if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.highlight();
        });
    };

    private resolveCurrentID(ids: Set<string>): string {
        if (!this.editor || !ids.size) return "";
        const selector = getHeadingOutlineTargetSelector(this.editor.preview);
        const nodes = Array.from(this.editor.content.querySelectorAll<HTMLElement>(selector)).filter(node => {
            const id = this.editor!.preview ? node.id : node.dataset.nodeId!;
            return ids.has(id) && node.getClientRects().length > 0;
        });

        const target = this.editorTargetElement;
        if (target?.isConnected && this.editor.content.contains(target)) {
            const directID = findClosestHeadingOutlineTargetId(target, this.editor.content, ids,
                this.editor.preview);
            if (directID) return directID;

            // 普通段落、代码块等没有大纲项时，定位到文档顺序中它上方最近的大纲项。
            let preceding = "";
            for (const node of nodes) {
                const id = this.editor.preview ? node.id : node.dataset.nodeId!;
                if (node.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) preceding = id;
                else if (node.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_PRECEDING) break;
            }
            if (preceding) return preceding;
        }

        const viewport = this.editor.content.closest(".protyle-content") || this.editor.content;
        const top = viewport.getBoundingClientRect().top;
        let current = "";
        for (const node of nodes) {
            const id = this.editor.preview ? node.id : node.dataset.nodeId!;
            if (!current) current = id;
            if (node.getBoundingClientRect().top <= top + 48) current = id;
        }
        return current;
    }

    highlight(autoScroll = false, resolveCurrent = false) {
        if (!this.editor || this.disposed) return;
        const ids = new Set(this.entries.map(entry => entry.id));
        let current = ids.has(this.currentEntryId) ? this.currentEntryId : "";
        if (resolveCurrent || !current) {
            current = this.resolveCurrentID(ids);
            this.currentEntryId = current;
        }
        if (current && this.settings.keepCurrentHeadingExpanded &&
            expandCollapsedAncestors(this.entries, current, this.collapsedEntryIds,
                this.expandedListEntryIds, this.expandedTabIds)) {
            this.saveFoldState();
            this.render();
            return;
        }
        let currentRow: HTMLElement | null = null;
        this.body.querySelectorAll<HTMLElement>("button[data-id]").forEach(row => {
            const active = !!current && row.dataset.id === current;
            row.classList.toggle("b3-list-item--focus", active);
            row.classList.toggle("heading-outline-dock__current", active);
            if (active) {
                row.setAttribute("aria-current", "location");
                currentRow = row;
            }
            else row.removeAttribute("aria-current");
        });
        if (autoScroll && currentRow) currentRow.scrollIntoView?.({ block: "nearest" });
    }

    destroy() {
        this.disposed = true;
        this.version++;
        clearTimeout(this.timer);
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        this.cancelOutlineDrag();
        this.body.removeEventListener("mousedown", this.onOutlineMouseDown);
        document.removeEventListener("click", this.onEditorClick);
        this.rootElement.remove();
        this.editor = null;
    }
}
