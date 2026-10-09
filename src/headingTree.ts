import { blockDepth, DEPTH_ATTRIBUTE, EMBED_RESULT_SELECTOR, extractOutline, findRootLists, OUTLINE_CONTAINER_SELECTOR, OUTLINE_ITEM_SELECTOR,
    type OutlineEntry } from "./outline";
import { extractOutlineInlineContent, parseOutlineInlineHTML } from "./outlineInline";

// 对应思源 kernel/model/outline.go：顶层 Path 使用 name/blocks，子级 Block 使用 content/children。
export interface NativeHeading {
    id: string;
    name?: string;
    content?: string;
    nameIsHTML?: boolean;
    subType?: string;
    number?: string;
    blocks?: NativeHeading[];
    children?: NativeHeading[];
}

export interface HeadingEntry extends OutlineEntry {
    level: number;
    /** 所在查询嵌入块，用于点击时定位当前文档里的渲染副本。 */
    embedId?: string;
}

export interface HeadingFoldState {
    collapsedIds: string[];
    showLists: boolean;
    expandedListIds?: string[];
    expandedTabIds?: string[];
}

export function getHeadingEntries(entries: HeadingEntry[]): HeadingEntry[] {
    return entries.filter(entry => !entry.kind || entry.kind === "heading");
}

/** 标题和页签标题默认可见；列表由所属标题、页签或“全部展开”控制。 */
export function filterHeadingListEntries(entries: HeadingEntry[], showLists: boolean,
    expandedListIds: ReadonlySet<string>, expandedTabIds: ReadonlySet<string>):
    { visible: HeadingEntry[]; listOwnerIds: Set<string> } {
    const visible: HeadingEntry[] = [];
    const listOwnerIds = new Set<string>();
    const stack: Array<{ entry: HeadingEntry; visible: boolean }> = [];
    for (const entry of entries) {
        while (stack.length && stack[stack.length - 1].entry.depth >= entry.depth) stack.pop();
        const parentVisible = stack.length ? stack[stack.length - 1].visible : true;
        let owner: HeadingEntry | undefined;
        let tab: HeadingEntry | undefined;
        for (let index = stack.length - 1; index >= 0; index--) {
            const ancestor = stack[index].entry;
            if (!owner && (!ancestor.kind || ancestor.kind === "heading")) owner = ancestor;
            if (!tab && ancestor.kind === "tab") tab = ancestor;
            if (owner && tab) break;
        }
        let isVisible: boolean;
        if (!entry.kind || entry.kind === "heading") {
            isVisible = true;
        } else if (entry.kind === "tab") {
            isVisible = parentVisible;
        } else {
            if (owner && !tab) listOwnerIds.add(owner.id);
            const rootOwner = !owner && !tab ? stack[0]?.entry || entry : undefined;
            isVisible = parentVisible && (showLists || !!(owner && expandedListIds.has(owner.id)) ||
                !!(tab && expandedTabIds.has(tab.id)) || !!(rootOwner && expandedListIds.has(rootOwner.id)));
        }
        if (isVisible) visible.push(entry);
        stack.push({ entry, visible: isVisible });
    }
    return { visible, listOwnerIds };
}

export function expandCollapsedAncestors(entries: HeadingEntry[], id: string, collapsedIds: Set<string>,
    expandedListIds?: Set<string>, expandedTabIds?: Set<string>): boolean {
    const index = entries.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    let depth = entries[index].depth;
    let changed = false;
    let nearestHeading: HeadingEntry | undefined;
    let hasTabAncestor = false;
    let rootAncestor: HeadingEntry | undefined;
    for (let position = index - 1; position >= 0 && depth > 1; position--) {
        const entry = entries[position];
        if (entry.depth >= depth) continue;
        changed = collapsedIds.delete(entry.id) || changed;
        if (!nearestHeading && (!entry.kind || entry.kind === "heading")) nearestHeading = entry;
        if (entry.kind === "tab") {
            hasTabAncestor = true;
            if (expandedTabIds && !expandedTabIds.has(entry.id)) {
                expandedTabIds.add(entry.id);
                changed = true;
            }
        }
        rootAncestor = entry;
        depth = entry.depth;
    }
    const current = entries[index];
    if (current.kind === "list") changed = collapsedIds.delete(current.id) || changed;
    if (expandedListIds && current.kind && current.kind !== "tab" &&
        (!hasTabAncestor || (!nearestHeading && rootAncestor?.kind !== "tab"))) {
        const ownerId = nearestHeading?.id || rootAncestor?.id || current.id;
        if (!expandedListIds.has(ownerId)) {
            expandedListIds.add(ownerId);
            changed = true;
        }
    }
    return changed;
}

export function getHeadingOutlineTargetSelector(preview: boolean): string {
    return preview
        ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id],p[id]"
        : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id], ' +
            '[data-type="NodeTabItem"][data-node-id], [data-type="NodeParagraph"][data-node-id]';
}

export function findClosestHeadingOutlineTargetId(element: Element, root: Element, ids: ReadonlySet<string>,
    preview: boolean): string {
    const selector = getHeadingOutlineTargetSelector(preview);
    let target = element.closest<HTMLElement>(selector);
    while (target && root.contains(target)) {
        const id = preview ? target.id : target.dataset.nodeId || "";
        if (ids.has(id)) return id;
        target = target.parentElement?.closest<HTMLElement>(selector) || null;
    }
    return "";
}

/** 有下级大纲条目的标题、段落、列表项和页签项可以单独折叠。 */
export function getCollapsibleEntryIds(entries: HeadingEntry[]): Set<string> {
    const ids = new Set<string>();
    for (let index = 0; index < entries.length - 1; index++) {
        const entry = entries[index];
        const supportsCollapse = !entry.kind || entry.kind === "heading" ||
            entry.kind === "paragraph" || entry.kind === "list" || entry.kind === "tab";
        if (supportsCollapse && entries[index + 1].depth > entry.depth) ids.add(entry.id);
    }
    return ids;
}

/** 页签正文默认收起；显式展开的页签才从折叠集合中移除。 */
export function getEffectiveCollapsedIds(entries: HeadingEntry[], collapsedIds: ReadonlySet<string>,
    expandedTabIds: ReadonlySet<string>): Set<string> {
    const effective = new Set(collapsedIds);
    const collapsibleIds = getCollapsibleEntryIds(entries);
    for (const entry of entries) {
        if (entry.kind === "tab" && collapsibleIds.has(entry.id) && !expandedTabIds.has(entry.id)) {
            effective.add(entry.id);
        }
    }
    return effective;
}

/** 从扁平大纲中过滤掉已折叠条目的所有后代，遇到同级或更高层级时恢复显示。 */
export function filterCollapsedEntries(entries: HeadingEntry[], collapsedIds: ReadonlySet<string>): HeadingEntry[] {
    const visible: HeadingEntry[] = [];
    let hiddenBelowDepth: number | undefined;
    for (const entry of entries) {
        if (hiddenBelowDepth !== undefined) {
            if (entry.depth > hiddenBelowDepth) continue;
            hiddenBelowDepth = undefined;
        }
        visible.push(entry);
        if (collapsedIds.has(entry.id)) hiddenBelowDepth = entry.depth;
    }
    return visible;
}

const EMBED_SELECTOR = '[data-type="NodeBlockQueryEmbed"][data-node-id]';
const PARAGRAPH_SELECTOR = '[data-type="NodeParagraph"][data-node-id]';

/**
 * Kernel 的 BlockDOM 只有嵌入查询语句，不包含前端异步渲染出的查询结果。
 * 将当前编辑器中顶层嵌入块的结果复制到快照，既保留折叠内容，又能按文档顺序提取嵌入列表。
 */
function mergeRenderedEmbeds(document: Document, liveRoot?: Element | null) {
    if (!liveRoot) return;
    const liveEmbeds = Array.from(liveRoot.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
        .filter(embed => !embed.closest(EMBED_RESULT_SELECTOR));
    for (const liveEmbed of liveEmbeds) {
        const id = liveEmbed.dataset.nodeId;
        if (!id) continue;
        const snapshotEmbed = Array.from(document.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
            .find(embed => embed.dataset.nodeId === id);
        if (!snapshotEmbed) continue;
        for (const result of Array.from(liveEmbed.children).filter(child => child.matches(EMBED_RESULT_SELECTOR))) {
            snapshotEmbed.append(result.cloneNode(true));
        }
    }
}

function extractParagraphContent(paragraph: HTMLElement): Pick<OutlineEntry, "text" | "inlineHTML"> {
    const content = paragraph.querySelector<HTMLElement>('[contenteditable="true"]');
    const inline = extractOutlineInlineContent(content || paragraph);
    return { text: inline.text || "（空段落）", ...(inline.html ? { inlineHTML: inline.html } : {}) };
}

export function findEmbeddedOutlineTarget(root: Element, id: string, embedId: string): HTMLElement | null {
    const embed = Array.from(root.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
        .find(node => node.dataset.nodeId === embedId);
    return Array.from(embed?.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR) || [])
        .find(node => node.dataset.nodeId === id) || null;
}

/** 用完整文档 DOM 确定列表和页签位置，标题文字及层级仍沿用思源原生大纲。 */
export function includeListsInHeadingTree(headings: HeadingEntry[], dom: string, defaultDepth: number,
    liveRoot?: Element | null, previewDocumentId?: string): HeadingEntry[] {
    const document = new DOMParser().parseFromString(dom, "text/html");
    mergeRenderedEmbeds(document, liveRoot);
    const headingMap = new Map(headings.map(entry => [entry.id, entry]));
    const listItems = new Map<string, HeadingEntry>();
    // 导出预览会把文档标题作为 H1 加入原生大纲，但 getBlockDOM 的正文不含该标题。
    // 预先保留它的首位和深度，避免被末尾的快照缺失兜底逻辑追加到正文后面。
    const documentTitle = previewDocumentId ? headingMap.get(previewDocumentId) : undefined;
    const entries: HeadingEntry[] = documentTitle ? [documentTitle] : [];
    const seen = new Set<string>(documentTitle ? [documentTitle.id] : []);
    const seenParagraphs = new Set<string>();
    const rootContainers = new Set(findRootLists(document.body));
    let headingDepth = documentTitle?.depth ?? 0;
    const selector = `[data-type="NodeHeading"], ${PARAGRAPH_SELECTOR}, ${OUTLINE_CONTAINER_SELECTOR}, ${OUTLINE_ITEM_SELECTOR}`;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const id = node.dataset.nodeId || "";
        const heading = headingMap.get(id);
        if (heading) {
            if (seen.has(id)) continue;
            entries.push(heading);
            seen.add(id);
            headingDepth = heading.depth;
        } else if (node.matches(OUTLINE_CONTAINER_SELECTOR) && rootContainers.has(node) &&
            (!node.closest('[data-type="NodeBlockQueryEmbed"]') || node.closest(EMBED_RESULT_SELECTOR))) {
            const depth = blockDepth(node.getAttribute(DEPTH_ATTRIBUTE)) ?? defaultDepth;
            const embed = node.closest<HTMLElement>(EMBED_SELECTOR);
            const embedId = embed?.dataset.nodeId;
            const directParagraph = node.previousElementSibling?.matches(PARAGRAPH_SELECTOR)
                ? node.previousElementSibling as HTMLElement : null;
            const embedParagraph = !directParagraph && node.closest(EMBED_RESULT_SELECTOR) &&
                embed?.previousElementSibling?.matches(PARAGRAPH_SELECTOR)
                ? embed.previousElementSibling as HTMLElement : null;
            const paragraphOwner = embedParagraph?.parentElement?.closest<HTMLElement>(OUTLINE_ITEM_SELECTOR);
            const ownerEntry = listItems.get(paragraphOwner?.dataset.nodeId || "");
            const baseDepth = ownerEntry?.depth ?? headingDepth;
            // 嵌入结果以独立根列表提取；此时父段落位于查询嵌入块之前，而不是列表结果内部。
            // 若嵌入块本身位于普通列表项正文中，则不重复加入该列表项的正文段落。
            const paragraph = embedParagraph && paragraphOwner?.matches('[data-type="NodeListItem"]')
                ? null : directParagraph || embedParagraph;
            const paragraphId = paragraph?.dataset.nodeId || "";
            const paragraphEmbedId = paragraph?.closest<HTMLElement>(EMBED_SELECTOR)?.dataset.nodeId;
            if (paragraph && !seenParagraphs.has(paragraphId)) {
                seenParagraphs.add(paragraphId);
                entries.push({ id: paragraphId, ...extractParagraphContent(paragraph),
                    depth: baseDepth + 1, level: 0, kind: "paragraph",
                    ...(paragraphEmbedId ? { embedId: paragraphEmbedId } : {}) });
            }
            for (const entry of extractOutline(node, depth)) {
                listItems.set(entry.id, { ...entry, depth: baseDepth + entry.depth + (paragraph ? 1 : 0), level: 0,
                    kind: entry.kind === "tab" ? "tab" : "list", ...(embedId ? { embedId } : {}) });
            }
        } else if (node.matches(PARAGRAPH_SELECTOR)) {
            const list = node.nextElementSibling?.matches('[data-type="NodeList"][data-node-id]')
                ? node.nextElementSibling as HTMLElement : null;
            const owner = list?.parentElement?.closest<HTMLElement>(OUTLINE_ITEM_SELECTOR);
            // 根列表的前置段落已在上方处理；这里仅补齐页签正文中嵌套列表的父段落。
            if (!list || rootContainers.has(list) || !owner?.matches('[data-type="NodeTabItem"]')) continue;
            const firstItem = Array.from(list.children)
                .find(child => child.matches('[data-type="NodeListItem"][data-node-id]')) as HTMLElement | undefined;
            const firstEntry = firstItem ? listItems.get(firstItem.dataset.nodeId || "") : undefined;
            if (!firstEntry) continue;
            const embedId = list.closest<HTMLElement>(EMBED_SELECTOR)?.dataset.nodeId;
            entries.push({ id, ...extractParagraphContent(node), depth: firstEntry.depth, level: 0,
                kind: "paragraph", ...(embedId ? { embedId } : {}) });
            for (const item of Array.from(list.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR))) {
                const entry = listItems.get(item.dataset.nodeId || "");
                if (entry) entry.depth++;
            }
        } else if (listItems.has(id)) {
            entries.push(listItems.get(id)!);
        }
    }
    // 快照与原生大纲短暂不同步时，不丢失已有标题。
    entries.push(...headings.filter(entry => !seen.has(entry.id)));
    return entries;
}

export function flattenHeadingTree(nodes: NativeHeading[] | null): HeadingEntry[] {
    const entries: HeadingEntry[] = [];
    const seen = new Set<string>();
    function visit(items: NativeHeading[], depth: number) {
        for (const node of items) {
            if (!node || !node.id || seen.has(node.id)) continue;
            seen.add(node.id);
            // Block.name 是块命名属性（常为空），不是子标题正文；原生 Tree.genBlockHTML 读取 content。
            const isBlock = typeof node.content === "string";
            let text = isBlock ? node.content! : node.name ?? "";
            let inlineHTML: string | undefined;
            if (isBlock || node.nameIsHTML !== false) {
                const content = parseOutlineInlineHTML(text);
                text = content.text;
                inlineHTML = content.html;
            }
            text = text.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim() || "（空标题）";
            if (inlineHTML && node.number) {
                const number = document.createElement("span");
                number.textContent = `${node.number} `;
                inlineHTML = number.outerHTML + inlineHTML;
            }
            entries.push({ id: node.id, text: node.number ? `${node.number} ${text}` : text, depth,
                ...(inlineHTML ? { inlineHTML } : {}),
                level: /^h[1-6]$/.test(node.subType || "") ? Number(node.subType![1]) : Math.min(depth, 6) });
            visit([...(node.blocks || []), ...(node.children || [])], depth + 1);
        }
    }
    visit(Array.isArray(nodes) ? nodes : [], 1);
    return entries;
}
