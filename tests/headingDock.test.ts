import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { HeadingOutlineDockView } from "../src/headingDock";
import type { HeadingEditor } from "../src/headingOutline";
import { createHeadingMovePlan, createListItemMovePlan } from "../src/headingDrag";

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

    const calls: { url: string; data: Record<string, unknown> }[] = [];
    const navigations: { id: string; folded: boolean }[] = [];
    const transactions: any[] = [];
    const editors: HeadingEditor[] = [{
        element: win.document.querySelector('.protyle')!,
        content: win.document.querySelector('.protyle-wysiwyg')!,
        rootID: "doc1",
        notebook: "notebook1",
        preview: false,
        transaction: (operations, undoOperations) => transactions.push({ operations, undoOperations }),
    }];
    if (!withEditor) editors.length = 0;
    const menus: any[] = [];
    const levelMenus: { currentLevel: number; selectLevel(level: number): void }[] = [];
    let settings = normalizeSettings({ enableHeadingDock: true, ...initialSettings });
    const foldStates: Record<string, { collapsedIds: string[]; showLists: boolean; expandedListIds?: string[];
        expandedTabIds?: string[] }> = {};

    const container = win.document.createElement("div");
    win.document.body.append(container);

    const dock = new HeadingOutlineDockView(container, {
        getEditors: () => editors,
        getSettings: () => settings,
        setListDepth: async depth => { settings = { ...settings, headingListDepth: depth }; },
        setKeepCurrentHeadingExpanded: async enabled => {
            settings = { ...settings, keepCurrentHeadingExpanded: enabled };
            dock.refreshSettings();
        },
        getFoldState: documentId => foldStates[documentId],
        saveFoldState: async (documentId, state) => { foldStates[documentId] = state; },
        request: async (url, data) => {
            calls.push({ url, data });
            return request ? request(url, data) : url.endsWith("checkBlockFold") ? { isFolded: true } : tree;
        },
        navigate: (id, folded) => navigations.push({ id, folded }),
        reportError: () => {},
        openInsertMenu: (event, target) => { event.preventDefault(); menus.push(target); },
        openHeadingLevelMenu: (_target, currentLevel, selectLevel) => levelMenus.push({ currentLevel, selectLevel }),
        isMobile: () => mobile,
        newNodeID: () => "new-child-list",
    });

    return {
        win, editors, calls, navigations, transactions, menus, levelMenus, dock, container, foldStates,
        setSettings: (value: Parameters<typeof normalizeSettings>[0]) => {
            settings = normalizeSettings(value);
            dock.refreshSettings();
        },
        cleanup: () => {
            dock.destroy();
            win.close();
        },
    };
}

test("大纲增强 Dock：没有可见编辑器时仍可正常挂载", () => {
    const env = setup(undefined, false, false);
    try {
        env.dock.syncEditors();
        assert.equal(env.container.querySelector(".heading-outline-dock__status")?.textContent, "暂无活动文档");
        assert.equal(env.container.querySelectorAll("button[data-id]").length, 0);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：导出预览文档标题保持首位，正文顺序和父子关系保持正确", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="body-one"></div>' +
        '<div data-type="NodeHeading" data-node-id="body-two"></div>';
    const previewTree = [{ id: "doc1", name: "文档标题", subType: "h1", blocks: [
        { id: "body-one", content: "正文一", subType: "h2" },
        { id: "body-two", content: "正文二", subType: "h2" },
    ] }];
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : previewTree);
    try {
        env.editors[0] = { ...env.editors[0], preview: true, documentTitle: "文档标题" };
        env.editors[0].content.innerHTML = '<h1 id="doc1">文档标题</h1>' +
            '<h2 id="body-one">正文一</h2><h2 id="body-two">正文二</h2>';
        env.dock.syncEditors();
        await settle();
        const ids = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        assert.deepEqual(ids(), ["doc1", "body-one", "body-two"]);
        env.container.querySelector<HTMLButtonElement>('[data-outline-toggle="doc1"]')!.click();
        assert.deepEqual(ids(), ["doc1"]);
        env.container.querySelector<HTMLButtonElement>('[data-outline-toggle="doc1"]')!.click();
        assert.deepEqual(ids(), ["doc1", "body-one", "body-two"]);
        let scrolled = false;
        env.editors[0].content.querySelector<HTMLElement>("h1")!.scrollIntoView = () => { scrolled = true; };
        env.container.querySelector<HTMLButtonElement>('[data-id="doc1"]')!.click();
        assert.equal(scrolled, true);
        assert.equal(env.navigations.length, 0);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：保留行内格式，跨格式搜索和点击仍定位标题", async () => {
    const env = setup(async url => url.endsWith("checkBlockFold") ? { isFolded: false } : [{
        id: "rich", subType: "h1", nameIsHTML: true, number: "1.",
        name: '<span data-type="strong em">粗体</span><span data-type="code">代码</span>&nbsp;&nbsp;' +
            '<span data-type="mark" style="color: red">标记</span>' +
            '<span data-type="sup">2</span><span data-type="inline-math" data-content="x^2"></span>',
    }]);
    try {
        await settle();
        const row = () => env.container.querySelector<HTMLButtonElement>('button[data-id="rich"]')!;
        assert.equal(row().querySelector('[data-type="strong em"]')?.textContent, "粗体");
        assert.equal(row().querySelector('[data-type="sup"]')?.textContent, "2");
        assert.equal(row().querySelector<HTMLElement>('[data-type="mark"]')?.style.color, "red");
        assert.equal(row().querySelector('[data-subtype="math"]')?.getAttribute("data-content"), "x^2");
        const search = env.container.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.value = "体代";
        search.dispatchEvent(new env.win.Event("input"));
        assert.equal(row().querySelector('[data-type="strong em"] .list-outline-floating__match')?.textContent, "体");
        assert.equal(row().querySelector('[data-type="code"] .list-outline-floating__match')?.textContent, "代");
        row().querySelector<HTMLElement>('[data-type="strong em"]')!.click();
        await settle();
        assert.deepEqual(env.navigations, [{ id: "rich", folded: false }]);
        search.value = "代码 标记";
        search.dispatchEvent(new env.win.Event("input"));
        assert.equal(row().querySelector('[data-type="code"] .list-outline-floating__match')?.textContent, "代码");
        assert.equal(row().querySelector('[data-type="mark"] .list-outline-floating__match')?.textContent, "标记");
        search.value = "x^2";
        search.dispatchEvent(new env.win.Event("input"));
        assert.ok(row().querySelector('[data-subtype="math"].list-outline-floating__match'));
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：行内展示移除可执行内容和编辑器跳转属性", async () => {
    const env = setup(async () => [{ id: "safe", nameIsHTML: true,
        name: '<script>alert(1)</script><span data-type="block-ref" data-id="other" onclick="alert(1)" ' +
            'contenteditable="true" style="color: red; position: fixed">引用</span>' +
            '<img src="javascript:alert(1)" onerror="alert(1)" alt="图片"><iframe src="https://example.com"></iframe>',
    }, { id: "plain", name: "<strong>字面内容</strong>", nameIsHTML: false }]);
    try {
        await settle();
        const label = env.container.querySelector<HTMLElement>('[data-id="safe"] .heading-outline-dock__text')!;
        assert.equal(label.querySelector("script,iframe,[onclick],[onerror],[contenteditable],[data-id]"), null);
        assert.equal(label.querySelector("img")?.getAttribute("src"), null);
        const reference = label.querySelector<HTMLElement>('[data-type="block-ref"]')!;
        assert.equal(reference.style.color, "red");
        assert.equal(reference.style.position, "");
        const plain = env.container.querySelector('[data-id="plain"] .heading-outline-dock__text')!;
        assert.equal(plain.querySelector("strong"), null);
        assert.equal(plain.textContent, "<strong>字面内容</strong>");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：段落、列表及页签标题保留行内元素，不混入子项和页签正文", async () => {
    const paragraph = (id: string, html: string) => `<div data-type="NodeParagraph" data-node-id="${id}"><div contenteditable="true">${html}</div></div>`;
    const snapshot = paragraph("intro", '<span data-type="strong">段落说明</span>') +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="item">' +
        paragraph("item-content", '<span data-type="code">列表代码</span><span data-type="inline-math" data-content="a+b"><span>公式渲染副本</span></span>') +
        '<div data-type="NodeList" data-node-id="child-list"><div data-type="NodeListItem" data-node-id="child">' +
        paragraph("child-content", '<span data-type="em">列表子项</span>') + '</div></div></div></div>' +
        '<div data-type="NodeTabs" data-node-id="tabs"><div data-type="NodeTabItem" data-node-id="tab">' +
        '<div class="tab-item-info"><div tabs-title="true"><div class="tab-item-title" contenteditable="true">' +
        '<span data-type="mark">页签标题</span></div></div></div><div class="tab-item-content">' +
        paragraph("tab-body", "不应混入标题的正文") + '</div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : []);
    try {
        env.setSettings({ headingListDepth: 3 });
        await settle();
        const label = (id: string) => env.container.querySelector<HTMLElement>(`[data-id="${id}"] .heading-outline-dock__text`)!;
        assert.equal(label("intro").querySelector('[data-type="strong"]')?.textContent, "段落说明");
        assert.equal(label("item").querySelector('[data-type="code"]')?.textContent, "列表代码");
        assert.equal(label("item").querySelector('[data-subtype="math"]')?.getAttribute("data-content"), "a+b");
        assert.equal(label("item").textContent, "列表代码a+b");
        assert.equal(label("child").querySelector('[data-type="em"]')?.textContent, "列表子项");
        assert.equal(label("tab").querySelector('[data-type="mark"]')?.textContent, "页签标题");
        assert.equal(label("tab").textContent, "页签标题");
        const search = env.container.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.value = "页签";
        search.dispatchEvent(new env.win.Event("input"));
        assert.equal(label("tab").querySelector('[data-type="mark"] .list-outline-floating__match')?.textContent, "页签");
    } finally { env.cleanup(); }
});

test("标题拖动计划：支持同级排序、成为子标题并拒绝循环移动", () => {
    const entries = [
        { id: "h1", text: "一级", depth: 1, level: 1 },
        { id: "h3", text: "三级", depth: 2, level: 3 },
        { id: "h6", text: "六级", depth: 3, level: 6 },
        { id: "h2", text: "二级", depth: 1, level: 2 },
    ];
    assert.deepEqual(createHeadingMovePlan(entries, "h2", "h1", "before"), {
        operation: { action: "moveOutlineHeading", id: "h2" },
        undoOperation: { action: "moveOutlineHeading", id: "h2", previousID: "h1" },
    });
    assert.deepEqual(createHeadingMovePlan(entries, "h2", "h3", "inside"), {
        operation: { action: "moveOutlineHeading", id: "h2", previousID: "h6", parentID: "h3" },
        undoOperation: { action: "moveOutlineHeading", id: "h2", previousID: "h1" },
    });
    assert.deepEqual(createHeadingMovePlan(entries, "h3", "h2", "after"), {
        operation: { action: "moveOutlineHeading", id: "h3", previousID: "h2" },
        undoOperation: { action: "moveOutlineHeading", id: "h3", parentID: "h1" },
    });
    assert.equal(createHeadingMovePlan(entries, "h1", "h3", "inside"), null);
    assert.equal(createHeadingMovePlan(entries, "h6", "h3", "inside"), null);
});

test("列表项拖动计划：支持排序、缩进、取消缩进并拒绝循环移动", () => {
    const dom = new JSDOM('<div class="protyle-wysiwyg"><div class="list" data-type="NodeList" data-subtype="u" data-node-id="root-list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph">第一项</div>' +
        '<div class="list" data-type="NodeList" data-subtype="u" data-node-id="child-list">' +
        '<div data-type="NodeListItem" data-node-id="child-one"><div data-type="NodeParagraph">子项</div></div>' +
        '<div class="protyle-attr"></div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="two"><div data-type="NodeParagraph">第二项</div></div>' +
        '<div data-type="NodeListItem" data-node-id="three"><div data-type="NodeParagraph">第三项</div></div>' +
        '<div class="protyle-attr"></div></div></div>');
    const root = dom.window.document.querySelector(".protyle-wysiwyg")!;
    const directItemIDs = (list: Element) => Array.from(list.children)
        .filter(child => child.matches('[data-type="NodeListItem"]'))
        .map(item => (item as HTMLElement).dataset.nodeId);
    const updatedRoot = (data: string) => new dom.window.DOMParser().parseFromString(data, "text/html")
        .body.firstElementChild!;

    const reordered = createListItemMovePlan(root, "three", "one", "before", () => "unused")!;
    assert.deepEqual(directItemIDs(updatedRoot(reordered.operations[0].data)), ["three", "one", "two"]);
    assert.equal(reordered.undoOperations[0].data, root.firstElementChild!.outerHTML);

    const indented = createListItemMovePlan(root, "three", "one", "inside", () => "unused")!;
    const indentedRoot = updatedRoot(indented.operations[0].data);
    const childList = indentedRoot.querySelector('[data-node-id="one"] > [data-type="NodeList"]')!;
    assert.deepEqual(directItemIDs(childList), ["child-one", "three"]);

    const outdented = createListItemMovePlan(root, "child-one", "two", "after", () => "unused")!;
    const outdentedRoot = updatedRoot(outdented.operations[0].data);
    assert.deepEqual(directItemIDs(outdentedRoot), ["one", "two", "child-one", "three"]);
    assert.equal(outdentedRoot.querySelector('[data-node-id="child-list"]'), null);

    assert.equal(createListItemMovePlan(root, "one", "child-one", "inside", () => "unused"), null);
    dom.window.close();
});

test("列表项拖动计划：有序列表排序后保留原起始编号", () => {
    const dom = new JSDOM('<div><div data-type="NodeList" data-subtype="o" data-node-id="ordered">' +
        '<div data-type="NodeListItem" data-node-id="five" data-marker="5."></div>' +
        '<div data-type="NodeListItem" data-node-id="six" data-marker="6."></div>' +
        '<div data-type="NodeListItem" data-node-id="seven" data-marker="7."></div></div></div>');
    const root = dom.window.document.querySelector("div")!;
    const plan = createListItemMovePlan(root, "five", "seven", "after", () => "unused")!;
    const updated = new dom.window.DOMParser().parseFromString(plan.operations[0].data, "text/html");
    const items = Array.from(updated.querySelectorAll<HTMLElement>('[data-type="NodeListItem"]'));
    assert.deepEqual(items.map(item => item.dataset.nodeId), ["six", "seven", "five"]);
    assert.deepEqual(items.map(item => item.dataset.marker), ["5.", "6.", "7."]);
    dom.window.close();
});

test("大纲增强 Dock：拖到标题中部后提交成为子标题的可撤销事务", async () => {
    const env = setup();
    try {
        await settle();
        const source = env.container.querySelector<HTMLButtonElement>('button[data-id="h2"]')!;
        const target = env.container.querySelector<HTMLButtonElement>('button[data-id="h3"]')!;
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
        assert.equal(env.container.querySelector(".heading-outline-dock__body")?.getAttribute("data-loading"), "true");
        source.click();
        assert.equal(env.navigations.length, 0);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：列表项拖到另一项中部后提交缩进事务", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div class="list" data-type="NodeList" data-subtype="u" data-node-id="root-list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph"><div contenteditable="true">第一项</div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="two"><div data-type="NodeParagraph"><div contenteditable="true">第二项</div></div></div>' +
        '<div class="protyle-attr"></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ enableHeadingDock: true, headingListDepth: 2 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const source = env.container.querySelector<HTMLButtonElement>('button[data-id="two"]')!;
        const target = env.container.querySelector<HTMLButtonElement>('button[data-id="one"]')!;
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
        assert.equal(target.classList.contains("dragover"), true);
        env.win.document.dispatchEvent(new env.win.MouseEvent("mouseup", { bubbles: true }));

        assert.equal(env.transactions.length, 1);
        assert.equal(env.transactions[0].operations[0].action, "update");
        assert.equal(env.transactions[0].operations[0].id, "root-list");
        const updated = new env.win.DOMParser().parseFromString(
            env.transactions[0].operations[0].data, "text/html"
        );
        const nested = updated.querySelector('[data-node-id="one"] > [data-type="NodeList"]')!;
        assert.equal((nested as HTMLElement).dataset.nodeId, "new-child-list");
        assert.deepEqual(Array.from(nested.children)
            .filter(child => child.matches('[data-type="NodeListItem"]'))
            .map(item => (item as HTMLElement).dataset.nodeId), ["two"]);
        assert.equal(env.transactions[0].undoOperations[0].data, originalRootHTML);
        assert.ok(env.editors[0].content.querySelector(
            '[data-node-id="one"] > [data-node-id="new-child-list"] > [data-node-id="two"]'
        ));
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：关闭设置时不再显示禁用提示", async () => {
    const env = setup();
    try {
        await settle();
        let rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 4);
        assert.equal(env.container.querySelector(".heading-outline-dock__header .block__logo use"), null);

        // Dock 的注册/移除由插件生命周期处理，视图本身不再渲染“已禁用”提示。
        env.setSettings({ enableHeadingDock: false });
        await settle();
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        const status = env.container.querySelector<HTMLElement>(".heading-outline-dock__status")!;
        assert.equal(rows.length, 4);
        assert.equal(status.textContent?.includes("关闭"), false);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：搜索过滤、高亮匹配项及 Esc 清空", async () => {
    const env = setup();
    try {
        await settle();
        const searchInput = env.container.querySelector<HTMLInputElement>(".heading-outline-dock__search-input")!;
        assert.ok(searchInput);

        // 搜索 "三级"
        searchInput.value = "三级";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();

        let rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].dataset.id, "h3");
        const match = rows[0].querySelector<HTMLElement>(".list-outline-floating__match")!;
        assert.ok(match);
        assert.equal(match.textContent, "三级");

        // 搜索无匹配
        searchInput.value = "无结果关键词";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 0);
        const status = env.container.querySelector<HTMLElement>(".heading-outline-dock__status")!;
        assert.equal(status.textContent, "无匹配结果");

        // 按 Escape 清空
        searchInput.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        assert.equal(searchInput.value, "");
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 4);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：点击定位与右键菜单插入同级", async () => {
    const env = setup();
    try {
        await settle();
        const row = env.container.querySelector<HTMLButtonElement>('button[data-id="h3"]')!;
        assert.ok(row);

        // 点击定位
        row.click();
        await settle();
        assert.deepEqual(env.navigations.at(-1), { id: "h3", folded: true });

        // 右键插入菜单
        row.dispatchEvent(new env.win.MouseEvent("contextmenu", { bubbles: true }));
        assert.equal(env.menus.at(-1)?.id, "h3");
        assert.equal(env.menus.at(-1)?.kind, "heading");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：用箭头折叠和展开标题后代，搜索时仍可找到隐藏标题", async () => {
    const env = setup();
    try {
        await settle();
        const visibleIds = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        let toggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h3"]')!;
        assert.ok(toggle);
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconDown");

        toggle.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h2"]);
        assert.equal(env.navigations.length, 0);
        toggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h3"]')!;
        assert.equal(toggle.getAttribute("aria-expanded"), "false");
        assert.equal(toggle.querySelector("use")?.getAttribute("href"), "#iconRight");

        const searchInput = env.container.querySelector<HTMLInputElement>(".heading-outline-dock__search-input")!;
        searchInput.value = "六级";
        searchInput.dispatchEvent(new env.win.Event("input"));
        assert.deepEqual(visibleIds(), ["h6"]);
        assert.equal(env.container.querySelector("[data-outline-toggle]"), null);

        searchInput.value = "";
        searchInput.dispatchEvent(new env.win.Event("input"));
        toggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h3"]')!;
        toggle.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：支持全部折叠、全部展开和按实际标题级别展开", async () => {
    const env = setup();
    try {
        await settle();
        const visibleIds = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const toolbar = env.container.querySelector(".heading-outline-dock__header")!;

        const collapseAll = toolbar.querySelector<HTMLButtonElement>('button[data-action="collapse-all"]')!;
        const expandAll = toolbar.querySelector<HTMLButtonElement>('button[data-action="expand-all"]')!;
        const expandLevel = toolbar.querySelector<HTMLButtonElement>('button[data-action="expand-level"]')!;
        const minimize = toolbar.querySelector<HTMLButtonElement>('button[data-action="minimize"]')!;
        assert.equal(collapseAll.querySelector("use")?.getAttribute("href"), "#iconContract");
        assert.equal(expandAll.querySelector("use")?.getAttribute("href"), "#iconExpand");
        assert.equal(expandLevel.querySelector("use")?.getAttribute("href"), "#iconExpandLevel");
        assert.equal(minimize.querySelector("use")?.getAttribute("href"), "#iconMin");
        assert.equal(minimize.dataset.type, "min");
        let delegatedMinimizeClicks = 0;
        env.container.addEventListener("click", event => {
            if ((event.target as Element).closest('[data-type="min"]')) delegatedMinimizeClicks++;
        });
        minimize.click();
        assert.equal(delegatedMinimizeClicks, 1);

        collapseAll.click();
        assert.deepEqual(visibleIds(), ["h1", "h2"]);

        expandAll.click();
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);

        let expandLevelClickBubbled = false;
        const onDocumentClick = () => { expandLevelClickBubbled = true; };
        env.win.document.addEventListener("click", onDocumentClick);
        expandLevel.click();
        env.win.document.removeEventListener("click", onDocumentClick);
        assert.equal(expandLevelClickBubbled, false);
        assert.equal(env.levelMenus.at(-1)?.currentLevel, 6);
        env.levelMenus.at(-1)!.selectLevel(3);
        assert.deepEqual(visibleIds(), ["h1", "h3", "h2"]);

        expandLevel.click();
        assert.equal(env.levelMenus.at(-1)?.currentLevel, 3);
        env.levelMenus.at(-1)!.selectLevel(4);
        assert.deepEqual(visibleIds(), ["h1", "h3", "h6", "h2"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：默认只显示标题，单独展开标题可显示列表并记住状态", async () => {
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
        const ids = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        assert.deepEqual(ids(), ["h1", "h3", "h6", "h2"]);
        assert.equal(env.container.querySelector('[data-outline-toggle="h6"]')?.getAttribute("aria-expanded"), "false");
        assert.equal(env.foldStates.doc1, undefined);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h1"]')!.click();
        assert.deepEqual(ids(), ["h1", "h2"]);
        assert.deepEqual(env.foldStates.doc1.collapsedIds, ["h1"]);
        assert.equal(env.foldStates.doc1.showLists, false);

        env.editors[0] = { ...env.editors[0], rootID: "doc2" };
        env.dock.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "h3", "h6", "h2"]);
        env.editors[0] = { ...env.editors[0], rootID: "doc1" };
        env.dock.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "h2"]);

        const current = env.win.document.createElement("div");
        current.dataset.type = "NodeHeading";
        current.dataset.nodeId = "h6";
        env.editors[0].content.append(current);
        current.click();
        assert.deepEqual(ids(), ["h1", "h2"]);

        const keep = env.container.querySelector<HTMLButtonElement>('button[data-action="keep-current-expand"]')!;
        assert.equal(keep.getAttribute("aria-pressed"), "false");
        keep.click();
        await settle();
        assert.equal(keep.getAttribute("aria-pressed"), "true");
        assert.deepEqual(ids(), ["h1", "h3", "h6", "h2"]);
        assert.deepEqual(env.foldStates.doc1.collapsedIds, []);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h6"]')!.click();
        assert.deepEqual(ids(), ["h1", "h3", "h6", "item", "h2"]);
        assert.deepEqual(env.foldStates.doc1.expandedListIds, ["h6"]);
        assert.equal(env.foldStates.doc1.showLists, false);

        env.editors[0] = { ...env.editors[0], rootID: "doc2" };
        env.dock.syncEditors();
        await settle();
        env.editors[0] = { ...env.editors[0], rootID: "doc1" };
        env.dock.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "h3", "h6", "item", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-action="expand-all"]')!.click();
        assert.ok(ids().includes("item-two"));
        assert.equal(env.foldStates.doc1.showLists, true);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：移动端不显示最小化按钮", async () => {
    const env = setup(undefined, true);
    try {
        await settle();
        assert.equal(env.container.querySelector('button[data-action="minimize"]'), null);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：支持分别折叠段落和列表项的子项", async () => {
    const headings = [
        { id: "h1", name: "章节一", subType: "h1" },
        { id: "h2", name: "章节二", subType: "h2" },
    ];
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="one">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">第一项</div></div>' +
        '<div data-type="NodeList" data-node-id="child"><div data-type="NodeListItem" data-node-id="two">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">子项</div></div></div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="three"><div data-type="NodeParagraph">' +
        '<div contenteditable="true">同级项</div></div></div></div>' +
        '<div data-type="NodeHeading" data-node-id="h2"></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : headings);
    try {
        env.setSettings({ enableHeadingDock: true, headingListDepth: 3 });
        await settle();
        const visibleIds = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "three", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="list-parent"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="list-parent"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "three", "h2"]);

        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(visibleIds(), ["h1", "list-parent", "one", "two", "three", "h2"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：鼠标移入和编辑器滚动不更新高亮，点击块时才更新", async () => {
    const env = setup();
    try {
        await settle();
        assert.equal(env.container.querySelector('button[aria-label="定位当前位置"]'), null);
        const h1El = env.win.document.querySelector<HTMLElement>('[data-node-id="h1"]')!;
        h1El.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");

        const h3El = env.win.document.createElement("div");
        h3El.dataset.type = "NodeHeading";
        h3El.dataset.nodeId = "h3";
        h3El.innerHTML = '<div contenteditable="true">三级标题</div>';
        h3El.getBoundingClientRect = () => ({ ...h1El.getBoundingClientRect(), top: 200 });
        env.editors[0].content.append(h3El);
        let scrolled = false;
        env.container.querySelector<HTMLElement>('button[data-id="h3"]')!.scrollIntoView = () => { scrolled = true; };
        h3El.firstElementChild!.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        env.dock.syncEditors();
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");
        assert.equal(scrolled, false);
        h3El.getBoundingClientRect = () => ({ ...h1El.getBoundingClientRect(), top: 40 });
        env.editors[0].content.closest(".protyle-content")!
            .dispatchEvent(new env.win.Event("scroll", { bubbles: true }));
        await settle();
        env.dock.syncEditors();
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");

        h3El.firstElementChild!.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
        assert.equal(scrolled, true);
        env.editors[0].content.closest(".protyle-content")!
            .dispatchEvent(new env.win.Event("scroll", { bubbles: true }));
        await settle();
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");

        const paragraph = env.win.document.createElement("div");
        paragraph.dataset.type = "NodeParagraph";
        paragraph.innerHTML = '<div contenteditable="true">普通段落</div>';
        env.editors[0].content.append(paragraph);
        h1El.click();
        paragraph.firstElementChild!.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");
        paragraph.firstElementChild!.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：点击空列表项时直接高亮空列表项", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeList" data-node-id="list">' +
        '<div data-type="NodeListItem" data-node-id="filled"><div data-type="NodeParagraph" data-node-id="filled-p">' +
        '<div contenteditable="true">已有内容</div></div></div>' +
        '<div data-type="NodeListItem" data-node-id="empty"><div data-type="NodeParagraph" data-node-id="empty-p">' +
        '<div contenteditable="true"><br></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const emptyContent = env.editors[0].content.querySelector<HTMLElement>(
            '[data-node-id="empty"] [contenteditable="true"]'
        )!;

        emptyContent.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));

        const current = env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus");
        assert.equal(current?.dataset.id, "empty");
        assert.equal(current?.textContent, "（空列表项）");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：聚焦块不改变高亮，点击列表前的父级段落后才高亮该段落", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeParagraph" data-node-id="list-parent"><div contenteditable="true">列表说明</div></div>' +
        '<div data-type="NodeList" data-node-id="list">' +
        '<div data-type="NodeListItem" data-node-id="one"><div data-type="NodeParagraph">' +
        '<div contenteditable="true">第一项</div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree.slice(0, 1));
    try {
        env.editors[0].content.innerHTML = snapshot;
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await new Promise(resolve => setTimeout(resolve, 680));
        const content = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="list-parent"] [contenteditable="true"]')!;
        const initialId = env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id;

        content.dispatchEvent(new env.win.FocusEvent("focusin", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, initialId);
        content.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));

        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id,
            "list-parent");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：同步高亮不强制滚动列表到当前标题", async () => {
    const env = setup();
    try {
        await settle();
        const body = env.container.querySelector<HTMLElement>(".heading-outline-dock__body")!;
        const currentRow = env.container.querySelector<HTMLElement>('button[data-id="h1"]')!;
        let scrolled = false;
        currentRow.scrollIntoView = () => { scrolled = true; };
        body.scrollTop = 80;

        env.dock.syncEditors();

        assert.equal(scrolled, false);
        assert.equal(body.scrollTop, 80);
        assert.equal(currentRow.classList.contains("b3-list-item--focus"), true);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：列表下拉框选择不显示或具体显示层级", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="l1">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">一级列表</div></div>' +
        '<div data-type="NodeList" data-node-id="child"><div data-type="NodeListItem" data-node-id="l2">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">二级列表</div></div></div></div></div></div>' +
        '<div class="tabs" data-type="NodeTabs" data-node-id="tabs"><div class="tab-item" data-type="NodeTabItem" data-node-id="tab-one">' +
        '<div class="tab-item-info"><div data-type="NodeParagraph" tabs-title="true"><div class="tab-item-title" contenteditable="true">实验数据</div></div></div>' +
        '<div class="tab-item-content"><div data-type="NodeParagraph"><div contenteditable="true">正文不显示</div></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        await settle();
        const select = env.container.querySelector<HTMLSelectElement>('select[aria-label="大纲增强列表层级"]')!;
        assert.equal(select.value, "0");
        assert.equal(env.calls.some(call => call.url.endsWith("getBlockDOM")), false);

        select.value = "1";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.ok(env.container.querySelector('[data-id="l1"]'));
        assert.equal(env.container.querySelector('[data-id="l2"]'), null);
        const tabRow = env.container.querySelector<HTMLButtonElement>('[data-id="tab-one"]')!;
        assert.equal(tabRow.querySelector("use")?.getAttribute("href"), "#iconTabItem");
        assert.equal(tabRow.querySelector(".heading-outline-dock__text")?.textContent, "实验数据");

        env.editors[0].content.innerHTML = snapshot;
        const listContent = env.editors[0].content.querySelector('[data-node-id="l1"] [contenteditable]')!;
        listContent.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");
        listContent.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "l1");

        select.value = "0";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(env.container.querySelector('[data-id="l1"]'), null);
        assert.equal(env.container.querySelector('[data-id="tab-one"]'), null);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：页签标题默认折叠，可分别展开并记住状态", async () => {
    const tab = (id: string, item: string) => `<div data-type="NodeTabItem" data-node-id="${id}">` +
        `<div class="tab-item-info"><div class="tab-item-title" contenteditable="true">${id}</div></div>` +
        `<div class="tab-item-content"><div data-type="NodeList" data-node-id="${id}-list">` +
        `<div data-type="NodeListItem" data-node-id="${item}"><div data-type="NodeParagraph">` +
        `<div contenteditable="true">${item}</div></div></div></div></div></div>`;
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        `<div data-type="NodeTabs" data-node-id="tabs">${tab("tab-one", "item-one")}${tab("tab-two", "item-two")}</div>`;
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } :
        [{ id: "h1", name: "标题", subType: "h1" }], false, true, { headingListDepth: 2 });
    try {
        await settle();
        const ids = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const toggle = (id: string) => env.container.querySelector<HTMLButtonElement>(`button[data-outline-toggle="${id}"]`)!;
        assert.deepEqual(ids(), ["h1", "tab-one", "tab-two"]);
        assert.equal(toggle("tab-one").getAttribute("aria-expanded"), "false");
        assert.equal(toggle("tab-two").getAttribute("aria-expanded"), "false");

        toggle("tab-one").click();
        assert.deepEqual(ids(), ["h1", "tab-one", "item-one", "tab-two"]);
        assert.equal(toggle("tab-one").getAttribute("aria-expanded"), "true");
        assert.deepEqual(env.foldStates.doc1.expandedTabIds, ["tab-one"]);

        env.editors[0] = { ...env.editors[0], rootID: "doc2" };
        env.dock.syncEditors();
        await settle();
        env.editors[0] = { ...env.editors[0], rootID: "doc1" };
        env.dock.syncEditors();
        await settle();
        assert.deepEqual(ids(), ["h1", "tab-one", "item-one", "tab-two"]);

        toggle("tab-one").click();
        toggle("tab-two").click();
        assert.deepEqual(ids(), ["h1", "tab-one", "tab-two", "item-two"]);
        env.container.querySelector<HTMLButtonElement>('button[data-action="expand-all"]')!.click();
        assert.deepEqual(ids(), ["h1", "tab-one", "item-one", "tab-two", "item-two"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：保持当前层级展开时，点击编辑区列表会展开被隐藏的路径", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"><div contenteditable="true">标题</div></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="one">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">父项</div></div>' +
        '<div data-type="NodeList" data-node-id="child-list"><div data-type="NodeListItem" data-node-id="two">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">子项</div></div></div></div></div></div>' +
        '<div data-type="NodeTabs" data-node-id="tabs"><div data-type="NodeTabItem" data-node-id="tab-one">' +
        '<div class="tab-item-info"><div class="tab-item-title" contenteditable="true">页签</div></div>' +
        '<div class="tab-item-content"><div data-type="NodeList" data-node-id="tab-list">' +
        '<div data-type="NodeListItem" data-node-id="tab-item"><div data-type="NodeParagraph">' +
        '<div contenteditable="true">页签列表</div></div></div></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } :
        [{ id: "h1", name: "标题", subType: "h1" }], false, true, { headingListDepth: 3 });
    try {
        env.editors[0].content.innerHTML = snapshot;
        await new Promise(resolve => setTimeout(resolve, 680));
        const ids = () => Array.from(env.container.querySelectorAll<HTMLButtonElement>("button[data-id]"))
            .map(row => row.dataset.id);
        const clickEditor = (id: string) => env.editors[0].content.querySelector<HTMLElement>(`[data-node-id="${id}"] [contenteditable]`)!
            .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.deepEqual(ids(), ["h1", "tab-one"]);

        env.container.querySelector<HTMLButtonElement>('button[data-action="keep-current-expand"]')!.click();
        await settle();
        clickEditor("h1");
        const tabToggle = env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="tab-one"]');
        if (tabToggle?.getAttribute("aria-expanded") === "true") tabToggle.click();
        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="h1"]')!.click();
        assert.deepEqual(ids(), ["h1"]);
        clickEditor("two");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one"]);
        assert.equal(env.container.querySelector("button.b3-list-item--focus")?.getAttribute("data-id"), "two");

        clickEditor("h1");
        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(ids(), ["h1", "one", "tab-one"]);
        clickEditor("one");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one"]);
        clickEditor("h1");
        env.container.querySelector<HTMLButtonElement>('button[data-outline-toggle="one"]')!.click();
        assert.deepEqual(ids(), ["h1", "one", "tab-one"]);
        clickEditor("two");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one"]);

        clickEditor("h1");
        clickEditor("tab-item");
        assert.deepEqual(ids(), ["h1", "one", "two", "tab-one", "tab-item"]);
        assert.deepEqual(env.foldStates.doc1.expandedTabIds, ["tab-one"]);
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：纯图片列表项显示图片，alt 不作为可见文本", async () => {
    const snapshot = '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="image-only">' +
        '<div data-type="NodeParagraph"><div contenteditable="true"><span data-type="img" class="img">' +
        '<img src="assets/result.png" alt="不显示的文件名"></span></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        await settle();
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await settle();
        const row = env.container.querySelector<HTMLButtonElement>('button[data-id="image-only"]')!;
        assert.ok(row);
        assert.equal(row.querySelector("img")?.getAttribute("src"), "assets/result.png");
        assert.equal(row.querySelector(".heading-outline-dock__text")?.textContent, "");
    } finally { env.cleanup(); }
});

test("大纲增强 Dock：显示并定位嵌入块里的列表项", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-one"></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        env.editors[0].content.innerHTML = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
            '<div data-type="NodeBlockQueryEmbed" data-node-id="embed-one"><div class="protyle-wysiwyg__embed">' +
            '<div data-type="NodeList" data-node-id="embedded-list"><div data-type="NodeListItem" data-node-id="embedded-item">' +
            '<div data-type="NodeParagraph"><div contenteditable="true">嵌入列表项</div></div></div></div></div></div>';
        const target = env.editors[0].content.querySelector<HTMLElement>('[data-node-id="embedded-item"]')!;
        let scrolled = false;
        target.scrollIntoView = () => { scrolled = true; };
        env.setSettings({ enableHeadingDock: true, headingListDepth: 2 });
        await new Promise(resolve => setTimeout(resolve, 680));

        const row = env.container.querySelector<HTMLButtonElement>('[data-id="embedded-item"]')!;
        assert.ok(row);
        assert.equal(row.dataset.embedId, "embed-one");
        row.click();
        await settle();
        assert.equal(scrolled, true);
        assert.equal(env.navigations.length, 0);

        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        row.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(env.menus.length, 0);
    } finally { env.cleanup(); }
});
