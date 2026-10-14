import { MAX_DEPTH } from "./defaultSettings";
import { extractOutlineInlineContent } from "./outlineInline";

export const DEPTH_ATTRIBUTE = "custom-list-outline-depth";
export const LIST_SELECTOR = '[data-type="NodeList"][data-node-id]';
export const TABS_SELECTOR = '[data-type="NodeTabs"][data-node-id]';
export const OUTLINE_CONTAINER_SELECTOR = `${LIST_SELECTOR}, ${TABS_SELECTOR}`;
export const OUTLINE_ITEM_SELECTOR = '[data-type="NodeListItem"], [data-type="NodeTabItem"]';
export const EMBED_RESULT_SELECTOR = ".protyle-wysiwyg__embed";
const QUOTE_SELECTOR = '[data-type="NodeBlockquote"], blockquote';

export interface OutlineEntry {
    id: string;
    text: string;
    /** 已清理的行内 HTML；text 仍用于搜索和无障碍提示。 */
    inlineHTML?: string;
    depth: number;
    images?: OutlineImage[];
    kind?: "heading" | "paragraph" | "list" | "tab";
    listType?: "unordered" | "ordered" | "task";
    /** 有序列表保留正文编号，过滤后不重新编号。 */
    listMarker?: string;
    /** 思源任务标记：空格、X/x、/、- 或自定义字符。 */
    taskMarker?: string;
}

function extractListMetadata(item: Element, list: Element, index: number): Partial<OutlineEntry> {
    const subtype = item.getAttribute("data-subtype") || list.getAttribute("data-subtype");
    if (subtype === "t") {
        return { listType: "task", taskMarker: item.getAttribute("data-task") ??
            item.querySelector(':scope > .protyle-action--task')?.getAttribute("data-task") ?? " " };
    }
    if (subtype === "o") {
        return { listType: "ordered", listMarker: item.getAttribute("data-marker") ||
            normalizedText(item.querySelector(':scope > .protyle-action')) || `${index}.` };
    }
    return subtype === "u" ? { listType: "unordered" } : {};
}

/** 仅移除完成项；其后代提升到最近的可见父项，避免未完成子任务被一起隐藏。 */
export function filterCompletedTasks<T extends OutlineEntry>(entries: T[], hideCompleted: boolean): T[] {
    if (!hideCompleted) return entries;
    const visible: T[] = [];
    const ancestors: Array<{ depth: number; hidden: boolean }> = [];
    let hiddenAncestors = 0;
    for (const entry of entries) {
        while (ancestors.length && ancestors[ancestors.length - 1].depth >= entry.depth) {
            if (ancestors.pop()!.hidden) hiddenAncestors--;
        }
        const hidden = entry.listType === "task" && entry.taskMarker?.toUpperCase() === "X";
        if (!hidden) visible.push(hiddenAncestors ? { ...entry, depth: entry.depth - hiddenAncestors } : entry);
        ancestors.push({ depth: entry.depth, hidden });
        if (hidden) hiddenAncestors++;
    }
    return visible;
}

export interface OutlineImage {
    src: string;
    alt: string;
    title?: string;
}

function normalizedText(element?: Element | null): string {
    return (element?.textContent || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function imageTitle(image: HTMLImageElement): string {
    return image.getAttribute("title")?.trim() ||
        image.closest('[data-type="img"], .img')?.querySelector<HTMLElement>('.protyle-action__title span')?.textContent?.trim() || "";
}

export function blockDepth(value: string | null): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const depth = Number(value);
    return depth >= 1 && depth <= MAX_DEPTH ? depth : null;
}

export function findList(target: Element): HTMLElement | null {
    const editor = target.closest(".protyle-wysiwyg");
    if (!editor) return null;
    const embedResult = target.closest(EMBED_RESULT_SELECTOR);
    let list = target.closest<HTMLElement>(OUTLINE_CONTAINER_SELECTOR);
    let result: HTMLElement | null = null;
    // 子列表和嵌套页签属于同一份大纲；在子项间移动时不切换悬浮面板。
    // 嵌入结果是独立的显示边界，不能继续归入外层正文列表。
    while (list && editor.contains(list) && list.closest(EMBED_RESULT_SELECTOR) === embedResult) {
        if (!list.closest(QUOTE_SELECTOR)) result = list;
        list = list.parentElement?.closest<HTMLElement>(OUTLINE_CONTAINER_SELECTOR);
    }
    return result;
}

export function findRootLists(container: Element): HTMLElement[] {
    const lists = Array.from(container.querySelectorAll<HTMLElement>(OUTLINE_CONTAINER_SELECTOR));
    return lists.filter(list => {
        if (list.closest(QUOTE_SELECTOR)) return false;
        const parentList = list.parentElement?.closest(OUTLINE_CONTAINER_SELECTOR);
        return !parentList || !container.contains(parentList) ||
            parentList.closest(EMBED_RESULT_SELECTOR) !== list.closest(EMBED_RESULT_SELECTOR);
    });
}

export function extractOutline(root: HTMLElement, maxDepth: number): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    function visit(list: Element, depth: number) {
        if (depth > maxDepth || list.closest(QUOTE_SELECTOR)) return;
        const isTabs = list.matches(TABS_SELECTOR);
        const directItemSelector = isTabs ? '[data-type="NodeTabItem"]' : '[data-type="NodeListItem"]';
        let itemIndex = 0;
        for (const item of Array.from(list.children)) {
            if (!item.matches(directItemSelector)) continue;
            itemIndex++;
            // 列表项取自己的首个文本块；页签项只取原始标题，不能把页签正文拼进大纲。
            const content = isTabs
                ? item.querySelector<HTMLElement>(":scope > .tab-item-info > .tab-item-title, " +
                    ':scope > .tab-item-info > [tabs-title] > .tab-item-title')
                : Array.from(item.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
                    .find(element => element.closest(OUTLINE_ITEM_SELECTOR) === item &&
                        !element.closest(QUOTE_SELECTOR) &&
                        !element.closest('.protyle-attr, .protyle-action, [data-type="NodeCodeBlock"], [data-type="NodeTable"]'));
            const clone = content?.cloneNode(true) as HTMLElement | undefined;
            clone?.querySelectorAll('.protyle-attr, .protyle-action, script, style, .img__net').forEach(node => node.remove());
            const imageElements = Array.from(clone?.querySelectorAll<HTMLImageElement>('img') || []);
            const textOnlyClone = clone?.cloneNode(true) as HTMLElement | undefined;
            textOnlyClone?.querySelectorAll('img, .protyle-action__title').forEach(node => node.remove());
            textOnlyClone?.querySelectorAll('[data-type~="inline-math"]').forEach(math =>
                math.replaceWith(math.getAttribute("data-content") || math.textContent || ""));
            const isImageOnly = imageElements.length > 0 && !normalizedText(textOnlyClone);
            const images = isImageOnly ? imageElements.flatMap(image => {
                const src = image.getAttribute("data-src") || image.getAttribute("src") || "";
                const title = imageTitle(image);
                return src ? [{ src, alt: image.getAttribute("alt") || "图片", ...(title ? { title } : {}) }] : [];
            }) : [];
            clone?.querySelectorAll('.protyle-action__title').forEach(node => node.remove());
            const inline = clone ? extractOutlineInlineContent(clone) : { text: "" };
            const text = images.length ? images.map(image => image.title).filter(Boolean).join(" ") || "图片" : inline.text;
            const id = item.getAttribute("data-node-id");
            if (id) entries.push({ id, text: text || (isTabs ? "（空页签）" : "（空列表项）"), depth,
                ...(images.length ? { images } : inline.html ? { inlineHTML: inline.html } : {}),
                ...(isTabs ? { kind: "tab" as const } : extractListMetadata(item, list, itemIndex)) });
            // 只有嵌套列表或页签增加层级；引述块中的容器整体跳过。
            for (const child of Array.from(item.querySelectorAll(OUTLINE_CONTAINER_SELECTOR))) {
                if (child.parentElement?.closest(OUTLINE_ITEM_SELECTOR) === item &&
                    child.parentElement?.closest(OUTLINE_CONTAINER_SELECTOR) === list &&
                    child.closest(EMBED_RESULT_SELECTOR) === list.closest(EMBED_RESULT_SELECTOR)) visit(child, depth + 1);
            }
        }
    }
    visit(root, 1);
    return entries;
}

export function hasChildBlocks(root: HTMLElement): boolean {
    if (!root || !root.querySelectorAll) return false;
    const items = Array.from(root.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR));
    if (!items.length) return false;

    for (const item of items) {
        // 1. 包含嵌套子列表或引述块
        if (item.querySelector(OUTLINE_CONTAINER_SELECTOR) || item.querySelector(QUOTE_SELECTOR)) {
            return true;
        }
        // 2. 包含代码块、超级块、表格、公式块、HTML块、嵌入块等复合子块
        if (item.querySelector('[data-type="NodeCodeBlock"], [data-type="NodeSuperBlock"], [data-type="NodeTable"], [data-type="NodeMathBlock"], [data-type="NodeHTMLBlock"], [data-type="NodeBlockQueryEmbed"], [data-type="NodeIFrame"], [data-type="NodeWidget"], [data-type="NodeVideo"], [data-type="NodeAudio"], [data-type="NodeHeading"]')) {
            return true;
        }
        // 3. 包含多个直接内容块（例如两个或更多段落）
        const childBlocks = Array.from(item.querySelectorAll<HTMLElement>('[data-type]')).filter(el => {
            if (el === item) return false;
            if (el.closest(OUTLINE_ITEM_SELECTOR) !== item) return false;
            const type = el.getAttribute("data-type") || "";
            return type.startsWith("Node") && !["NodeListItem", "NodeTabItem"].includes(type);
        });
        if (childBlocks.length > 1) {
            return true;
        }
    }
    return false;
}
