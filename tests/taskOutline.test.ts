import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { extractOutline, filterCompletedTasks, type OutlineEntry } from "../src/outline";
import { createOutlineListMarker, createOutlineRow } from "../src/outlineView";
import { HeadingOutlineDockView } from "../src/headingDock";
import { HeadingOutlineController, type HeadingEditor } from "../src/headingOutline";
import { ListOutlineController } from "../src/listOutline";

const item = (id: string, subtype: string, attrs = "", children = "") =>
    `<div data-type="NodeListItem" data-node-id="${id}" data-subtype="${subtype}" ${attrs}>` +
    `<div data-type="NodeParagraph"><div contenteditable="true">${id}</div></div>${children}</div>`;
const list = (id: string, children: string, subtype = "u") =>
    `<div data-type="NodeList" data-node-id="${id}" data-subtype="${subtype}">${children}</div>`;
const snapshot = '<div data-type="NodeHeading" data-node-id="heading"></div>' + list("root",
    item("bullet", "u") + item("number", "o", 'data-marker="7)"') +
    item("done", "t", 'data-task="X"', list("children", item("child", "t", 'data-task=" "'))) +
    item("todo", "t", 'data-task=" "') + item("progress", "t", 'data-task="/"') +
    item("canceled", "t", 'data-task="-"') + item("custom", "t", 'data-task="?"'));

const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2500;
    while (!condition()) {
        if (Date.now() >= deadline) assert.fail("大纲未在期限内刷新");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

function setup(surface: "dock" | "heading" | "list") {
    const dom = new JSDOM('<div class="protyle"><div class="protyle-content">' +
        `<div class="protyle-wysiwyg">${snapshot}</div></div></div>`, { pretendToBeVisual: true });
    const win = dom.window;
    for (const key of ["window", "document", "Element", "Node", "HTMLElement", "DOMParser", "MutationObserver", "Option"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true });
    }
    Object.assign(globalThis, {
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
        ResizeObserver: class { observe() {} disconnect() {} },
    });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () =>
        ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });
    const editor: HeadingEditor = { element: win.document.querySelector(".protyle")!,
        content: win.document.querySelector(".protyle-wysiwyg")!, rootID: "doc", preview: false };
    let settings = normalizeSettings({ enableListOutline: true, headingListDepth: 3 });
    const options = {
        getEditors: () => [editor], getSettings: () => settings,
        request: async (url: string, data: Record<string, unknown>) => url.endsWith("getDocOutline")
            ? [{ id: "heading", name: "标题", subType: "h1" }]
            : url.endsWith("getBlockAttrs") ? {} : { dom: data.id === "doc" ? editor.content.innerHTML :
                editor.content.querySelector(`[data-node-id="${data.id}"]`)?.outerHTML },
        navigate: () => {}, reportError: () => {},
    };
    const container = win.document.createElement("div");
    win.document.body.append(container);
    const view = surface === "dock" ? new HeadingOutlineDockView(container, options) :
        surface === "heading" ? new HeadingOutlineController({ ...options,
            openHeadingLevelMenu: (_target, _level, select) => select(6) }) : new ListOutlineController(options);
    const panel = surface === "dock" ? container : win.document.querySelector<HTMLElement>(
        surface === "heading" ? ".heading-outline-floating" : '.list-outline-floating[data-list-id="root"]')!;
    const expand = () => {
        if (surface === "dock") panel.querySelector<HTMLButtonElement>('[data-action="expand-all"]')!.click();
        else if (surface === "heading") panel.querySelector<HTMLButtonElement>('[data-action="expand-level"]')!.click();
        else panel.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
    };
    return { win, editor, panel, expand,
        setHide: (hide: boolean) => { settings = normalizeSettings({ ...settings, hideCompletedTasks: hide }); view.refreshSettings(); },
        cleanup: () => { view.destroy(); win.close(); } };
}

test("列表类型与原始编号、全部任务状态从列表项提取，支持容器类型和旧版任务标记位置", () => {
    const document = new JSDOM(snapshot).window.document;
    const entries = extractOutline(document.querySelector<HTMLElement>('[data-node-id="root"]')!, 3);
    assert.equal(entries[0].listType, "unordered");
    assert.equal(entries[1].listType, "ordered");
    assert.equal(entries[1].listMarker, "7)");
    assert.deepEqual(entries.filter(entry => entry.listType === "task").map(entry => entry.taskMarker),
        ["X", " ", " ", "/", "-", "?"]);
    document.body.innerHTML = list("legacy", '<div data-type="NodeListItem" data-node-id="legacy-item">' +
        '<div class="protyle-action--task" data-task="x"></div><div contenteditable="true">旧任务</div></div>', "t");
    assert.equal(extractOutline(document.body.firstElementChild as HTMLElement, 1)[0].taskMarker, "x");
});

test("隐藏完成任务仅移除 X/x，保留未完成后代、其他任务状态、页签和原始编号", () => {
    const entries: OutlineEntry[] = [
        { id: "heading", text: "标题", depth: 1, kind: "heading" },
        { id: "done", text: "完成父项", depth: 2, listType: "task", taskMarker: "X" },
        { id: "done-child", text: "完成子项", depth: 3, listType: "task", taskMarker: "x" },
        { id: "todo", text: "未完成孙项", depth: 4, listType: "task", taskMarker: " " },
        { id: "tab", text: "页签", depth: 3, kind: "tab" },
        { id: "number", text: "编号", depth: 4, listType: "ordered", listMarker: "8." },
        ...["/", "-", "?"].map((taskMarker, index) => ({ id: `status-${index}`, text: "状态", depth: 2,
            listType: "task" as const, taskMarker })),
    ];
    assert.equal(filterCompletedTasks(entries, false), entries);
    const filtered = filterCompletedTasks(entries, true);
    assert.deepEqual(filtered.map(entry => [entry.id, entry.depth]),
        [["heading", 1], ["todo", 2], ["tab", 2], ["number", 3], ["status-0", 2], ["status-1", 2], ["status-2", 2]]);
    assert.equal(filtered.find(entry => entry.id === "number")?.listMarker, "8.");
    assert.equal(entries[3].depth, 4);
    assert.equal(normalizeSettings().hideCompletedTasks, false);
    assert.equal(normalizeSettings(JSON.parse(JSON.stringify(normalizeSettings({ hideCompletedTasks: true })))).hideCompletedTasks, true);
    assert.equal(normalizeSettings({ hideCompletedTasks: "true" as any }).hideCompletedTasks, false);
});

test("任务状态标记包含无障碍说明，自定义字符通过文本安全显示", () => {
    const env = setup("dock");
    try {
        const row = createOutlineRow({ id: "task", text: "正文", depth: 1, listType: "task", taskMarker: "/" });
        assert.equal(row.querySelector(".outline-entry__marker")?.textContent, "◩");
        assert.match(row.getAttribute("aria-label")!, /进行中/);
        const marker = createOutlineListMarker({ id: "custom", text: "正文", depth: 1, listType: "task", taskMarker: "<" })!;
        assert.equal(marker.textContent, "[<]");
        assert.equal(marker.children.length, 0);
    } finally { env.cleanup(); }
});

for (const surface of ["dock", "heading", "list"] as const) {
    test(`${surface} 大纲区分列表类型，设置切换与正文任务状态变化自动刷新`, async () => {
        const env = setup(surface);
        try {
            await waitFor(() => !!env.panel.querySelector('[data-id="heading"], [data-id="bullet"]'));
            env.expand();
            await waitFor(() => !!env.panel.querySelector('[data-id="done"]'));
            const marker = (id: string) => env.panel.querySelector(`[data-id="${id}"] .outline-entry__marker`);
            assert.equal(marker("bullet")?.textContent, "•");
            assert.equal(marker("number")?.textContent, "7)");
            assert.equal(marker("todo")?.textContent, "☐");
            assert.equal(marker("done")?.textContent, "☑");
            assert.equal(marker("canceled")?.textContent, "⊠");
            assert.equal(marker("custom")?.textContent, "[?]");
            env.setHide(true);
            await waitFor(() => !env.panel.querySelector('[data-id="done"]'));
            assert.ok(env.panel.querySelector('[data-id="child"]'));
            assert.ok(env.panel.querySelector('[data-id="canceled"]'));
            assert.equal(marker("number")?.textContent, "7)");

            // 仅修改属性：验证监听 data-task，不依赖正文文本或子节点变化。
            const todo = env.editor.content.querySelector<HTMLElement>('[data-node-id="todo"]')!;
            todo.dataset.task = "x";
            await waitFor(() => !env.panel.querySelector('[data-id="todo"]'));
            todo.dataset.task = "/";
            await waitFor(() => marker("todo")?.textContent === "◩");
            assert.match(env.panel.querySelector('[data-id="todo"]')!.getAttribute("aria-label")!, /进行中/);
            env.setHide(false);
            await waitFor(() => !!env.panel.querySelector('[data-id="done"]'));
        } finally { env.cleanup(); }
    });
}
