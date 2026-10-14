import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { DocumentOutlineSettings, DOCUMENT_HIDE_COMPLETED_ATTRIBUTE as HIDE,
    DOCUMENT_LIST_DEPTH_ATTRIBUTE as DEPTH } from "../src/documentOutlineSettings";
import { HeadingOutlineDockView } from "../src/headingDock";
import { HeadingOutlineController, type HeadingEditor } from "../src/headingOutline";

const snapshot = '<div data-type="NodeHeading" data-node-id="heading"></div>' +
    '<div data-type="NodeList" data-node-id="list" data-subtype="t">' +
    '<div data-type="NodeListItem" data-node-id="done" data-task="X" data-subtype="t">' +
    '<div data-type="NodeParagraph"><div contenteditable="true">已完成</div></div>' +
    '<div data-type="NodeList" data-node-id="children" data-subtype="t">' +
    '<div data-type="NodeListItem" data-node-id="todo" data-task=" " data-subtype="t">' +
    '<div data-type="NodeParagraph"><div contenteditable="true">未完成子项</div></div>' +
    '</div></div></div></div>';

async function waitFor(condition: () => boolean) {
    const deadline = Date.now() + 2500;
    while (!condition()) {
        if (Date.now() > deadline) assert.fail("等待文档大纲刷新超时");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test("两个大纲共享文档属性，快捷设置只修改当前文档，切换文档和恢复全局正确", async () => {
    const dom = new JSDOM(`<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg">${snapshot}</div></div></div>`,
        { pretendToBeVisual: true });
    const win = dom.window;
    for (const key of ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver", "DOMParser"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true });
    }
    Object.assign(globalThis, { requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () =>
        ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });
    const editors: HeadingEditor[] = [{ element: win.document.querySelector(".protyle")!,
        content: win.document.querySelector(".protyle-wysiwyg")!, rootID: "first", preview: false }];
    let global = normalizeSettings();
    const attrs: Record<string, Record<string, string>> = { first: {}, second: {} };
    let pauseWrite: Promise<void> | undefined;
    const request = async (url: string, data: Record<string, any>) => {
        if (url.endsWith("getBlockAttrs")) return { ...attrs[data.id] };
        if (url.endsWith("setBlockAttrs")) {
            await pauseWrite;
            for (const [key, value] of Object.entries(data.attrs)) {
                if (value === "") delete attrs[data.id][key];
                else attrs[data.id][key] = String(value);
            }
        } else if (url.endsWith("getDocOutline")) return [{ id: "heading", name: "标题", subType: "h1" }];
        else return { dom: snapshot };
    };
    const store = new DocumentOutlineSettings(request, () => global);
    const views: (HeadingOutlineDockView | HeadingOutlineController)[] = [];
    const refresh = () => views.forEach(view => view.refreshSettings());
    const options = {
        getEditors: () => editors, getSettings: (id?: string) => store.get(id),
        loadDocumentSettings: (id: string) => store.load(id), hasDocumentOverrides: (id?: string) => store.hasOverrides(id),
        setListDepth: async (headingListDepth: number, id: string) => { await store.save(id, { headingListDepth }); refresh(); },
        setHideCompletedTasks: async (hideCompletedTasks: boolean, id: string) => { await store.save(id, { hideCompletedTasks }); refresh(); },
        resetDocumentSettings: async (id: string) => { await store.reset(id); refresh(); },
        request, navigate: () => {}, reportError: (message: string) => assert.fail(message),
        openHeadingLevelMenu: (_target: HTMLElement, _level: number, select: (level: number) => void) => select(6),
    };
    const container = win.document.createElement("div");
    win.document.body.append(container);
    const dock = new HeadingOutlineDockView(container, options);
    const heading = new HeadingOutlineController(options);
    views.push(dock, heading);
    const floating = win.document.querySelector<HTMLElement>(".heading-outline-floating")!;
    const open = (panel: HTMLElement) => {
        panel.querySelector<HTMLButtonElement>('[data-action="outline-settings"]')!.click();
        return {
            depth: win.document.querySelector<HTMLSelectElement>('select[aria-label="大纲增强列表层级"]')!,
            hide: win.document.querySelector<HTMLInputElement>('[aria-label="过滤已完成任务"]')!,
        };
    };
    try {
        await waitFor(() => !!container.querySelector('[data-id="heading"]') && !!floating.querySelector('[data-id="heading"]'));
        container.querySelector<HTMLButtonElement>('[data-action="expand-all"]')!.click();
        floating.querySelector<HTMLButtonElement>('[data-action="expand-level"]')!.click();
        let controls = open(container);
        controls.hide.click();
        await waitFor(() => !controls.hide.disabled && !container.querySelector('[data-id="done"]') && !floating.querySelector('[data-id="done"]'));
        assert.ok(container.querySelector('[data-id="todo"]'));
        assert.equal(global.hideCompletedTasks, false);
        assert.equal(attrs.first[HIDE], "true");
        controls.depth.value = "0";
        controls.depth.dispatchEvent(new win.Event("change"));
        await waitFor(() => !controls.depth.disabled && !container.querySelector('[data-id="todo"]') && !floating.querySelector('[data-id="todo"]'));
        assert.equal(global.headingListDepth, 2);
        editors[0] = { ...editors[0], rootID: "second" };
        views.forEach(view => view.syncEditors());
        await waitFor(() => !!container.querySelector('[data-id="heading"]') && !!floating.querySelector('[data-id="heading"]'));
        controls = open(floating);
        assert.equal(controls.depth.value, "2");
        assert.equal(controls.hide.checked, false);
        controls.depth.value = "1";
        controls.depth.dispatchEvent(new win.Event("change"));
        await waitFor(() => !controls.depth.disabled && attrs.second[DEPTH] === "1");
        assert.equal(floating.classList.contains("list-outline-floating--expanded"), true);
        controls.hide.click();
        await waitFor(() => !controls.hide.disabled);
        assert.equal(floating.classList.contains("list-outline-floating--expanded"), true);
        global = normalizeSettings({ headingListDepth: 4, hideCompletedTasks: false });
        refresh();
        assert.equal(controls.depth.value, "1");
        assert.equal(controls.hide.checked, true);
        win.document.querySelector<HTMLButtonElement>(".outline-quick-settings__reset")!.click();
        await waitFor(() => !controls.depth.disabled && controls.depth.value === "4");
        assert.deepEqual(attrs.second, {});
        assert.equal(controls.hide.checked, false);
        editors[0] = { ...editors[0], rootID: "first" };
        views.forEach(view => view.syncEditors());
        await waitFor(() => !!container.querySelector('[data-id="heading"]') && !!floating.querySelector('[data-id="heading"]'));
        controls = open(container);
        assert.equal(controls.depth.value, "0");
        assert.equal(controls.hide.checked, true);
        let resume!: () => void;
        pauseWrite = new Promise<void>(resolve => { resume = resolve; });
        controls.depth.value = "5";
        controls.depth.dispatchEvent(new win.Event("change"));
        editors[0] = { ...editors[0], rootID: "second" };
        views.forEach(view => view.syncEditors());
        resume();
        await waitFor(() => !controls.depth.disabled && attrs.first[DEPTH] === "5");
        assert.deepEqual(attrs.second, {});
        assert.equal(store.get("second").headingListDepth, 4);
    } finally { views.forEach(view => view.destroy()); win.close(); }
});
