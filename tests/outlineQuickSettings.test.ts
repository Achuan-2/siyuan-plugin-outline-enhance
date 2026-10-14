import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { OutlineQuickSettings } from "../src/outlineQuickSettings";

test("快捷设置支持开关面板、保存失败恢复、设置同步、恢复全局和销毁清理", async () => {
    const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
    const win = dom.window;
    for (const key of ["window", "document", "Node"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true });
    }
    let settings = normalizeSettings();
    let overridden = false;
    let fail = true;
    let finish: (() => void) | undefined;
    const errors: string[] = [];
    const quick = new OutlineQuickSettings({
        getSettings: () => settings,
        hasDocumentOverrides: () => overridden,
        setListDepth: async depth => {
            if (fail) throw new Error("失败");
            await new Promise<void>(resolve => { finish = resolve; });
            settings = { ...settings, headingListDepth: depth };
            overridden = true;
        },
        setHideCompletedTasks: async hideCompletedTasks => { settings = { ...settings, hideCompletedTasks }; overridden = true; },
        resetDocumentSettings: async () => { settings = normalizeSettings(); overridden = false; },
        reportError: message => errors.push(message),
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        win.document.body.append(quick.button);
        assert.equal(win.document.querySelector('[role="dialog"]'), null);
        quick.button.click();
        assert.equal(quick.button.getAttribute("aria-expanded"), "true");
        const checkbox = win.document.querySelector<HTMLInputElement>('[aria-label="过滤已完成任务"]')!;
        const reset = win.document.querySelector<HTMLButtonElement>(".outline-quick-settings__reset")!;
        assert.equal(checkbox.checked, false);
        assert.equal(reset.disabled, true);
        quick.depthSelect.value = "0";
        quick.depthSelect.dispatchEvent(new win.Event("change"));
        await settle();
        assert.equal(quick.depthSelect.value, "2");
        assert.equal(errors.length, 1);
        fail = false;
        quick.depthSelect.value = "0";
        quick.depthSelect.dispatchEvent(new win.Event("change"));
        assert.equal(checkbox.disabled, true);
        finish!();
        await settle();
        assert.equal(quick.depthSelect.value, "0");
        assert.equal(checkbox.disabled, false);
        checkbox.click();
        await settle();
        assert.equal(settings.hideCompletedTasks, true);
        assert.equal(quick.button.classList.contains("outline-quick-settings__button--filtered"), true);
        reset.click();
        await settle();
        assert.equal(checkbox.checked, false);
        assert.equal(quick.depthSelect.value, "2");
        win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
        assert.equal(quick.isOpen, false);
        assert.equal(win.document.activeElement, quick.button);
        quick.button.click();
        win.document.body.click();
        assert.equal(quick.isOpen, false);
        quick.button.click();
        quick.destroy();
        assert.equal(win.document.querySelector('[role="dialog"]'), null);
    } finally { quick.destroy(); win.close(); }
});
