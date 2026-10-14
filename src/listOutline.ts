import { MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import { blockDepth, DEPTH_ATTRIBUTE, extractOutline, filterCompletedTasks, findList, findRootLists, hasChildBlocks,
    OUTLINE_CONTAINER_SELECTOR, OUTLINE_ITEM_SELECTOR, TABS_SELECTOR } from "./outline";
import { createOutlineRow, setOutlineCurrent } from "./outlineView";
import type { OpenInsertMenu } from "./outlineInsert";

interface Options {
    getSettings(editor?: HTMLElement): OutlineSettings;
    loadDocumentSettings?(editor: HTMLElement): Promise<void>;
    request(url: string, data: Record<string, unknown>): Promise<any>;
    navigate(id: string): void;
    reportError(message: string): void;
    openInsertMenu?: OpenInsertMenu;
    renderMath?(element: HTMLElement): void;
}

export class ListOutlineView {
    public readonly panel = document.createElement("aside");
    private select = document.createElement("select");
    private searchInput = document.createElement("input");
    private searchQuery = "";
    private body = document.createElement("div");
    private status = document.createElement("div");
    private source: HTMLElement;
    private override: number | null = null;
    private generation = 0;
    private requestVersion = 0;
    private frame = 0;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private observer: MutationObserver;
    private resizeObserver: ResizeObserver;
    private saving = new Set<string>();
    private disposed = false;
    private expanded = false;
    private currentItemID = "";
    private menuOpen = false;
    private hasChildren = false;

    constructor(
        public active: HTMLElement,
        public editor: HTMLElement,
        private options: Options,
        private onExpand?: (view: ListOutlineView) => void,
    ) {
        this.source = active;
        this.override = blockDepth(active.getAttribute(DEPTH_ATTRIBUTE));
        const containerName = active.matches(TABS_SELECTOR) ? "页签" : "列表";
        this.panel.className = "list-outline-floating";
        this.panel.setAttribute("aria-label", `${containerName}大纲`);
        this.panel.dataset.listId = active.dataset.nodeId || "";
        this.panel.hidden = true;

        const header = document.createElement("div");
        header.className = "list-outline-floating__header";
        const title = document.createElement("span");
        title.textContent = `${containerName}大纲`;
        const label = document.createElement("label");
        label.textContent = "层级";
        this.select.className = "b3-select";
        this.select.setAttribute("aria-label", `当前${containerName}块的大纲层级`);
        this.select.title = `单独设置当前${containerName}块，自动保存到块属性`;
        this.select.add(new Option("默认", ""));
        for (let depth = 1; depth <= MAX_DEPTH; depth++) this.select.add(new Option(`${depth} 层`, String(depth)));
        label.append(this.select);
        header.append(title, label);

        const searchContainer = document.createElement("div");
        searchContainer.className = "list-outline-floating__search";
        const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        searchIcon.classList.add("list-outline-floating__search-icon");
        searchIcon.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#iconSearch");
        searchIcon.append(use);

        this.searchInput.className = "b3-text-field b3-text-field--text list-outline-floating__search-input";
        this.searchInput.type = "search";
        this.searchInput.placeholder = `搜索${containerName}项…`;
        this.searchInput.setAttribute("aria-label", `搜索${containerName}项`);
        searchContainer.append(searchIcon, this.searchInput);

        this.body.className = "list-outline-floating__body";
        this.status.className = "list-outline-floating__status";
        this.status.setAttribute("role", "status");
        this.panel.append(header, searchContainer, this.body, this.status);
        document.body.append(this.panel);

        this.select.addEventListener("change", this.saveDepth);
        this.searchInput.addEventListener("input", () => {
            this.searchQuery = this.searchInput.value.trim();
            this.render();
        });
        this.searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                if (this.searchInput.value) {
                    event.stopPropagation();
                    this.searchInput.value = "";
                    this.searchQuery = "";
                    this.render();
                }
            }
        });
        this.body.addEventListener("click", this.onEntryClick);
        this.body.addEventListener("contextmenu", this.onContextMenu);
        this.panel.addEventListener("focusin", this.onFocusIn);
        this.panel.addEventListener("focusout", this.onFocusOut);
        this.panel.addEventListener("pointerover", this.onPointerOver);
        this.panel.addEventListener("pointerout", this.onPointerOut);

        this.observer = new MutationObserver(this.onMutation);
        this.observer.observe(this.active, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: [DEPTH_ATTRIBUTE, "fold", "data-type", "data-subtype", "data-task", "data-marker", "data-content", "style", "src", "data-src", "alt", "title",
                "tabs-title", "tabs-active-id", "data-tabs-hidden"],
        });
        this.resizeObserver = new ResizeObserver(this.schedulePosition);
        this.resizeObserver.observe(this.active);
        this.resizeObserver.observe(this.editor);

        this.render();
        this.position();
        void this.loadSnapshot();
    }

    get isExpanded(): boolean {
        return this.expanded;
    }

    get isMenuOpen(): boolean {
        return this.menuOpen;
    }

    private updateContainerLabels() {
        const containerName = this.active.matches(TABS_SELECTOR) ? "页签" : "列表";
        this.panel.setAttribute("aria-label", `${containerName}大纲`);
        const title = this.panel.querySelector<HTMLElement>(".list-outline-floating__header > span");
        if (title) title.textContent = `${containerName}大纲`;
        this.select.setAttribute("aria-label", `当前${containerName}块的大纲层级`);
        this.select.title = `单独设置当前${containerName}块，自动保存到块属性`;
        this.searchInput.placeholder = `搜索${containerName}项…`;
        this.searchInput.setAttribute("aria-label", `搜索${containerName}项`);
    }

    private onPointerOver = (event: PointerEvent) => {
        if (!(event.target instanceof Element)) return;
        if (this.panel.contains(event.target)) {
            this.setExpanded(true);
        }
    };

    private onPointerOut = (event: PointerEvent) => {
        if (this.menuOpen) return;
        const next = event.relatedTarget;
        if (event.target instanceof Node && this.panel.contains(event.target) &&
            !(next instanceof Node && this.panel.contains(next))) {
            if (document.activeElement && this.panel.contains(document.activeElement)) return;
            this.setExpanded(false);
        }
    };

    private onFocusIn = () => this.setExpanded(true);

    private onFocusOut = (event: FocusEvent) => {
        if (this.menuOpen) return;
        if (!(event.relatedTarget instanceof Node && this.panel.contains(event.relatedTarget)) &&
            !this.panel.matches(":hover")) this.setExpanded(false);
    };

    setExpanded(expanded: boolean) {
        if (!this.active || expanded === this.expanded) return;
        this.expanded = expanded;
        this.panel.classList.toggle("list-outline-floating--expanded", expanded);
        if (expanded) {
            this.onExpand?.(this);
        } else {
            this.body.scrollTop = 0;
            if (this.searchQuery || this.searchInput.value) {
                this.searchQuery = "";
                this.searchInput.value = "";
                this.render();
            }
        }
        // 展开时向左延伸，右边缘保持不动，避免面板移出鼠标范围。
        this.position();
    }

    setCurrentFromNode(node: Node | null) {
        const mutations = this.observer.takeRecords();
        if (mutations.length) this.onMutation(mutations);

        const element = node instanceof Element ? node : node?.parentElement;
        if (!element || !this.active.contains(element)) return;
        // 引述内容不生成大纲项，也不成为当前位置。
        if (element.closest('[data-type="NodeBlockquote"], blockquote')) return;
        const tabID = element.closest<HTMLElement>('.tabs-tab[data-tab-id]')?.dataset.tabId;
        const item = element.closest<HTMLElement>(OUTLINE_ITEM_SELECTOR);
        if (tabID) {
            this.currentItemID = tabID;
            this.schedulePosition();
            return;
        }
        if (!item || !this.active.contains(item)) return;
        this.currentItemID = item.dataset.nodeId || "";
        this.schedulePosition();
    }

    clearCurrentItem() {
        this.currentItemID = "";
        this.schedulePosition();
    }

    refreshSettings() {
        if (!this.disposed && this.active) this.render();
    }

    schedulePosition = () => {
        if (!this.frame && !this.disposed && this.active) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.position();
        });
    };

    position(): boolean {
        if (this.disposed || !this.active?.isConnected || !this.active.getClientRects().length) {
            this.panel.hidden = true;
            return false;
        }
        const rect = this.active.getBoundingClientRect();
        const viewport = this.editor.closest(".protyle-content")?.getBoundingClientRect();
        const top = Math.max(8, viewport?.top ?? 0);
        const bottom = Math.min(window.innerHeight - 8, viewport?.bottom ?? window.innerHeight);
        const left = Math.max(8, viewport?.left ?? 0);
        const right = Math.min(window.innerWidth - 8, viewport?.right ?? window.innerWidth);
        if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) {
            this.panel.hidden = true;
            return false;
        }
        const settings = this.options.getSettings(this.editor);
        if (settings.listOutlineRequireChildren && !this.hasChildren && !this.expanded) {
            this.panel.hidden = true;
            return false;
        }
        const width = Math.max(0, Math.min(this.expanded ? 300 : 48, right - left));
        const y = this.expanded
            ? Math.max(top, Math.min(rect.top + 6, bottom - 100))
            : Math.max(top, rect.top + 6);
        const visibleBottom = this.expanded
            ? bottom
            : Math.min(bottom, rect.bottom);
        const availableHeight = visibleBottom - y;
        if (availableHeight < 12 && !this.expanded) {
            this.panel.hidden = true;
            return false;
        }
        const maxHeight = Math.max(0, Math.min(420, availableHeight));
        this.panel.style.width = `${width}px`;
        // 尽量放在列表正文右侧留白处，展开也优先向右；空间不足时贴编辑区右边缘。
        const panelLeft = Math.max(left, Math.min(rect.right + 8, right - width));
        this.panel.style.left = `${panelLeft}px`;
        this.panel.style.top = `${y}px`;
        this.panel.style.maxHeight = `${maxHeight}px`;
        this.panel.hidden = false;
        this.highlight(top, bottom);
        return true;
    }

    private highlight(top: number, bottom: number) {
        if (!this.active) return;
        const rows = this.body.querySelectorAll<HTMLElement>("button[data-id]");
        const ids = new Set(Array.from(rows, row => row.dataset.id!));
        const items = Array.from(this.active.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR));
        const visible = (item: HTMLElement) => item.getClientRects().length > 0 &&
            !item.closest('[data-type="NodeBlockquote"], blockquote') &&
            !item.closest('[data-type="NodeTabItem"][data-tabs-hidden="true"]') &&
            !item.parentElement?.closest('[fold="1"]');
        let item = items.find(item => item.dataset.nodeId === this.currentItemID && visible(item) &&
            item.getBoundingClientRect().bottom > top && item.getBoundingClientRect().top < bottom);
        if (!item) {
            for (const candidate of items) {
                if (!visible(candidate)) continue;
                const rect = candidate.getBoundingClientRect();
                if (rect.bottom <= top || rect.top >= bottom) continue;
                if (!item) item = candidate;
                if (rect.top <= top + 36) item = candidate;
            }
        }
        // 未显示的深层子项回退到大纲中可见的最近父列表项。
        while (item && !ids.has(item.dataset.nodeId!)) {
            item = item.parentElement?.closest<HTMLElement>(OUTLINE_ITEM_SELECTOR);
            if (item && !this.active.contains(item)) item = null;
        }
        setOutlineCurrent(this.body, item?.dataset.nodeId || "");
    }

    private render() {
        if (!this.active || !this.source) return;
        this.updateContainerLabels();
        const settings = this.options.getSettings(this.editor);
        this.select.options[0].textContent = `默认（${settings.defaultDepth} 层）`;
        this.select.value = this.override === null ? "" : String(this.override);
        this.select.disabled = this.saving.has(this.active.dataset.nodeId!);
        const allEntries = filterCompletedTasks(extractOutline(this.source, this.override ?? settings.defaultDepth), settings.hideCompletedTasks);
        this.hasChildren = hasChildBlocks(this.source) || allEntries.some(entry => entry.depth > 1);
        if (settings.listOutlineRequireChildren && !this.hasChildren && !this.expanded) {
            this.panel.hidden = true;
            return;
        }
        const query = this.searchQuery.toLowerCase();
        const entries = query
            ? allEntries.filter(entry => entry.text.toLowerCase().includes(query))
            : allEntries;
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const row = createOutlineRow(entry, this.searchQuery);
            fragment.append(row);
        }
        if (!allEntries.length) {
            const empty = document.createElement("div");
            empty.className = "list-outline-floating__empty";
            empty.textContent = this.active.matches(TABS_SELECTOR) ? "暂无页签项" : "暂无列表项";
            fragment.append(empty);
        } else if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "list-outline-floating__empty";
            empty.textContent = "无匹配结果";
            fragment.append(empty);
        }
        const scrollTop = this.body.scrollTop;
        this.body.replaceChildren(fragment);
        this.options.renderMath?.(this.body);
        this.body.scrollTop = scrollTop;
        this.position();
    }

    private onMutation = (mutations: MutationRecord[]) => {
        if (this.disposed || !this.active) return;
        if (!this.active.isConnected) {
            clearTimeout(this.refreshTimer);
            this.requestVersion++;
            this.panel.hidden = true;
            return;
        }
        if (!mutations.some(mutation => this.active.contains(mutation.target))) return;
        this.requestVersion++;
        this.override = blockDepth(this.active.getAttribute(DEPTH_ATTRIBUTE));
        this.source = this.active;
        this.render();
        clearTimeout(this.refreshTimer);
        // 等待编辑事务落盘，再补齐折叠、未渲染的子列表。
        this.refreshTimer = setTimeout(() => void this.loadSnapshot(), 20);
    };

    private async loadSnapshot() {
        const active = this.active;
        // 剪切整个列表时，编辑器 DOM 会先移除列表，控制器随后才销毁视图。
        // 不要在这段间隙继续使用已经失效的块 ID 请求内核。
        if (!active?.isConnected || !this.editor?.isConnected || this.disposed) return;
        const generation = this.generation;
        const version = ++this.requestVersion;
        const id = active.dataset.nodeId!;
        const [dom, attrs, documentSettings] = await Promise.allSettled([
            this.options.request("/api/block/getBlockDOM", { id }),
            this.options.request("/api/attr/getBlockAttrs", { id }),
            this.options.loadDocumentSettings?.(this.editor),
        ]);
        if (this.disposed || generation !== this.generation || version !== this.requestVersion) return;
        if (dom.status === "fulfilled" && dom.value?.dom) {
            const parsed = new DOMParser().parseFromString(dom.value.dom, "text/html");
            const root = Array.from(parsed.querySelectorAll<HTMLElement>(OUTLINE_CONTAINER_SELECTOR)).find(node => node.dataset.nodeId === id);
            if (root) this.source = root;
        }
        if (attrs.status === "fulfilled" && !this.saving.has(id)) {
            const attrDepth = attrs.value?.[DEPTH_ATTRIBUTE];
            this.override = attrDepth !== undefined
                ? blockDepth(attrDepth)
                : blockDepth(this.active.getAttribute(DEPTH_ATTRIBUTE));
        }
        this.status.textContent = dom.status === "rejected" ? "读取完整列表失败，暂显示已加载内容" : "";
        if (attrs.status === "rejected") this.status.textContent = "读取块设置失败，暂使用当前显示值";
        if (documentSettings.status === "rejected") this.status.textContent = "读取文档大纲设置失败，暂使用全局默认值";
        this.render();
    }

    private saveDepth = async () => {
        if (!this.active) return;
        const active = this.active;
        const id = active.dataset.nodeId!;
        if (this.saving.has(id)) return;
        const value = this.select.value;
        const generation = this.generation;
        this.requestVersion++;
        this.saving.add(id);
        this.select.disabled = true;
        this.status.textContent = "正在保存…";
        try {
            await this.options.request("/api/attr/setBlockAttrs", { id, attrs: { [DEPTH_ATTRIBUTE]: value } });
            if (this.disposed) return;
            // 同一列表可能同时在多个编辑器中打开，只同步这一个自定义属性。
            document.querySelectorAll<HTMLElement>(OUTLINE_CONTAINER_SELECTOR).forEach(node => {
                if (node.dataset.nodeId !== id) return;
                if (value) node.setAttribute(DEPTH_ATTRIBUTE, value);
                else node.removeAttribute(DEPTH_ATTRIBUTE);
            });
            if (generation === this.generation) {
                this.override = blockDepth(value);
                this.status.textContent = value ? `已保存：${value} 层` : "已恢复跟随默认";
            }
        } catch (error) {
            console.error("列表大纲：保存块属性失败", error);
            if (!this.disposed) this.options.reportError("列表大纲层级保存失败，请重试。");
            if (generation === this.generation) this.status.textContent = "保存失败，设置未更改";
        } finally {
            this.saving.delete(id);
            if (!this.disposed && this.active?.dataset.nodeId === id) this.render();
        }
    };

    private onEntryClick = (event: MouseEvent) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!button || !this.active) return;
        const id = button.dataset.id!;
        this.currentItemID = id;
        setOutlineCurrent(this.body, id);
        const target = Array.from(this.active.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR))
            .find(node => node.dataset.nodeId === id);
        if (target?.matches('[data-type="NodeTabItem"]')) {
            const nativeTab = Array.from(this.active.querySelectorAll<HTMLElement>('.tabs-tab[data-tab-id]'))
                .find(button => button.dataset.tabId === id);
            if (nativeTab?.getClientRects().length) {
                nativeTab.click();
                nativeTab.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
                nativeTab.animate?.([{ backgroundColor: "var(--b3-theme-primary-light)" },
                    { backgroundColor: "transparent" }], { duration: 1000 });
                return;
            }
        }
        const foldedParent = target?.parentElement?.closest('[fold="1"]');
        if (target && target.getClientRects().length && !foldedParent) {
            target.scrollIntoView({ block: "center", behavior: "smooth" });
            target.animate([{ backgroundColor: "var(--b3-theme-primary-light)" }, { backgroundColor: "transparent" }], { duration: 1000 });
        } else this.options.navigate(id);
    };

    private onContextMenu = (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!row?.dataset.id || !this.active || !this.editor) return;
        const target = Array.from(this.active.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR))
            .find(node => node.dataset.nodeId === row.dataset.id);
        // 页签项暂不复用“插入同级列表项”菜单，避免生成错误的 NodeListItem。
        if (target?.matches('[data-type="NodeTabItem"]') || this.active.closest(".protyle-wysiwyg__embed")) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const rootID = this.active.dataset.nodeId;
        this.menuOpen = true;
        this.setExpanded(true);
        this.options.openInsertMenu?.(event, { id: row.dataset.id, kind: "list", editor: this.editor,
            notebook: this.editor.closest<HTMLElement>("[data-notebook-id]")?.dataset.notebookId }, () => {
            if (!this.disposed && this.active?.dataset.nodeId === rootID) void this.loadSnapshot();
        }, () => {
            this.menuOpen = false;
            if (this.disposed) return;
            if (this.panel.matches(":hover") || (document.activeElement && this.panel.contains(document.activeElement))) {
                this.setExpanded(true);
            } else {
                this.setExpanded(false);
            }
        });
    };

    destroy() {
        this.disposed = true;
        this.menuOpen = false;
        clearTimeout(this.refreshTimer);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.generation++;
        this.observer.disconnect();
        this.resizeObserver.disconnect();
        this.panel.remove();
    }
}

export class ListOutlineController {
    private views = new Map<HTMLElement, ListOutlineView>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private frame = 0;
    private editorObserver: MutationObserver;
    private disposed = false;

    constructor(private options: Options) {
        this.editorObserver = new MutationObserver(this.onEditorMutation);
        document.addEventListener("pointerover", this.onPointerOver);
        document.addEventListener("pointerdown", this.onPointerDown);
        document.addEventListener("keydown", this.onKeyDown);
        document.addEventListener("selectionchange", this.onSelectionChange);
        window.addEventListener("scroll", this.onScroll, true);
        window.addEventListener("resize", this.scheduleSync);
        this.heartbeat = setInterval(this.sync, 500);
        this.sync();
    }

    private onEditorMutation = () => {
        // 及时取消已被剪切/删除列表的延迟快照，不能等到下一帧 sync。
        for (const [list, view] of this.views.entries()) {
            if (!list.isConnected) {
                view.destroy();
                this.views.delete(list);
            }
        }
        this.scheduleSync();
    };

    private onPointerOver = (event: PointerEvent) => {
        if (!(event.target instanceof Element)) return;
        const list = findList(event.target);
        if (list) {
            const view = this.views.get(list);
            if (view) view.setCurrentFromNode(event.target);
        }
    };

    private onPointerDown = (event: PointerEvent) => {
        if (!(event.target instanceof Node)) return;
        for (const view of this.views.values()) {
            if (view.isMenuOpen) continue;
            if (view.isExpanded && !view.panel.contains(event.target)) {
                view.setExpanded(false);
            }
        }
    };

    private onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            for (const view of this.views.values()) {
                if (view.isMenuOpen) continue;
                if (view.isExpanded) view.setExpanded(false);
            }
        }
    };

    private onSelectionChange = () => {
        const node = document.getSelection()?.focusNode;
        if (!node) return;
        const element = node instanceof Element ? node : node.parentElement;
        if (!element) return;
        const list = findList(element);
        if (list) {
            const view = this.views.get(list);
            if (view) view.setCurrentFromNode(node);
        }
    };

    private onScroll = (event: Event) => {
        if (event.target instanceof Node) {
            for (const view of this.views.values()) {
                if (view.panel.contains(event.target)) return;
            }
        }
        for (const view of this.views.values()) {
            view.clearCurrentItem();
        }
        this.scheduleSync();
    };

    scheduleSync = () => {
        if (!this.frame && !this.disposed) {
            this.frame = requestAnimationFrame(() => {
                this.frame = 0;
                this.sync();
            });
        }
    };

    sync = () => {
        if (this.disposed) return;
        const editors = Array.from(document.querySelectorAll<HTMLElement>(".protyle-wysiwyg"))
            .filter(editor => editor.isConnected && !editor.closest('.fn__none, [hidden]'));

        const activeLists = new Set<HTMLElement>();
        for (const editor of editors) {
            this.editorObserver.observe(editor, { childList: true, subtree: true });
            const rootLists = findRootLists(editor);
            for (const list of rootLists) {
                activeLists.add(list);
                let view = this.views.get(list);
                if (!view) {
                    view = new ListOutlineView(list, editor, this.options, activeView => {
                        for (const v of this.views.values()) {
                            if (v !== activeView && v.isExpanded) v.setExpanded(false);
                        }
                    });
                    this.views.set(list, view);
                } else {
                    view.editor = editor;
                    view.position();
                }
            }
        }

        for (const [list, view] of this.views.entries()) {
            if (!activeLists.has(list) || !list.isConnected) {
                view.destroy();
                this.views.delete(list);
            }
        }
    };

    refreshSettings() {
        for (const view of this.views.values()) {
            view.refreshSettings();
        }
    }

    destroy() {
        this.disposed = true;
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.editorObserver.disconnect();
        for (const view of this.views.values()) {
            view.destroy();
        }
        this.views.clear();
        document.removeEventListener("pointerover", this.onPointerOver);
        document.removeEventListener("pointerdown", this.onPointerDown);
        document.removeEventListener("keydown", this.onKeyDown);
        document.removeEventListener("selectionchange", this.onSelectionChange);
        window.removeEventListener("scroll", this.onScroll, true);
        window.removeEventListener("resize", this.scheduleSync);
    }
}
