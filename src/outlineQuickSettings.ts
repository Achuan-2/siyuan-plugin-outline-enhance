import { MAX_DEPTH, type OutlineSettings } from "./defaultSettings";

interface Options {
    getSettings(): OutlineSettings;
    setListDepth?(depth: number): Promise<unknown>;
    setHideCompletedTasks?(enabled: boolean): Promise<unknown>;
    reportError(message: string): void;
    onOpenChange?(open: boolean): void;
    hasDocumentOverrides?(): boolean;
    resetDocumentSettings?(): Promise<unknown>;
}

/** Dock 与悬浮大纲共享的快捷设置；面板挂到 body，避免被大纲容器裁切。 */
export class OutlineQuickSettings {
    readonly button = document.createElement("button");
    readonly depthSelect = document.createElement("select");
    private panel = document.createElement("div");
    private hideCompleted = document.createElement("input");
    private scope = document.createElement("div");
    private reset = document.createElement("button");
    private disposed = false;

    constructor(private options: Options) {
        this.button.type = "button";
        this.button.className = "outline-quick-settings__button";
        this.button.dataset.action = "outline-settings";
        this.button.title = "大纲设置";
        this.button.setAttribute("aria-label", "大纲设置");
        this.button.setAttribute("aria-haspopup", "dialog");
        this.button.setAttribute("aria-expanded", "false");
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("aria-hidden", "true");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", "#iconSettings");
        icon.append(use);
        this.button.append(icon);
        this.button.addEventListener("click", event => {
            event.stopPropagation();
            if (this.isOpen) this.close();
            else this.open();
        });

        this.panel.className = "outline-quick-settings";
        this.panel.setAttribute("role", "dialog");
        this.panel.setAttribute("aria-label", "大纲快捷设置");
        this.scope.className = "outline-quick-settings__scope";
        this.panel.append(this.scope);
        const depthLabel = document.createElement("label");
        depthLabel.className = "outline-quick-settings__row";
        const depthText = document.createElement("span");
        depthText.textContent = "列表显示层级";
        this.depthSelect.className = "b3-select";
        this.depthSelect.setAttribute("aria-label", "大纲增强列表层级");
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            const option = document.createElement("option");
            option.value = String(depth);
            option.textContent = depth === 0 ? "不显示列表" : `${depth} 层`;
            this.depthSelect.add(option);
        }
        depthLabel.append(depthText, this.depthSelect);
        if (options.setListDepth) this.panel.append(depthLabel);

        const filterLabel = document.createElement("label");
        filterLabel.className = "outline-quick-settings__row";
        const filterText = document.createElement("span");
        filterText.textContent = "过滤已完成任务";
        this.hideCompleted.type = "checkbox";
        this.hideCompleted.className = "b3-switch";
        this.hideCompleted.setAttribute("aria-label", "过滤已完成任务");
        filterLabel.append(filterText, this.hideCompleted);
        if (options.setHideCompletedTasks) this.panel.append(filterLabel);
        this.reset.type = "button";
        this.reset.className = "b3-button b3-button--outline outline-quick-settings__reset";
        this.reset.textContent = "恢复全局设置";
        this.reset.addEventListener("click", () => void this.save(
            () => options.resetDocumentSettings?.(), "恢复全局设置失败，请重试。"));
        if (options.resetDocumentSettings) this.panel.append(this.reset);
        this.depthSelect.addEventListener("change", () => void this.save(
            () => options.setListDepth?.(Number(this.depthSelect.value)), "列表层级设置保存失败，请重试。"));
        this.hideCompleted.addEventListener("change", () => void this.save(
            () => options.setHideCompletedTasks?.(this.hideCompleted.checked), "任务过滤设置保存失败，请重试。"));
        this.sync();
    }

    get isOpen() { return this.panel.isConnected; }

    contains(target: Node) { return this.panel.contains(target) || this.button.contains(target); }

    sync() {
        const settings = this.options.getSettings();
        this.depthSelect.value = String(settings.headingListDepth);
        this.hideCompleted.checked = settings.hideCompletedTasks;
        this.scope.textContent = this.options.hasDocumentOverrides?.() ? "当前文档 · 已单独设置" : "当前文档 · 继承全局设置";
        this.reset.disabled = this.depthSelect.disabled || !this.options.hasDocumentOverrides?.();
        this.button.classList.toggle("outline-quick-settings__button--filtered", settings.hideCompletedTasks);
        this.button.title = `大纲设置（${settings.headingListDepth === 0 ? "不显示列表" : `列表 ${settings.headingListDepth} 层`}${settings.hideCompletedTasks ? "，过滤已完成任务" : ""}）`;
    }

    private async save(update: () => Promise<unknown> | undefined, errorMessage: string) {
        // 保存期间禁用两个控件，避免连续变更用旧设置覆盖尚未保存的字段。
        this.depthSelect.disabled = this.hideCompleted.disabled = this.reset.disabled = true;
        try {
            await update();
        } catch {
            if (!this.disposed) this.options.reportError(errorMessage);
        } finally {
            if (!this.disposed) {
                this.depthSelect.disabled = this.hideCompleted.disabled = false;
                this.sync();
            }
        }
    }

    private open() {
        if (this.disposed) return;
        this.sync();
        document.body.append(this.panel);
        this.button.setAttribute("aria-expanded", "true");
        this.options.onOpenChange?.(true);
        this.position();
        document.addEventListener("click", this.onOutsideClick);
        document.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("resize", this.position);
        window.addEventListener("scroll", this.position, true);
        (this.options.setListDepth ? this.depthSelect : this.hideCompleted).focus();
    }

    close() {
        if (!this.isOpen) return;
        this.panel.remove();
        this.button.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", this.onOutsideClick);
        document.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("resize", this.position);
        window.removeEventListener("scroll", this.position, true);
        this.options.onOpenChange?.(false);
    }

    private position = () => {
        const margin = 8;
        const target = this.button.getBoundingClientRect();
        const panel = this.panel.getBoundingClientRect();
        const left = Math.max(margin, Math.min(target.right - panel.width, window.innerWidth - panel.width - margin));
        const below = target.bottom + 6;
        const top = below + panel.height <= window.innerHeight - margin ? below : target.top - panel.height - 6;
        this.panel.style.left = `${left}px`;
        this.panel.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - panel.height - margin))}px`;
    };

    private onOutsideClick = (event: MouseEvent) => {
        if (event.target instanceof Node && !this.contains(event.target)) this.close();
    };

    private onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.button.focus();
        this.close();
    };

    destroy() {
        this.disposed = true;
        this.close();
    }
}
