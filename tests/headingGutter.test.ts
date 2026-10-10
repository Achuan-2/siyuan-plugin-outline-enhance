import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { IProtyle } from "siyuan";
import { HeadingGutterController } from "../src/headingGutter";
import { normalizeSettings } from "../src/defaultSettings";

const settle = () => new Promise(resolve => setTimeout(resolve, 40));

function setup(legacy = false) {
    const dom = new JSDOM(`<div class="protyle"><div class="protyle-gutters fn__none"></div>
        <div class="protyle-content"><div class="protyle-wysiwyg">
        <div data-type="NodeHeading" data-subtype="h2" data-node-id="heading"><div contenteditable="true">标题</div></div>
        </div></div><div class="protyle-preview fn__none"></div></div>`, { pretendToBeVisual: true });
    const win = dom.window;
    for (const name of ["window", "document", "Element", "HTMLElement", "MutationObserver", "MouseEvent"]) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true,
            value: name === "window" ? win : (win as any)[name] });
    }
    Object.assign(globalThis, { requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win), getComputedStyle: win.getComputedStyle.bind(win) });
    (win as any).siyuan = { config: { editor: { fontSize: 16 } } };
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = function () {
        const heading = this.dataset.type === "NodeHeading";
        const left = heading ? 100 : 0;
        const top = heading ? 80 : 0;
        const height = heading ? 50 : 500;
        return { x: left, y: top, left, top, right: 600, bottom: top + height, width: 600 - left,
            height, toJSON() {} };
    };
    Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 38; } });
    Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 34; } });
    const element = win.document.querySelector<HTMLElement>(".protyle")!;
    const heading = element.querySelector<HTMLElement>('[data-type="NodeHeading"]')!;
    const native = element.querySelector<HTMLElement>(".protyle-gutters")!;
    const calls: { type: string; action: string | null; alt: boolean }[] = [];
    native.addEventListener("click", event => {
        const button = (event.target as Element).closest("button")!;
        calls.push({ type: event.type, action: button.getAttribute("data-type"), alt: (event as MouseEvent).altKey });
        if (button.dataset.type === "fold") heading.setAttribute("fold", heading.getAttribute("fold") === "1" ? "0" : "1");
    });
    native.addEventListener("contextmenu", event => calls.push({ type: event.type,
        action: (event.target as HTMLElement).dataset.type || null, alt: false }));
    const render = (_protyle: IProtyle, target: Element) => {
        assert.equal(target, heading);
        native.classList.remove("fn__none");
        native.innerHTML = '<button data-type="NodeHeading" data-node-id="heading"></button><button data-type="fold"></button>';
    };
    const protyle = { element, options: {}, disabled: false, gutter: { element: native,
        render: legacy ? function (editor: IProtyle, target: Element, content: HTMLElement, _target: Element) {
            assert.equal(content, protyle.wysiwyg.element);
            render(editor, target);
        } : render }, wysiwyg: { element: element.querySelector(".protyle-wysiwyg")! },
        contentElement: element.querySelector(".protyle-content")!,
        preview: { element: element.querySelector(".protyle-preview")! } } as unknown as IProtyle;
    const editors = [protyle];
    const controller = new HeadingGutterController({ getEditors: () => editors });
    return { win, element, heading, native, calls, protyle, editors, controller,
        row: () => element.querySelector<HTMLElement>(".heading-gutter-persistent")!,
        cleanup() { controller.destroy(); win.close(); } };
}

test("标题块标开关默认关闭，保存值和旧设置归一化", () => {
    assert.equal(normalizeSettings().enableHeadingGutters, false);
    assert.equal(normalizeSettings({ enableHeadingGutters: true }).enableHeadingGutters, true);
    assert.equal(normalizeSettings({ enableHeadingGutters: "true" as any }).enableHeadingGutters, false);
});

test("控件位于正文外，遵循原生间距和垂直定位，标题级别与折叠状态同步", async () => {
    const env = setup();
    try {
        await settle();
        const row = env.row();
        assert.equal(env.protyle.wysiwyg.element.querySelector("button"), null);
        assert.equal(row.parentElement, env.protyle.contentElement);
        assert.equal(env.protyle.contentElement.classList.contains("heading-gutter-scroller"), true);
        assert.equal(row.style.left, "58px");
        assert.equal(row.style.top, "88px");
        assert.equal(row.querySelector("use")!.getAttribute("href"), "#iconH2");
        env.heading.dataset.subtype = "h4";
        env.heading.setAttribute("fold", "1");
        await settle();
        assert.equal(row.querySelector("use")!.getAttribute("href"), "#iconH4");
        assert.equal(row.children[1].getAttribute("aria-expanded"), "false");
        env.heading.remove();
        await settle();
        assert.equal(env.row(), null);
    } finally { env.cleanup(); }
});

test("滚动容器含边框和偏移时，纵向及横向滚动保持控件与标题的内容坐标不变", async () => {
    const env = setup();
    try {
        const scroller = env.protyle.contentElement;
        Object.defineProperty(scroller, "clientLeft", { configurable: true, value: 2 });
        Object.defineProperty(scroller, "clientTop", { configurable: true, value: 3 });
        scroller.getBoundingClientRect = () => ({ left: 20, top: 40, right: 620, bottom: 540,
            width: 600, height: 500 } as DOMRect);
        env.heading.getBoundingClientRect = () => {
            const left = 122 - scroller.scrollLeft;
            const top = 123 - scroller.scrollTop;
            return { left, top, right: left + 400, bottom: top + 50, width: 400, height: 50 } as DOMRect;
        };
        await settle();
        assert.equal(env.row().style.left, "58px");
        assert.equal(env.row().style.top, "88px");
        for (const [scrollTop, scrollLeft] of [[30, 10], [65, 20], [0, 0]]) {
            scroller.scrollTop = scrollTop;
            scroller.scrollLeft = scrollLeft;
            scroller.dispatchEvent(new env.win.Event("scroll"));
            await settle();
            assert.equal(env.row().hidden, false);
            assert.equal(env.row().style.left, "58px");
            assert.equal(env.row().style.top, "88px");
        }
    } finally { env.cleanup(); }
});

test("标题滚出顶部时控件按原位置裁剪，不吸附到视口顶部，滚回后恢复", async () => {
    const env = setup();
    try {
        const scroller = env.protyle.contentElement;
        env.heading.getBoundingClientRect = () => {
            const top = 80 - scroller.scrollTop;
            return { left: 100, top, right: 600, bottom: top + 50, width: 500, height: 50 } as DOMRect;
        };
        await settle();
        scroller.scrollTop = 100;
        scroller.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(env.row().hidden, false);
        assert.equal(env.row().style.top, "88px");
        assert.equal(env.row().style.clipPath, "inset(12px 0px 0px 0px)");
        scroller.scrollTop = 140;
        scroller.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(env.row().hidden, true);
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(env.row().hidden, false);
        assert.equal(env.row().style.top, "88px");
        assert.equal(env.row().style.clipPath, "inset(0px 0px 0px 0px)");
    } finally { env.cleanup(); }
});

test("滚动容器替换和销毁时迁移控件并清理定位类", async () => {
    const env = setup();
    try {
        await settle();
        const previous = env.protyle.contentElement;
        const scroller = env.win.document.createElement("div");
        previous.before(scroller);
        scroller.append(env.protyle.wysiwyg.element);
        env.protyle.contentElement = scroller;
        env.controller.syncEditors();
        await settle();
        assert.equal(previous.querySelector(".heading-gutter-persistent"), null);
        assert.equal(previous.classList.contains("heading-gutter-scroller"), false);
        assert.equal(env.row().parentElement, scroller);
        env.controller.destroy();
        assert.equal(scroller.classList.contains("heading-gutter-scroller"), false);
        assert.equal(env.row(), null);
    } finally { env.cleanup(); }
});

for (const legacy of [false, true]) test(`使用${legacy ? "旧版" : "新版"}原生 gutter 打开块菜单与折叠，传递修饰键并避让原生块标`, async () => {
    const env = setup(legacy);
    try {
        await settle();
        env.row().children[0].dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        await settle();
        assert.equal(env.row().hidden, true);
        env.native.classList.add("fn__none");
        await settle();
        assert.equal(env.row().hidden, false);
        env.row().children[1].dispatchEvent(new env.win.MouseEvent("click", { bubbles: true, altKey: true }));
        await settle();
        assert.equal(env.heading.getAttribute("fold"), "1");
        assert.equal(env.row().children[1].getAttribute("aria-expanded"), "false");
        env.row().children[0].dispatchEvent(new env.win.MouseEvent("contextmenu", { bubbles: true }));
        assert.deepEqual(env.calls, [
            { type: "click", action: "NodeHeading", alt: false },
            { type: "click", action: "fold", alt: true },
            { type: "contextmenu", action: "NodeHeading", alt: false },
        ]);
    } finally { env.cleanup(); }
});

test("切换预览、关闭文档和销毁控制器时清理控件", async () => {
    const env = setup();
    try {
        await settle();
        env.protyle.preview!.element.classList.remove("fn__none");
        env.controller.syncEditors();
        assert.equal(env.row(), null);
        env.protyle.preview!.element.classList.add("fn__none");
        env.controller.syncEditors();
        await settle();
        assert.ok(env.row());
        env.editors.length = 0;
        env.controller.syncEditors();
        assert.equal(env.row(), null);
        env.editors.push(env.protyle);
        env.controller.syncEditors();
        env.controller.destroy();
        assert.equal(env.row(), null);
        env.controller.syncEditors();
        assert.equal(env.row(), null);
    } finally { env.cleanup(); }
});

test("引述容器内的标题保留原生容器留白", async () => {
    const env = setup();
    try {
        const quote = env.win.document.createElement("div");
        quote.dataset.type = "NodeBlockquote";
        quote.dataset.nodeId = "quote";
        env.heading.before(quote);
        quote.append(env.heading);
        await settle();
        assert.equal(env.row().style.left, "48px");
        assert.equal(env.row().style.top, "88px");
    } finally { env.cleanup(); }
});
