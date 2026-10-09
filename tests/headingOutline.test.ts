import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { expandCollapsedAncestors, filterHeadingListEntries, flattenHeadingTree, includeListsInHeadingTree } from "../src/headingTree";
import { HeadingOutlineController, type HeadingEditor } from "../src/headingOutline";

const tree = [{ id: "h1", name: "<strong>一级标题</strong>", subType: "h1", number: "1.", blocks: [
    { id: "h3", name: "", content: "三级标题", subType: "h3", children: [{ id: "h6", name: "自定义块名", content: "六级标题", subType: "h6" }] },
] }, { id: "h2", name: "第二章", subType: "h2" }];
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function setup(request?: (url: string, data: Record<string, unknown>) => Promise<any>, mobile = false,
    withEditor = true, initialSettings: Parameters<typeof normalizeSettings>[0] = {}) {
    const dom = new JSDOM('<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"><div data-type="NodeHeading" data-node-id="h1"><div contenteditable="true">标题</div></div></div></div></div>', { pretendToBeVisual: true });
    const win = dom.window;
    for (const key of ["window", "document", "Element", "Node", "HTMLElement", "DOMParser", "MutationObserver"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true, writable: true });
    }
    Object.assign(globalThis, { requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });
    const transactions: any[] = [];
    const editors: HeadingEditor[] = [{ element: win.document.querySelector('.protyle')!, content: win.document.querySelector('.protyle-wysiwyg')!, rootID: "doc1", notebook: "notebook1", preview: false,
        transaction: (operations, undoOperations) => transactions.push({ operations, undoOperations }) }];
    const initialEditor = editors[0];
    if (!withEditor) editors.length = 0;
    const calls: { url: string; data: Record<string, unknown> }[] = [];
    const navigations: { id: string; folded: boolean }[] = [];
    const menus: any[] = [];
    const levelMenus: { currentLevel: number; selectLevel(level: number): void; onClose?: () => void }[] = [];
    let settings = normalizeSettings(initialSettings);
    const foldStates: Record<string, { collapsedIds: string[]; showLists: boolean; expandedListIds?: string[];
        expandedTabIds?: string[] }> = {};
    const controller = new HeadingOutlineController({ getEditors: () => editors,
        isMobile: () => mobile,
        newNodeID: () => "new-child-list",
        getSettings: () => settings,
        setListDepth: async depth => { settings = { ...settings, headingListDepth: depth }; },
        getFoldState: documentId => foldStates[documentId],
        saveFoldState: async (documentId, state) => { foldStates[documentId] = state; },
        request: async (url, data) => { calls.push({ url, data }); return request ? request(url, data) : url.endsWith("checkBlockFold") ? { isFolded: true } : tree; },
        navigate: (id, folded) => navigations.push({ id, folded }), reportError: () => {},
        openInsertMenu: (event, target) => { event.preventDefault(); menus.push(target); },
        openHeadingLevelMenu: (_target, currentLevel, selectLevel, onClose) => levelMenus.push({ currentLevel, selectLevel, onClose }),
    });
    const panel = win.document.querySelector<HTMLElement>('.heading-outline-floating')!;
    return { win, editors, initialEditor, calls, navigations, transactions, menus, levelMenus, controller, panel, foldStates,
        setSettings: (value: Parameters<typeof normalizeSettings>[0]) => { settings = normalizeSettings(value); controller.refreshSettings(); },
        cleanup: () => { controller.destroy(); win.close(); } };
}

test("悬浮大纲增强：无文档启动和定时同步不报错，打开再关闭文档后仍可同步", async () => {
    const env = setup(undefined, false, false);
    try {
        env.controller.syncEditors();
        await new Promise(resolve => setTimeout(resolve, 550));
        assert.equal(env.panel.hidden, true);
        assert.equal(env.calls.length, 0);

        env.editors.push(env.initialEditor);
        env.controller.syncEditors();
        await settle();
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.querySelectorAll("button[data-id]").length, 4);

        env.editors.length = 0;
        env.controller.syncEditors();
        env.controller.syncEditors();
        assert.equal(env.panel.hidden, true);
        assert.equal(env.panel.querySelectorAll("button[data-id]").length, 0);

        env.editors.push(env.initialEditor);
        env.controller.syncEditors();
        await settle();
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.querySelectorAll("button[data-id]").length, 4);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强：默认只显示标题，单独展开标题可显示列表", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeHeading" data-node-id="h3"></div>' +
        '<div data-type="NodeHeading" data-node-id="h6"></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="item">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">列表项</div></div></div></div>' +
        '<div data-type="NodeHeading" data-node-id="h2"></div>' +
        '<div data-type="NodeList" data-node-id="list-two"><div data-type="NodeListItem" data-node-id="item-two">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">第二章列表</div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree,
        false, true, { headingListDepth: 2 });
    try {
        await settle();
        const ids = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        assert.deepEqual(ids(), ["h1", "h3", "h6", "h2"]);
        assert.equal(env.panel.querySelector('[data-outline-toggle="h6"]')?.getAttribute("aria-expanded"), "false");
        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="h1"]')!.click();
        assert.deepEqual(ids(), ["h1", "h2"]);
        assert.deepEqual(env.foldStates.doc1.collapsedIds, ["h1"]);

        env.editors[0] = { ...env.editors[0], rootID: "doc2" };
        env.controller.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "h3", "h6", "h2"]);
        env.editors[0] = { ...env.editors[0], rootID: "doc1" };
        env.controller.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "h2"]);

        const current = env.win.document.createElement("div");
        current.dataset.type = "NodeHeading";
        current.dataset.nodeId = "h6";
        env.editors[0].content.append(current);
        current.click();
        env.setSettings({ headingListDepth: 2, keepCurrentHeadingExpanded: true });
        await settle();
        current.click();
        assert.deepEqual(ids(), ["h1", "h3", "h6", "h2"]);
        assert.deepEqual(env.foldStates.doc1.collapsedIds, []);

        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="h6"]')!.click();
        assert.deepEqual(ids(), ["h1", "h3", "h6", "item", "h2"]);
        assert.deepEqual(env.foldStates.doc1.expandedListIds, ["h6"]);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强：展开层级菜单控制标题、列表和页签并保存折叠状态", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeHeading" data-node-id="h3"></div>' +
        '<div data-type="NodeHeading" data-node-id="h6"></div>' +
        listRoot(listDOM("item", "列表项")) +
        '<div data-type="NodeHeading" data-node-id="h2"></div>' +
        tabsRoot("tabs", tabDOM("tab-one", "页签", listRoot(listDOM("tab-item", "页签列表"))));
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree,
        false, true, { headingListDepth: 2 });
    try {
        await settle();
        const ids = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const button = env.panel.querySelector<HTMLButtonElement>('button[aria-label="展开层级"]')!;
        assert.ok(button);
        assert.equal(button.querySelector("use")?.getAttribute("href"), "#iconExpandLevel");
        assert.equal(env.panel.querySelector('button[aria-label="保存当前层级展开"]'), null);
        let bubbled = false;
        const onDocumentClick = () => { bubbled = true; };
        env.win.document.addEventListener("click", onDocumentClick);
        button.click();
        env.win.document.removeEventListener("click", onDocumentClick);
        assert.equal(bubbled, false);
        assert.equal(env.levelMenus.at(-1)!.currentLevel, 6);
        // JSDOM 不会根据合成 pointerleave 更新 :hover，显式模拟鼠标已离开。
        const matches = env.panel.matches.bind(env.panel);
        env.panel.matches = selector => selector === ":hover" ? false : matches(selector);
        env.panel.dispatchEvent(new env.win.Event("pointerleave"));
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), true);

        env.levelMenus.at(-1)!.selectLevel(1);
        assert.deepEqual(ids(), ["h1", "h2"]);
        assert.deepEqual(env.foldStates.doc1.collapsedIds, ["h1", "h3", "h6", "h2"]);
        env.levelMenus.at(-1)!.onClose!();
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);

        button.click();
        assert.equal(env.levelMenus.at(-1)!.currentLevel, 1);
        env.levelMenus.at(-1)!.selectLevel(3);
        assert.deepEqual(ids(), ["h1", "h3", "h2", "tab-one"]);
        env.levelMenus.at(-1)!.selectLevel(6);
        assert.deepEqual(ids(), ["h1", "h3", "h6", "item", "h2", "tab-one", "tab-item"]);
        assert.deepEqual(env.foldStates.doc1.collapsedIds, []);
        assert.deepEqual(env.foldStates.doc1.expandedTabIds, ["tab-one"]);

        env.levelMenus.at(-1)!.selectLevel(3);
        env.editors[0] = { ...env.editors[0], rootID: "doc2" };
        env.controller.syncEditors();
        await settle();
        const savedDoc1 = structuredClone(env.foldStates.doc1);
        env.levelMenus.at(-1)!.selectLevel(6);
        assert.deepEqual(env.foldStates.doc1, savedDoc1);
        assert.equal(env.foldStates.doc2, undefined);
        env.editors[0] = { ...env.editors[0], rootID: "doc1" };
        env.controller.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "h3", "h2", "tab-one"]);
    } finally { env.cleanup(); }
});

test("旧设置补齐独立开关，关闭任一功能不影响另一功能", () => {
    assert.equal(normalizeSettings({ defaultDepth: 4 }).enableHeadingOutline, true);
    assert.equal(normalizeSettings({ enableHeadingOutline: false }).enableListOutline, true);
    assert.equal(normalizeSettings({ enableListOutline: false }).enableHeadingOutline, true);
    assert.equal(normalizeSettings({ enableHeadingOutline: false }).enableHeadingOutline, false);
    assert.equal(normalizeSettings().headingListDepth, 0);
    assert.equal(normalizeSettings({ headingIncludeLists: true, defaultDepth: 4 }).headingListDepth, 4);
    assert.equal(normalizeSettings().headingOutlineDisplayMode, "compact");
    assert.equal(normalizeSettings({ headingOutlineDisplayMode: "icon" }).headingOutlineDisplayMode, "icon");
    assert.equal(normalizeSettings({ headingOutlineDisplayMode: "invalid" as any }).headingOutlineDisplayMode, "compact");
});

const listDOM = (id: string, text: string, children = "") => `<div data-type="NodeListItem" data-node-id="${id}"><div data-type="NodeParagraph"><div contenteditable="true">${text}</div></div>${children}</div>`;
const listRoot = (items: string, attrs = "") => `<div data-type="NodeList" data-node-id="root-${items.length}" ${attrs}>${items}</div>`;
const tabDOM = (id: string, title: string, children = "") => `<div class="tab-item" data-type="NodeTabItem" data-node-id="${id}"><div class="tab-item-info"><div data-type="NodeParagraph" tabs-title="true"><div class="tab-item-title" contenteditable="true">${title}</div></div></div><div class="tab-item-content">${children}</div></div>`;
const tabsRoot = (id: string, items: string) => `<div class="tabs" data-type="NodeTabs" data-node-id="${id}">${items}</div>`;
const embedBlock = (id: string, results = "") => `<div data-type="NodeBlockQueryEmbed" data-node-id="${id}">${results}</div>`;
const embedResult = (content: string) => `<div class="protyle-wysiwyg__embed">${content}</div>`;
const mixedDOM = listRoot(listDOM("intro", "开头列表")) + '<div data-type="NodeHeading" data-node-id="h1"></div>' +
    listRoot(listDOM("one", "第一项", listRoot(listDOM("two", "子项"))), 'custom-list-outline-depth="1"') +
    '<div data-type="NodeHeading" data-node-id="h3"></div>' + listRoot(listDOM("three", "第二节列表", listRoot(listDOM("four", "嵌套项")))) +
    '<div data-type="NodeBlockquote">' + listRoot(listDOM("quote", "不提取")) + '</div>';

test("混合目录按文档顺序归入标题，沿用独立层级且排除引述列表", () => {
    const env = setup();
    try {
        const entries = includeListsInHeadingTree(flattenHeadingTree(tree).slice(0, 2), mixedDOM, 2);
        assert.deepEqual(entries.map(({ id, depth }) => ({ id, depth })), [
            { id: "intro", depth: 1 }, { id: "h1", depth: 1 }, { id: "one", depth: 2 },
            { id: "h3", depth: 2 }, { id: "three", depth: 3 }, { id: "four", depth: 4 },
        ]);
        assert.equal(entries.find(entry => entry.id === "one")?.kind, "list");
        assert.equal(entries.find(entry => entry.id === "one")?.text, "第一项");
        assert.equal(includeListsInHeadingTree([], listRoot(listDOM("only", "纯列表文档")), 3)[0].id, "only");
    } finally { env.cleanup(); }
});

test("列表前的段落作为列表父级，并将列表层级下移一级", () => {
    const env = setup();
    try {
        const dom = '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
            listRoot(listDOM("one", "第一项", listRoot(listDOM("two", "子项"))), 'custom-list-outline-depth="2"');
        const entries = includeListsInHeadingTree([], dom, 3);
        assert.deepEqual(entries.map(({ id, text, depth, kind }) => ({ id, text, depth, kind })), [
            { id: "list-parent", text: "列表说明", depth: 1, kind: "paragraph" },
            { id: "one", text: "第一项", depth: 2, kind: "list" },
            { id: "two", text: "子项", depth: 3, kind: "list" },
        ]);
    } finally { env.cleanup(); }
});

test("光标位于列表前的父级段落时，悬浮大纲增强定位该段落而非前一项", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
        listRoot(listDOM("one", "第一项"));
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ headingListDepth: 1 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const content = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="list-parent"] [contenteditable="true"]')!;
        const selection = env.win.document.getSelection()!;
        const range = env.win.document.createRange();
        range.selectNodeContents(content);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        content.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "list-parent");
        assert.equal(env.controller.locateCurrent(), "list-parent");
    } finally { env.cleanup(); }
});

test("大纲增强把当前编辑器已渲染的嵌入列表合并到文档快照", () => {
    const env = setup();
    try {
        const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' + embedBlock("embed-one") +
            '<div data-type="NodeHeading" data-node-id="h3"></div>';
        env.editors[0].content.innerHTML = snapshot.replace(embedBlock("embed-one"), embedBlock("embed-one", embedResult(
            listRoot(listDOM("embedded-one", "嵌入一级", listRoot(listDOM("embedded-two", "嵌入二级")))))));
        const entries = includeListsInHeadingTree(flattenHeadingTree(tree).slice(0, 2), snapshot, 2,
            env.editors[0].content);
        assert.deepEqual(entries.map(({ id, depth, embedId }) => ({ id, depth, embedId })), [
            { id: "h1", depth: 1, embedId: undefined },
            { id: "embedded-one", depth: 2, embedId: "embed-one" },
            { id: "embedded-two", depth: 3, embedId: "embed-one" },
            { id: "h3", depth: 2, embedId: undefined },
        ]);
    } finally { env.cleanup(); }
});

test("嵌入块渲染列表时，将嵌入块前的段落作为父级且只添加一次", () => {
    const env = setup();
    try {
        const parent = '<div data-type="NodeParagraph" data-node-id="embed-list-parent">' +
            '<div contenteditable="true"><strong>整体计划与行动</strong></div></div>';
        const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' + tabsRoot("tabs",
            tabDOM("tab-one", "20260922 Tue", parent + embedBlock("embed-one")));
        env.editors[0].content.innerHTML = snapshot.replace(embedBlock("embed-one"), embedBlock("embed-one",
            embedResult(listRoot(listDOM("embedded-one", "嵌入列表一"))) +
            embedResult(listRoot(listDOM("embedded-two", "嵌入列表二")))));

        const entries = includeListsInHeadingTree(flattenHeadingTree(tree).slice(0, 1), snapshot, 2,
            env.editors[0].content);
        assert.deepEqual(entries.map(({ id, text, depth, kind, embedId }) => ({ id, text, depth, kind, embedId })), [
            { id: "h1", text: "1. 一级标题", depth: 1, kind: undefined, embedId: undefined },
            { id: "tab-one", text: "20260922 Tue", depth: 2, kind: "tab", embedId: undefined },
            { id: "embed-list-parent", text: "整体计划与行动", depth: 3, kind: "paragraph", embedId: undefined },
            { id: "embedded-one", text: "嵌入列表一", depth: 4, kind: "list", embedId: "embed-one" },
            { id: "embedded-two", text: "嵌入列表二", depth: 4, kind: "list", embedId: "embed-one" },
        ]);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强点击嵌入列表项定位当前渲染副本，且不提供插入菜单", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' + embedBlock("embed-one");
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        env.editors[0].content.innerHTML = snapshot.replace(embedBlock("embed-one"), embedBlock("embed-one",
            embedResult(listRoot(listDOM("embedded-one", "嵌入列表项")))));
        let scrolled = false;
        env.editors[0].content.querySelector<HTMLElement>('[data-node-id="embedded-one"]')!.scrollIntoView = () => { scrolled = true; };
        env.setSettings({ headingListDepth: 2 });
        await new Promise(resolve => setTimeout(resolve, 680));

        const row = env.panel.querySelector<HTMLButtonElement>('[data-id="embedded-one"]')!;
        assert.ok(row);
        assert.equal(row.dataset.embedId, "embed-one");
        row.click();
        await settle();
        assert.equal(scrolled, true);
        assert.equal(env.navigations.length, 0);
        assert.equal(env.calls.some(call => call.url.endsWith("checkBlockFold")), false);

        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(env.menus.length, 0);
    } finally { env.cleanup(); }
});

test("大纲增强中的纯图片列表项保留图片及可选 title", () => {
    const env = setup();
    try {
        const imageDOM = listRoot(listDOM("image-only", '<span data-type="img" class="img"><img src="assets/result.png" alt="文件名"><span class="protyle-action__title"><span>结果图</span></span></span>'));
        const entry = includeListsInHeadingTree([], imageDOM, 1)[0];
        assert.equal(entry.text, "结果图");
        assert.deepEqual(entry.images, [{ src: "assets/result.png", alt: "文件名", title: "结果图" }]);
    } finally { env.cleanup(); }
});

test("大纲增强按文档顺序显示页签标题，不混入页签正文", () => {
    const env = setup();
    try {
        const dom = '<div data-type="NodeHeading" data-node-id="h1"></div>' + tabsRoot("tabs",
            tabDOM("tab-one", "实验数据", '<div data-type="NodeParagraph"><div contenteditable="true">正文不显示</div></div>') +
            tabDOM("tab-two", "分析结果", listRoot(listDOM("tab-list", "页签内列表"))));
        const entries = includeListsInHeadingTree(flattenHeadingTree(tree).slice(0, 1), dom, 2);
        assert.deepEqual(entries.map(({ id, text, depth, kind }) => ({ id, text, depth, kind })), [
            { id: "h1", text: "1. 一级标题", depth: 1, kind: undefined },
            { id: "tab-one", text: "实验数据", depth: 2, kind: "tab" },
            { id: "tab-two", text: "分析结果", depth: 2, kind: "tab" },
            { id: "tab-list", text: "页签内列表", depth: 3, kind: "list" },
        ]);
    } finally { env.cleanup(); }
});

test("页签正文中紧邻列表的段落作为列表父级，并将列表后代下移一级", () => {
    const env = setup();
    try {
        const parent = '<div data-type="NodeParagraph" data-node-id="tab-list-parent">' +
            '<div contenteditable="true"><strong>整体计划与行动</strong></div></div>';
        const dom = tabsRoot("tabs", tabDOM("tab-one", "20260920 Sun",
            parent + listRoot(listDOM("plan", "计划", listRoot(listDOM("detail", "具体行动"))))));
        const entries = includeListsInHeadingTree([], dom, 3);

        assert.deepEqual(entries.map(({ id, text, depth, kind }) => ({ id, text, depth, kind })), [
            { id: "tab-one", text: "20260920 Sun", depth: 1, kind: "tab" },
            { id: "tab-list-parent", text: "整体计划与行动", depth: 2, kind: "paragraph" },
            { id: "plan", text: "计划", depth: 3, kind: "list" },
            { id: "detail", text: "具体行动", depth: 4, kind: "list" },
        ]);
    } finally { env.cleanup(); }
});

test("文档开头的页签标题默认可见，页签内容需单独展开", () => {
    const env = setup();
    try {
        const entries = includeListsInHeadingTree([], tabsRoot("tabs",
            tabDOM("tab-one", "第一页", listRoot(listDOM("item-one", "列表一")))), 2);
        assert.deepEqual(filterHeadingListEntries(entries, false, new Set(), new Set()).visible.map(entry => entry.id),
            ["tab-one"]);
        assert.deepEqual(filterHeadingListEntries(entries, false, new Set(), new Set(["tab-one"]))
            .visible.map(entry => entry.id), ["tab-one", "item-one"]);
    } finally { env.cleanup(); }
});

test("保持当前层级展开时，文档开头的列表也能显示当前项", () => {
    const env = setup();
    try {
        const entries = includeListsInHeadingTree([], listRoot(listDOM("one", "父项",
            listRoot(listDOM("two", "子项")))), 2);
        const collapsed = new Set(["one"]);
        const expandedLists = new Set<string>();
        assert.equal(expandCollapsedAncestors(entries, "two", collapsed, expandedLists, new Set()), true);
        assert.deepEqual([...collapsed], []);
        assert.deepEqual([...expandedLists], ["one"]);
        assert.deepEqual(filterHeadingListEntries(entries, false, expandedLists, new Set())
            .visible.map(entry => entry.id), ["one", "two"]);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强使用页签图标显示页签标题，且不打开列表插入菜单", async () => {
    const dom = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        tabsRoot("tabs", tabDOM("tab-one", "实验数据", '<div data-type="NodeParagraph"><div contenteditable="true">正文不显示</div></div>'));
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom } : url.endsWith("checkBlockFold") ? { isFolded: false } : tree);
    try {
        env.setSettings({ headingListDepth: 2 });
        await settle();
        const row = env.panel.querySelector<HTMLButtonElement>('[data-id="tab-one"]')!;
        assert.ok(row);
        assert.equal(row.querySelector("use")?.getAttribute("href"), "#iconTabItem");
        assert.equal(row.querySelector(".list-outline-floating__text")?.textContent, "实验数据");
        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(env.menus.length, 0);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强：页签标题默认折叠，可单独展开下级列表", async () => {
    const dom = '<div data-type="NodeHeading" data-node-id="h1"></div>' + tabsRoot("tabs",
        tabDOM("tab-one", "第一页", listRoot(listDOM("item-one", "列表一"))) +
        tabDOM("tab-two", "第二页", listRoot(listDOM("item-two", "列表二"))));
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom } :
        [{ id: "h1", name: "标题", subType: "h1" }], false, true, { headingListDepth: 2 });
    try {
        await settle();
        const ids = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const toggle = (id: string) => env.panel.querySelector<HTMLButtonElement>(`button[data-outline-toggle="${id}"]`)!;
        assert.deepEqual(ids(), ["h1", "tab-one", "tab-two"]);
        assert.equal(toggle("tab-one").getAttribute("aria-expanded"), "false");
        assert.equal(toggle("tab-two").getAttribute("aria-expanded"), "false");

        toggle("tab-one").click();
        assert.deepEqual(ids(), ["h1", "tab-one", "item-one", "tab-two"]);
        assert.deepEqual(env.foldStates.doc1.expandedTabIds, ["tab-one"]);
        toggle("tab-one").click();
        toggle("tab-two").click();
        assert.deepEqual(ids(), ["h1", "tab-one", "tab-two", "item-two"]);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强：保持当前层级展开时，点击列表会显示其折叠祖先", async () => {
    const dom = '<div data-type="NodeHeading" data-node-id="h1"><div contenteditable="true">标题</div></div>' +
        listRoot(listDOM("one", "父项", listRoot(listDOM("two", "子项")))) +
        tabsRoot("tabs", tabDOM("tab-one", "页签", listRoot(listDOM("tab-item", "页签列表"))));
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom } :
        [{ id: "h1", name: "标题", subType: "h1" }], false, true, { headingListDepth: 3 });
    try {
        env.editors[0].content.innerHTML = dom;
        await new Promise(resolve => setTimeout(resolve, 680));
        const ids = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const clickEditor = (id: string) => env.editors[0].content.querySelector<HTMLElement>(`[data-node-id="${id}"] [contenteditable]`)!
            .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.deepEqual(ids(), ["h1", "tab-one"]);

        env.setSettings({ headingListDepth: 3, keepCurrentHeadingExpanded: true });
        await settle();
        clickEditor("h1");
        const tabToggle = env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="tab-one"]');
        if (tabToggle?.getAttribute("aria-expanded") === "true") tabToggle.click();
        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="h1"]')!.click();
        assert.deepEqual(ids(), ["h1"]);
        clickEditor("two");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one"]);
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "two");

        clickEditor("h1");
        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(ids(), ["h1", "one", "tab-one"]);
        clickEditor("one");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one"]);

        clickEditor("tab-item");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one", "tab-item"]);
        assert.deepEqual(env.foldStates.doc1.expandedTabIds, ["tab-one"]);
    } finally { env.cleanup(); }
});

test("列表层级下拉框即时生效，不显示时不读全文，混合列表支持定位和右键菜单", async () => {
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: mixedDOM } : url.endsWith("checkBlockFold") ? { isFolded: true } : tree);
    try {
        await settle();
        assert.equal(env.calls.some(call => call.url.endsWith("getBlockDOM")), false);
        const select = env.panel.querySelector<HTMLSelectElement>('select[aria-label="大纲增强列表层级"]')!;
        assert.equal(select.value, "0");
        select.value = "2";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        const row = env.panel.querySelector<HTMLButtonElement>('[data-id="three"]')!;
        assert.ok(row);
        assert.equal(row.querySelector("use")?.getAttribute("href"), "#iconListItem");
        row.click();
        await settle();
        assert.equal(env.navigations.at(-1)?.id, "three");
        row.dispatchEvent(new env.win.MouseEvent("contextmenu", { bubbles: true }));
        assert.equal(env.menus.at(-1)?.kind, "list");
        env.setSettings({ headingListDepth: 2, enableListOutline: false });
        await settle();
        assert.ok(env.panel.querySelector('[data-id="three"]'));
        const reads = env.calls.filter(call => call.url.endsWith("getBlockDOM")).length;
        select.value = "0";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(env.panel.querySelector('[data-id="three"]'), null);
        assert.equal(env.calls.filter(call => call.url.endsWith("getBlockDOM")).length, reads);
    } finally { env.cleanup(); }
});

test("关闭混合目录后，未完成的全文请求不能重新显示列表", async () => {
    let resolveDOM: (value: any) => void = () => {};
    const env = setup(async url => url.endsWith("getBlockDOM") ? new Promise(resolve => { resolveDOM = resolve; }) : tree);
    try {
        await settle();
        env.setSettings({ headingListDepth: 2 });
        await settle();
        env.setSettings({ headingListDepth: 0 });
        await settle();
        resolveDOM({ dom: mixedDOM });
        await settle();
        assert.equal(env.panel.querySelector('[data-id="one"]'), null);
        assert.ok(env.panel.querySelector('[data-id="h1"]'));
    } finally { env.cleanup(); }
});

test("大纲增强右键传递对应标题与文档上下文", async () => {
    const env = setup();
    try {
        await settle();
        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        env.panel.querySelector('[data-id="h3"] span')!.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(env.menus[0].id, "h3");
        assert.equal(env.menus[0].kind, "heading");
        assert.equal(env.menus[0].notebook, "notebook1");
    } finally { env.cleanup(); }
});

test("悬浮大纲增强拖动标题后提交排序和层级事务，并抑制拖后的点击定位", async () => {
    const env = setup();
    try {
        await settle();
        const source = env.panel.querySelector<HTMLButtonElement>('button[data-id="h2"]')!;
        const target = env.panel.querySelector<HTMLButtonElement>('button[data-id="h3"]')!;
        assert.equal(source.dataset.draggableOutline, "heading");
        target.getBoundingClientRect = () => ({
            x: 40, y: 100, left: 40, right: 300, top: 100, bottom: 128, width: 260, height: 28, toJSON() {},
        });

        source.dispatchEvent(new env.win.MouseEvent("mousedown", {
            bubbles: true, button: 0, clientX: 60, clientY: 50,
        }));
        target.dispatchEvent(new env.win.MouseEvent("mousemove", {
            bubbles: true, clientX: 80, clientY: 114,
        }));
        assert.equal(target.classList.contains("dragover"), true);
        env.win.document.dispatchEvent(new env.win.MouseEvent("mouseup", { bubbles: true }));

        assert.deepEqual(env.transactions, [{
            operations: [{ action: "moveOutlineHeading", id: "h2", previousID: "h6", parentID: "h3" }],
            undoOperations: [{ action: "moveOutlineHeading", id: "h2", previousID: "h1" }],
        }]);
        assert.equal(env.panel.querySelector(".list-outline-floating__body")?.getAttribute("data-loading"), "true");
        source.click();
        assert.equal(env.navigations.length, 0);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强拖动列表项后提交可撤销的缩进事务", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div class="list" data-type="NodeList" data-subtype="u" data-node-id="root-list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph"><div contenteditable="true">第一项</div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="two"><div data-type="NodeParagraph"><div contenteditable="true">第二项</div></div></div>' +
        '<div class="protyle-attr"></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ headingListDepth: 2 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const source = env.panel.querySelector<HTMLButtonElement>('button[data-id="two"]')!;
        const target = env.panel.querySelector<HTMLButtonElement>('button[data-id="one"]')!;
        const originalRootHTML = env.editors[0].content.querySelector('[data-node-id="root-list"]')!.outerHTML;
        assert.equal(source.dataset.draggableOutline, "list");
        target.getBoundingClientRect = () => ({
            x: 40, y: 100, left: 40, right: 300, top: 100, bottom: 128, width: 260, height: 28, toJSON() {},
        });

        source.dispatchEvent(new env.win.MouseEvent("mousedown", {
            bubbles: true, button: 0, clientX: 60, clientY: 50,
        }));
        target.dispatchEvent(new env.win.MouseEvent("mousemove", {
            bubbles: true, clientX: 80, clientY: 114,
        }));
        env.win.document.dispatchEvent(new env.win.MouseEvent("mouseup", { bubbles: true }));

        assert.equal(env.transactions.length, 1);
        assert.equal(env.transactions[0].operations[0].action, "update");
        assert.equal(env.transactions[0].operations[0].id, "root-list");
        const updated = new env.win.DOMParser().parseFromString(
            env.transactions[0].operations[0].data, "text/html"
        );
        const nested = updated.querySelector('[data-node-id="one"] > [data-type="NodeList"]')!;
        assert.equal((nested as HTMLElement).dataset.nodeId, "new-child-list");
        assert.equal(nested.querySelector('[data-node-id="two"]') !== null, true);
        assert.equal(env.transactions[0].undoOperations[0].data, originalRootHTML);
        assert.ok(env.editors[0].content.querySelector(
            '[data-node-id="one"] > [data-node-id="new-child-list"] > [data-node-id="two"]'
        ));
    } finally { env.cleanup(); }
});

test("悬浮大纲增强用箭头折叠和展开标题后代，且不触发定位", async () => {
    const env = setup();
    try {
        await settle();
        const visibleIds = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        let toggle = env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="h1"]')!;
        assert.ok(toggle);
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconDown");

        toggle.click();
        assert.deepEqual(visibleIds(), ["h1", "h2"]);
        assert.equal(env.navigations.length, 0);
        toggle = env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="h1"]')!;
        assert.equal(toggle.getAttribute("aria-expanded"), "false");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconRight");

        toggle.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);
        assert.equal(env.panel.querySelector('[data-outline-toggle="h6"]'), null);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强支持分别折叠段落和列表项的子项", async () => {
    const headings = [
        { id: "h1", name: "章节一", subType: "h1" },
        { id: "h2", name: "章节二", subType: "h2" },
    ];
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
        listRoot(listDOM("one", "第一项", listRoot(listDOM("two", "子项"))) + listDOM("three", "同级项")) +
        '<div data-type="NodeHeading" data-node-id="h2"></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : headings);
    try {
        env.setSettings({ headingListDepth: 3 });
        await settle();
        const visibleIds = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);

        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "three", "h2"]);

        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="list-parent"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "h2"]);

        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="list-parent"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "three", "h2"]);

        env.panel.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "two", "three", "h2"]);
    } finally { env.cleanup(); }
});

test("读取原生 name/blocks/content/children 树，跳级标题按真实父子层级缩进", () => {
    const env = setup();
    try {
        assert.deepEqual(flattenHeadingTree(tree), [
            { id: "h1", text: "1. 一级标题", inlineHTML: "<span>1. </span><strong>一级标题</strong>", depth: 1, level: 1 },
            { id: "h3", text: "三级标题", depth: 2, level: 3 },
            { id: "h6", text: "六级标题", depth: 3, level: 6 },
            { id: "h2", text: "第二章", depth: 1, level: 2 },
        ]);
        assert.deepEqual(flattenHeadingTree(null), []);
    } finally { env.cleanup(); }
});

test("标题 HTML 保留行内结构，搜索文本保留转义字符与图片说明", () => {
    const env = setup();
    try {
        assert.equal(flattenHeadingTree([{ id: "safe", name: '<script>alert(1)</script>&lt;img&gt;<img alt="图片">' }])[0].text, "<img>图片");
        assert.equal(flattenHeadingTree([{ id: "plain", name: "a<b", nameIsHTML: false }])[0].text, "a<b");
        assert.equal(flattenHeadingTree([{ id: "empty", name: "块命名", content: "", subType: "h3" }])[0].text, "（空标题）");
        assert.equal(flattenHeadingTree([{ id: "rich", name: "", nameIsHTML: false, content: "<strong>三级标题</strong>", subType: "h3" }])[0].text, "三级标题");
    } finally { env.cleanup(); }
});

test("使用文档 ID 请求完整大纲，悬停展开，折叠标题使用原生折叠检查后导航", async () => {
    const env = setup();
    try {
        await settle();
        assert.deepEqual(env.calls[0], { url: "/api/outline/getDocOutline", data: { id: "doc1", preview: false, notebook: "notebook1" } });
        assert.equal(env.panel.querySelectorAll('.list-outline-floating__item').length, 4);
        assert.equal(env.panel.querySelector('[data-id="h3"] .list-outline-floating__text')?.textContent, "三级标题");
        assert.equal(env.panel.style.width, "48px");
        assert.equal(env.panel.style.left, "698px");
        assert.equal(env.panel.classList.contains("heading-outline-floating--icon"), false);
        const locate = env.panel.querySelector<HTMLButtonElement>('button[aria-label="定位当前位置"]')!;
        const refresh = env.panel.querySelector<HTMLButtonElement>('button[aria-label="刷新大纲增强"]')!;
        const close = env.panel.querySelector<HTMLButtonElement>('.heading-outline-floating__action[aria-label="关闭大纲增强"]')!;
        assert.equal(locate.textContent, "");
        assert.equal(locate.querySelector("use")?.getAttribute("href"), "#iconFocus");
        assert.equal(refresh.textContent, "");
        assert.equal(refresh.querySelector("use")?.getAttribute("href"), "#iconRefresh");
        assert.equal(close.textContent, "");
        assert.equal(close.querySelector("use")?.getAttribute("href"), "#iconClose");
        let scrollCount = 0;
        env.panel.querySelectorAll<HTMLElement>("button[data-id]").forEach(row => {
            row.scrollIntoView = () => { scrollCount++; };
        });
        assert.equal(scrollCount, 0);
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerenter"));
        assert.equal(scrollCount, 1);
        assert.equal(env.panel.style.width, "300px");
        close.click();
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);
        assert.equal(env.panel.style.width, "48px");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerenter"));
        env.panel.querySelector<HTMLButtonElement>('[data-id="h6"]')!.click();
        await settle();
        assert.deepEqual(env.navigations, [{ id: "h6", folded: true }]);
        assert.equal(env.calls.at(-1)?.url, "/api/block/checkBlockFold");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerleave"));
        assert.equal(env.panel.style.width, "48px");
        assert.equal(scrollCount, 2);
    } finally { env.cleanup(); }
});

test("悬浮大纲增强跟随鼠标所在块高亮，定位当前块后同步不会回跳", async () => {
    const env = setup();
    try {
        await settle();
        env.editors[0].content.innerHTML = [
            '<div data-type="NodeHeading" data-node-id="h1"><div contenteditable="true">一级标题</div></div>',
            '<div data-type="NodeHeading" data-node-id="h3"><div contenteditable="true">三级标题</div></div>',
            '<div data-type="NodeHeading" data-node-id="h6"><div contenteditable="true">六级标题</div></div>',
            '<div data-type="NodeHeading" data-node-id="h2"><div contenteditable="true">第二章</div></div>',
        ].join("");
        const h3 = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="h3"] [contenteditable="true"]')!;
        h3.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "h3");
        env.controller.syncEditors();
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "h3");

        const h6 = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="h6"] [contenteditable="true"]')!;
        const selection = env.win.document.getSelection()!;
        const range = env.win.document.createRange();
        range.selectNodeContents(h6);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        let autoScrolledId = "";
        env.panel.querySelectorAll<HTMLElement>("button[data-id]").forEach(row => {
            row.scrollIntoView = () => { autoScrolledId = row.dataset.id || ""; };
        });
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerenter"));
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "h6");
        assert.equal(autoScrolledId, "h6");

        const h3Range = env.win.document.createRange();
        h3Range.selectNodeContents(h3);
        h3Range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(h3Range);
        env.panel.querySelector<HTMLButtonElement>('button[aria-label="定位当前位置"]')!.click();
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "h3");
        env.controller.syncEditors();
        assert.equal(env.panel.querySelector(".list-outline-floating__current")?.getAttribute("data-id"), "h3");
    } finally { env.cleanup(); }
});

test("电脑端悬浮大纲增强支持在线切换省略列表型与图标型", async () => {
    const env = setup();
    try {
        await settle();
        env.setSettings({ headingOutlineDisplayMode: "icon" });
        await settle();
        assert.equal(env.panel.classList.contains("heading-outline-floating--icon"), true);
        assert.equal(env.panel.style.width, "52px");
        const toggle = env.panel.querySelector<HTMLButtonElement>(".heading-outline-floating__toggle")!;
        assert.equal(toggle.hidden, false);
        toggle.click();
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), true);
        assert.equal(env.panel.style.width, "300px");
        assert.equal(toggle.hidden, true);
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerleave"));
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);
        env.setSettings({ headingOutlineDisplayMode: "compact" });
        assert.equal(env.panel.classList.contains("heading-outline-floating--icon"), false);
        assert.ok(env.panel.querySelector(".list-outline-floating__line"));
    } finally { env.cleanup(); }
});

test("移动端悬浮大纲增强显示为按钮，点击后展开并可再次收起", async () => {
    const env = setup(undefined, true);
    try {
        await settle();
        const toggle = env.panel.querySelector<HTMLButtonElement>(".heading-outline-floating__toggle")!;
        assert.ok(toggle);
        assert.equal(toggle.getAttribute("aria-label"), "打开大纲增强");
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);
        assert.equal(env.panel.style.width, "52px");
        assert.equal(env.panel.style.top, "52px");
        assert.equal(env.panel.style.bottom, "auto");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconListOutlineHeadingDock");

        const breadcrumb = env.win.document.createElement("div");
        breadcrumb.className = "protyle-breadcrumb";
        breadcrumb.getBoundingClientRect = () => ({
            x: 40, y: 80, left: 40, right: 800, top: 80, bottom: 122, width: 760, height: 42, toJSON() {},
        });
        env.editors[0].element.insertBefore(breadcrumb, env.editors[0].element.firstChild);
        env.controller.syncEditors();
        assert.equal(env.panel.style.top, "130px");

        // 移动端没有悬停展开语义，入口必须由点击触发展开。
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerenter"));
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);

        toggle.click();
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(toggle.getAttribute("aria-label"), "关闭大纲增强");
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), true);
        assert.equal(env.panel.style.width, "320px");
        assert.equal(toggle.hidden, true);
        assert.equal(env.panel.querySelectorAll('.list-outline-floating__item').length, 4);

        const close = env.panel.querySelector<HTMLButtonElement>('.heading-outline-floating__action[aria-label="关闭大纲增强"]')!;
        assert.equal(close.querySelector("use")?.getAttribute("href"), "#iconClose");
        close.click();
        assert.equal(toggle.getAttribute("aria-expanded"), "false");
        assert.equal(toggle.hidden, false);
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);
        assert.equal(env.panel.style.width, "52px");
    } finally { env.cleanup(); }
});

test("复用编辑器切换文档时丢弃旧请求，空文档隐藏目录", async () => {
    let resolveOld: (value: any) => void = () => {};
    const env = setup(async (_url, data) => data.id === "doc1" ? new Promise(resolve => { resolveOld = resolve; }) : []);
    try {
        env.editors[0] = { ...env.editors[0], rootID: "doc2" };
        env.controller.syncEditors();
        await settle();
        resolveOld(tree);
        await settle();
        assert.equal(env.panel.hidden, true);
        assert.equal(env.panel.querySelectorAll('[data-id]').length, 0);
    } finally { env.cleanup(); }
});

test("标题修改后刷新，卸载时移除目录并阻止待处理请求复活", async () => {
    const env = setup();
    try {
        await settle();
        env.editors[0].content.querySelector('[contenteditable]')!.textContent = "新的标题";
        await new Promise(resolve => setTimeout(resolve, 680));
        assert.ok(env.calls.filter(call => call.url.endsWith("getDocOutline")).length >= 2);
        env.controller.scheduleRefresh();
        const count = env.calls.length;
        env.controller.destroy();
        await new Promise(resolve => setTimeout(resolve, 650));
        assert.equal(env.calls.length, count);
        assert.equal(env.win.document.querySelector('.heading-outline-floating'), null);
    } finally { env.cleanup(); }
});

test("导出预览混合大纲保留文档标题首位，开头列表归入文档标题且不重复标题", () => {
    const env = setup();
    try {
        const headings = flattenHeadingTree([{ id: "doc1", name: "文档标题", subType: "h1", blocks: [
            { id: "body", content: "正文标题", subType: "h2" },
        ] }]);
        const snapshot = listRoot(listDOM("intro", "开头列表")) +
            '<div data-type="NodeHeading" data-node-id="body"></div>';
        const entries = includeListsInHeadingTree(headings, snapshot, 2, null, "doc1");
        assert.deepEqual(entries.map(({ id, depth }) => ({ id, depth })), [
            { id: "doc1", depth: 1 }, { id: "intro", depth: 2 }, { id: "body", depth: 2 },
        ]);
        assert.deepEqual(includeListsInHeadingTree(headings,
            '<div data-type="NodeHeading" data-node-id="doc1"></div>' + snapshot, 2, null, "doc1"), entries);
        assert.deepEqual(includeListsInHeadingTree(headings.slice(1), snapshot, 2, null, "doc1")
            .map(entry => entry.id), ["intro", "body"]);
        assert.deepEqual(includeListsInHeadingTree(headings.slice(0, 1), "", 2, null, "doc1"), headings.slice(0, 1));
    } finally { env.cleanup(); }
});

test("悬浮大纲增强：导出预览文档标题保持首位，折叠标题可收起正文并支持定位", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="body-one"></div>' +
        '<div data-type="NodeHeading" data-node-id="body-two"></div>' + listRoot(listDOM("item", "列表"));
    const previewTree = [{ id: "doc1", name: "文档标题", subType: "h1", blocks: [
        { id: "body-one", content: "正文一", subType: "h2" },
        { id: "body-two", content: "正文二", subType: "h2" },
    ] }];
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : previewTree);
    try {
        env.editors[0] = { ...env.editors[0], preview: true };
        env.editors[0].content.innerHTML = '<h1 id="doc1">文档标题</h1>' +
            '<h2 id="body-one">正文一</h2><h2 id="body-two">正文二</h2>';
        env.controller.syncEditors();
        await settle();
        const ids = () => Array.from(env.panel.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        assert.deepEqual(ids(), ["doc1", "body-one", "body-two"]);
        env.panel.querySelector<HTMLButtonElement>('[data-outline-toggle="doc1"]')!.click();
        assert.deepEqual(ids(), ["doc1"]);
        env.panel.querySelector<HTMLButtonElement>('[data-outline-toggle="doc1"]')!.click();
        let scrolled = false;
        env.editors[0].content.querySelector<HTMLElement>("h1")!.scrollIntoView = () => { scrolled = true; };
        env.panel.querySelector<HTMLButtonElement>('[data-id="doc1"]')!.click();
        assert.equal(scrolled, true);
        assert.equal(env.navigations.length, 0);
    } finally { env.cleanup(); }
});

test("预览模式直接定位预览标题，关闭编辑器后隐藏目录", async () => {
    const env = setup();
    try {
        env.editors[0] = { ...env.editors[0], preview: true };
        env.editors[0].content.innerHTML = '<h1 id="h1">标题</h1>';
        let scrolled = false;
        env.editors[0].content.querySelector<HTMLElement>('h1')!.scrollIntoView = () => { scrolled = true; };
        env.controller.syncEditors();
        await settle();
        env.panel.querySelector<HTMLButtonElement>('[data-id="h1"]')!.click();
        assert.equal(scrolled, true);
        assert.equal(env.navigations.length, 0);
        env.editors[0].element.remove();
        env.controller.syncEditors();
        assert.equal(env.panel.hidden, true);
    } finally { env.cleanup(); }
});

test("大纲增强右键打开菜单时离开大纲不收起，菜单关闭后恢复收起", async () => {
    const env = setup();
    try {
        let closeMenu: () => void = () => {};
        const openInsertMenu = (event: any, target: any, onInserted: any, onClose?: () => void) => {
            event.preventDefault();
            closeMenu = onClose || (() => {});
        };
        (env.controller as any).options.openInsertMenu = openInsertMenu;
        await settle();
        assert.equal(env.panel.hidden, false);
        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        env.panel.querySelector('[data-id="h1"] span')!.dispatchEvent(event);
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), true);

        env.panel.dispatchEvent(new env.win.MouseEvent("pointerleave", { bubbles: true }));
        env.panel.dispatchEvent(new env.win.FocusEvent("focusout", { bubbles: true }));
        await settle();
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), true);

        closeMenu();
        await settle();
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);
    } finally { env.cleanup(); }
});
