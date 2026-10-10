import type { IProtyle } from "siyuan";

const HEADING_SELECTOR = '[data-type="NodeHeading"][data-node-id]';
const ROW_CLASS = "heading-gutter-persistent";
const SCROLLER_CLASS = "heading-gutter-scroller";

interface EditorView {
    protyle: IProtyle;
    content: HTMLElement;
    scroller: HTMLElement;
    rows: Map<HTMLElement, HTMLElement>;
    observer: MutationObserver;
    gutterObserver: MutationObserver;
    resizeObserver?: ResizeObserver;
}

/** 对齐原生 gutter 的容器留白和列表锚点，兼容容器中的标题。 */
function getHeadingAnchor(heading: HTMLElement, content: HTMLElement) {
    let node: HTMLElement | null = heading;
    let hideParent = false;
    let space = 0;
    let list: HTMLElement | null = null;
    while (node && content.contains(node)) {
        const parent: HTMLElement | null = node.parentElement?.closest('[data-node-id]') || null;
        const type = hideParent ? undefined : node.dataset.type;
        if (type === "NodeListItem" || type === "NodeList") list = node;
        if (node !== heading && (type === "NodeBlockquote" || type === "NodeCallout")) space += 10;
        let previous = node.previousElementSibling;
        while (previous && !previous.hasAttribute("data-node-id")) previous = previous.previousElementSibling;
        if (previous || node.parentElement?.classList.contains("callout-content") ||
            (type === "NodeTabItem" && node.parentElement?.classList.contains("tabs"))) {
            hideParent = true;
            if (parent?.dataset.type === "NodeBlockquote" || parent?.dataset.type === "NodeCallout") space += 10;
        }
        node = parent;
    }
    const rtl = window.siyuan?.config?.editor?.rtl || getComputedStyle(heading).direction === "rtl";
    return list?.firstElementChild && !rtl
        ? { rect: list.firstElementChild.getBoundingClientRect(), space: 0 }
        : { rect: heading.getBoundingClientRect(), space };
}

/** 控件位于正文外的滚动容器内，同步滚动且不进入正文序列化、复制和撤销数据。 */
export class HeadingGutterController {
    private views = new Map<HTMLElement, EditorView>();
    private frame = 0;
    private disposed = false;
    private heartbeat: ReturnType<typeof setInterval>;

    constructor(private options: { getEditors(): IProtyle[] }) {
        document.addEventListener("scroll", this.scheduleLayout, true);
        window.addEventListener("resize", this.scheduleLayout);
        this.heartbeat = setInterval(() => this.syncEditors(), 700);
        this.syncEditors();
    }

    syncEditors() {
        if (this.disposed) return;
        const active = new Set<HTMLElement>();
        for (const protyle of this.options.getEditors()) {
            const content = protyle.wysiwyg?.element;
            const scroller = protyle.contentElement || content?.parentElement;
            if (!content || !protyle.element.isConnected || !protyle.gutter ||
                !scroller || scroller === content || !scroller.contains(content) ||
                protyle.options.render?.gutter === false ||
                (protyle.preview?.element && !protyle.preview.element.classList.contains("fn__none"))) continue;
            active.add(protyle.element);
            let view = this.views.get(protyle.element);
            if (view && (view.content !== content || view.scroller !== scroller || view.protyle.gutter !== protyle.gutter)) {
                this.removeView(view);
                view = undefined;
            }
            if (!view) {
                view = {
                    protyle, content, scroller, rows: new Map(),
                    observer: new MutationObserver(() => this.refreshRows(view!)),
                    gutterObserver: new MutationObserver(this.scheduleLayout),
                };
                this.views.set(protyle.element, view);
                scroller.classList.add(SCROLLER_CLASS);
                view.observer.observe(content, { subtree: true, childList: true, characterData: true,
                    attributes: true, attributeFilter: ["fold", "data-subtype", "data-type", "data-node-id", "class", "style"] });
                view.gutterObserver.observe(protyle.gutter.element, { subtree: true, childList: true,
                    attributes: true, attributeFilter: ["class", "style", "data-node-id"] });
                if (typeof ResizeObserver !== "undefined") {
                    view.resizeObserver = new ResizeObserver(this.scheduleLayout);
                    view.resizeObserver.observe(protyle.element);
                    view.resizeObserver.observe(content);
                    view.resizeObserver.observe(scroller);
                }
                this.refreshRows(view);
            } else view.protyle = protyle;
        }
        for (const [element, view] of this.views) {
            if (!active.has(element)) this.removeView(view);
        }
        this.scheduleLayout();
    }

    private refreshRows(view: EditorView) {
        const headings = new Set(view.content.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
        for (const [heading, row] of view.rows) {
            if (!headings.has(heading)) {
                row.remove();
                view.rows.delete(heading);
            }
        }
        for (const heading of headings) {
            const subtype = heading.dataset.subtype || "";
            if (!/^h[1-6]$/.test(subtype)) continue;
            let row = view.rows.get(heading);
            if (!row) {
                row = document.createElement("div");
                // 不使用 protyle-gutters 类：原生 render 会清空其他带该类的元素。
                row.className = ROW_CLASS;
                row.hidden = true;
                const block = this.createButton("标题块菜单", "iconH1");
                const fold = this.createButton("折叠标题", "iconPlay");
                fold.className = "heading-gutter-persistent__fold";
                row.append(block, fold);
                row.addEventListener("mousedown", event => {
                    if (event.button === 0) event.preventDefault();
                    event.stopPropagation();
                });
                row.addEventListener("click", event => this.activate(view, heading, event));
                row.addEventListener("contextmenu", event => this.activate(view, heading, event));
                view.scroller.append(row);
                view.rows.set(heading, row);
            }
            const block = row.children[0] as HTMLButtonElement;
            block.title = block.ariaLabel = `${subtype.toUpperCase()} 标题块菜单`;
            block.querySelector("use")!.setAttribute("href", `#icon${subtype.toUpperCase()}`);
            const folded = heading.getAttribute("fold") === "1";
            const fold = row.children[1] as HTMLButtonElement;
            fold.title = fold.ariaLabel = folded ? "展开标题" : "折叠标题";
            fold.setAttribute("aria-expanded", String(!folded));
            fold.querySelector<SVGElement>("svg")!.style.transform = folded ? "" : "rotate(90deg)";
        }
        this.scheduleLayout();
    }

    private createButton(label: string, iconID: string) {
        const button = document.createElement("button");
        button.type = "button";
        button.title = button.ariaLabel = label;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(svg.namespaceURI, "use");
        use.setAttribute("href", `#${iconID}`);
        svg.append(use);
        button.append(svg);
        return button;
    }

    private activate(view: EditorView, heading: HTMLElement, event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        const clicked = (event.target as Element).closest("button");
        const gutter = view.protyle.gutter;
        if (!clicked || !gutter || !heading.isConnected) return;
        // 兼容旧版四参数和新版三参数 render，实际操作始终交给原生 gutter。
        if (gutter.render.length >= 4) gutter.render(view.protyle, heading, view.content, heading);
        else (gutter.render as unknown as (protyle: IProtyle, element: Element, target?: Element) => void)
            .call(gutter, view.protyle, heading, heading);
        if (gutter.element.classList.contains("fn__none")) return;
        const block = Array.from(gutter.element.querySelectorAll<HTMLButtonElement>('button[data-type="NodeHeading"]'))
            .find(button => button.dataset.nodeId === heading.dataset.nodeId);
        if (!block) return;
        const isFold = clicked.classList.contains("heading-gutter-persistent__fold");
        if (isFold && event.type === "contextmenu") return;
        const target = isFold ? [block.nextElementSibling, block.previousElementSibling]
            .find(button => button?.getAttribute("data-type") === "fold") : block;
        target?.dispatchEvent(new MouseEvent(event.type, { bubbles: true, cancelable: true,
            clientX: event.clientX, clientY: event.clientY, button: event.button,
            ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey }));
        this.scheduleLayout();
    }

    private scheduleLayout = () => {
        if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            for (const view of this.views.values()) this.layout(view);
        });
    };

    private layout(view: EditorView) {
        const viewport = view.scroller.getBoundingClientRect();
        const pane = view.protyle.element.closest(".layout-tab-container")?.getBoundingClientRect() || viewport;
        const native = view.protyle.gutter!.element;
        const nativeVisible = !native.classList.contains("fn__none") && native.getClientRects().length > 0;
        const nativeHeadingIds = new Set(nativeVisible ? Array.from(native.querySelectorAll('[data-type="NodeHeading"]'))
            .map(button => button.getAttribute("data-node-id")) : []);
        // absolute 坐标以滚动容器的内边框为原点，加入滚动量后位置不随滚动重算漂移。
        const originLeft = viewport.left + view.scroller.clientLeft - view.scroller.scrollLeft;
        const originTop = viewport.top + view.scroller.clientTop - view.scroller.scrollTop;
        const fontSize = Number(window.siyuan?.config?.editor?.fontSize) || 16;
        const lineHeight = Math.floor(fontSize * 1.625);
        for (const [heading, row] of view.rows) {
            const rect = heading.getBoundingClientRect();
            const nativeOwnsHeading = nativeHeadingIds.has(heading.dataset.nodeId || "");
            row.hidden = !heading.getClientRects().length || !!heading.closest(".fn__none") ||
                !/^h[1-6]$/.test(heading.dataset.subtype || "") || nativeOwnsHeading ||
                rect.bottom <= Math.max(viewport.top, pane.top) || rect.top >= Math.min(viewport.bottom, pane.bottom);
            if (row.hidden) continue;
            const anchor = getHeadingAnchor(heading, view.content);
            row.classList.remove("heading-gutter-persistent--compressed");
            const width = row.offsetWidth;
            const height = row.offsetHeight;
            const compressed = anchor.rect.left - width - anchor.space - 4 < view.protyle.element.getBoundingClientRect().left;
            row.classList.toggle("heading-gutter-persistent--compressed", compressed);
            // 与官方 gutter/layout.ts 相同：较短块居中，长块贴首行顶部。
            const margin = anchor.rect.height < lineHeight + 8 ||
                (anchor.rect.height > lineHeight + 8 && anchor.rect.height < lineHeight * 2 + 8)
                ? (anchor.rect.height - height) / 2 : 0;
            // 超出顶部时裁剪控件，不将它钉在视口顶部，保持与标题的相对位置。
            const top = anchor.rect.top + margin;
            const actualWidth = row.offsetWidth;
            const actualHeight = row.offsetHeight;
            const left = compressed ? anchor.rect.left - actualWidth - anchor.space / 2 + 3 - 4 :
                anchor.rect.left - actualWidth - anchor.space - 4;
            row.style.left = `${left - originLeft}px`;
            row.style.top = `${top - originTop}px`;
            row.style.clipPath = `inset(${Math.max(0, Math.max(viewport.top, pane.top) - top)}px ${
                Math.max(0, left + actualWidth - Math.min(viewport.right, pane.right))}px ${
                Math.max(0, top + actualHeight - Math.min(viewport.bottom, pane.bottom))}px ${
                Math.max(0, Math.max(viewport.left, pane.left) - left)}px)`;
        }
    }

    private removeView(view: EditorView) {
        view.observer.disconnect();
        view.gutterObserver.disconnect();
        view.resizeObserver?.disconnect();
        for (const row of view.rows.values()) row.remove();
        view.rows.clear();
        view.scroller.classList.remove(SCROLLER_CLASS);
        this.views.delete(view.protyle.element);
    }

    destroy() {
        this.disposed = true;
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        document.removeEventListener("scroll", this.scheduleLayout, true);
        window.removeEventListener("resize", this.scheduleLayout);
        for (const view of this.views.values()) this.removeView(view);
    }
}
