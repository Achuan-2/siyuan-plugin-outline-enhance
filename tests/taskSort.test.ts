import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings, type AutoTaskSort } from "../src/defaultSettings";
import { createTaskSortPlan, getTaskListTargets, TaskSortController, type TaskMoveOperation } from "../src/taskSort";

const item = (id: string, marker = " ", children = "") =>
    `<div data-type="NodeListItem" data-subtype="t" data-node-id="${id}" data-task="${marker}" custom-test="keep">` +
    `<div data-type="NodeParagraph"><div contenteditable="true">${id}</div></div>${children}</div>`;
const list = (id: string, children: string) =>
    `<div data-type="NodeList" data-subtype="t" data-node-id="${id}">${children}<div class="protyle-attr"></div></div>`;

function applyMoves(document: Document, operations: TaskMoveOperation[]) {
    const block = (id: string) => Array.from(document.querySelectorAll<HTMLElement>("[data-node-id]")).find(el => el.dataset.nodeId === id)!;
    for (const operation of operations) {
        const node = block(operation.id);
        const parent = block(operation.parentID);
        if (operation.previousID) block(operation.previousID).after(node);
        else parent.insertBefore(node, parent.firstChild);
    }
}

test("所有六项任务状态组合均稳定分组，倒序事务恢复原位置及完整子树", () => {
    const document = new JSDOM().window.document;
    for (let mask = 0; mask < 64; mask++) {
        for (const position of ["top", "bottom"] as const) {
            document.body.innerHTML = list("root", Array.from({ length: 6 }, (_, index) =>
                item(`item-${index}`, mask & (1 << index) ? index % 2 ? "x" : "X" : " ",
                    list(`nested-${index}`, item(`child-${index}`, "X")))).join(""));
            const root = document.body.firstElementChild as HTMLElement;
            const original = root.outerHTML;
            const ids = Array.from({ length: 6 }, (_, index) => `item-${index}`);
            const completed = ids.filter((_, index) => mask & (1 << index));
            const remaining = ids.filter(id => !completed.includes(id));
            const expected = position === "top" ? [...completed, ...remaining] : [...remaining, ...completed];
            const plan = createTaskSortPlan(root, position);
            if (!plan) {
                assert.deepEqual(ids, expected);
                continue;
            }
            assert.ok(plan.doOperations.every(operation => completed.includes(operation.id)));
            applyMoves(document, plan.doOperations);
            assert.deepEqual(Array.from(root.children).filter(el => el.hasAttribute("data-node-id")).map(el => el.getAttribute("data-node-id")), expected);
            assert.equal(createTaskSortPlan(root, position), null);
            applyMoves(document, plan.undoOperations);
            assert.equal(root.outerHTML, original);
        }
    }
});

test("仅 X/x 和旧版任务标记为完成，忽略普通列表和无效结构", () => {
    const document = new JSDOM(list("root", item("done", "X") + item("progress", "/") + item("canceled", "-") +
        item("custom", "?") + item("legacy").replace('data-task=" "', '').replace('<div data-type="NodeParagraph">',
            '<div class="protyle-action--task" data-task="x"></div><div data-type="NodeParagraph">'))).window.document;
    const root = document.body.firstElementChild as HTMLElement;
    const plan = createTaskSortPlan(root, "bottom")!;
    applyMoves(document, plan.doOperations);
    assert.deepEqual(Array.from(root.children).filter(el => el.hasAttribute("data-node-id")).map(el => el.getAttribute("data-node-id")),
        ["progress", "canceled", "custom", "done", "legacy"]);
    root.dataset.subtype = "u";
    assert.equal(createTaskSortPlan(root, "top"), null);
    root.dataset.subtype = "t";
    root.firstElementChild!.setAttribute("data-subtype", "u");
    assert.equal(createTaskSortPlan(root, "top"), null);
});

test("任务块和列表项菜单定位同级列表，多选去重且不误选普通块", () => {
    const document = new JSDOM(list("root", item("parent", "X", list("nested", item("child"))) + item("sibling")) +
        '<div data-type="NodeParagraph" data-node-id="paragraph"></div>').window.document;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-node-id]"));
    assert.deepEqual(getTaskListTargets(nodes), ["root", "nested"]);
});

function setup(initialMarker = "X") {
    const win = new JSDOM(list("root", item("done", initialMarker) + item("todo"))).window;
    Object.defineProperty(globalThis, "DOMParser", { value: win.DOMParser, configurable: true });
    let position: AutoTaskSort = "bottom";
    let writable = true;
    const contents: HTMLElement[] = [win.document.body];
    const calls: { url: string; data: any }[] = [];
    const errors: string[] = [];
    const find = (id: string) => Array.from(win.document.querySelectorAll<HTMLElement>("[data-node-id]")).find(node => node.dataset.nodeId === id);
    let requestOverride: ((url: string, data: any) => Promise<any>) | undefined;
    const controller = new TaskSortController({
        getPosition: () => position, canWrite: () => writable,
        getEditors: () => contents,
        transactionContext: () => ({ app: "app", session: "task-sort" }),
        reportError: error => errors.push(error),
        request: async (url, data) => {
            calls.push({ url, data });
            if (requestOverride) return requestOverride(url, data);
            if (url.endsWith("getBlockSiblingID")) return { parent: find(String(data.id))?.parentElement?.dataset.nodeId };
            if (url.endsWith("getBlockDOM")) return { dom: find(String(data.id))?.outerHTML };
            if (url === "/api/transactions") {
                applyMoves(win.document, (data.transactions as any)[0].doOperations);
                return [];
            }
            throw new Error(`意外请求 ${url}`);
        },
    });
    const message = (data = item("done", "X"), action = "update") => ({ cmd: "transactions",
        data: [{ doOperations: [{ action, id: "done", data }] }] });
    return { controller, calls, errors, win, message, find, contents,
        setPosition(value: AutoTaskSort) { position = value; controller.refreshSettings(); },
        setWritable(value: boolean) { writable = value; },
        setRequest(value: typeof requestOverride) { requestOverride = value; } };
}

const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2500;
    while (!condition()) {
        if (Date.now() >= deadline) assert.fail("任务排序未在期限内完成");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

test("全局设置默认关闭，仅接受置顶或置底", () => {
    assert.equal(normalizeSettings().autoTaskSort, "off");
    assert.equal(normalizeSettings({ autoTaskSort: "top" }).autoTaskSort, "top");
    assert.equal(normalizeSettings({ autoTaskSort: "bottom" }).autoTaskSort, "bottom");
    assert.equal(normalizeSettings({ autoTaskSort: "invalid" as any }).autoTaskSort, "off");
});

test("手动排序读取完整列表并一次提交移动和撤销事务，自动设置关闭时仍可用", async () => {
    const env = setup();
    try {
        env.setPosition("off");
        await env.controller.sortLists(["root", "root"], "bottom");
        assert.equal(env.calls.length, 2);
        assert.equal(env.calls[0].url, "/api/block/getBlockDOM");
        assert.equal(env.calls[1].url, "/api/transactions");
        assert.deepEqual(env.calls[1].data.transactions[0], {
            doOperations: [{ action: "move", id: "done", parentID: "root", previousID: "todo" }],
            undoOperations: [{ action: "move", id: "done", parentID: "root", previousID: "" }],
        });
        assert.equal(env.calls[1].data.session, "task-sort");
        await env.controller.sortLists(["root"], "bottom");
        assert.equal(env.calls.filter(call => call.url === "/api/transactions").length, 1);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("自动排序合并连续完成事件，读取最新状态，移动事务不会循环触发", async () => {
    const env = setup();
    try {
        env.controller.onWorkspaceMessage(env.message());
        env.controller.onWorkspaceMessage(env.message());
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        assert.equal(env.calls.filter(call => call.url.endsWith("getBlockSiblingID")).length, 1);
        assert.equal(env.calls.filter(call => call.url.endsWith("getBlockDOM")).length, 1);
        const count = env.calls.length;
        env.controller.onWorkspaceMessage(env.message(item("done", "X"), "move"));
        env.controller.onWorkspaceMessage({ cmd: "reload", data: [] });
        await new Promise(resolve => setTimeout(resolve, 360));
        assert.equal(env.calls.length, count);
        env.find("done")!.dataset.task = " ";
        env.find("todo")!.dataset.task = "X";
        env.controller.onWorkspaceMessage(env.message(item("done", " ")));
        await waitFor(() => env.calls.filter(call => call.url === "/api/transactions").length === 2);
        assert.equal(env.find("root")!.firstElementChild!.getAttribute("data-node-id"), "done");
    } finally { env.controller.destroy(); env.win.close(); }
});

test("列表快照中的多个任务去重到一个列表，不额外读取父块", async () => {
    const env = setup();
    try {
        env.controller.onWorkspaceMessage(env.message(env.find("root")!.outerHTML));
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        assert.deepEqual(env.calls.map(call => call.url), ["/api/block/getBlockDOM", "/api/transactions"]);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("关闭、只读及销毁均不处理自动事件，切换设置取消待处理排序", async () => {
    const env = setup();
    try {
        env.setPosition("off");
        env.controller.onWorkspaceMessage(env.message());
        env.setPosition("bottom");
        env.setWritable(false);
        env.controller.onWorkspaceMessage(env.message());
        env.setWritable(true);
        env.controller.onWorkspaceMessage(env.message());
        env.setPosition("top");
        await new Promise(resolve => setTimeout(resolve, 360));
        assert.equal(env.calls.length, 0);
        env.controller.onWorkspaceMessage(env.message());
        env.controller.destroy();
        await new Promise(resolve => setTimeout(resolve, 360));
        assert.equal(env.calls.length, 0);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("异步读取期间卸载或关闭自动排序，不再提交事务", async () => {
    for (const cancel of ["disable", "destroy"] as const) {
        const env = setup();
        try {
            let resolveDOM!: (data: any) => void;
            env.setRequest(async url => url.endsWith("getBlockSiblingID") ? { parent: "root" } :
                new Promise(resolve => { resolveDOM = resolve; }));
            env.controller.onWorkspaceMessage(env.message());
            await waitFor(() => !!resolveDOM);
            if (cancel === "disable") env.setPosition("off");
            else env.controller.destroy();
            resolveDOM({ dom: env.find("root")!.outerHTML });
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(env.calls.some(call => call.url === "/api/transactions"), false);
        } finally { env.controller.destroy(); env.win.close(); }
    }
});

test("一次请求失败不会阻塞后续手动排序队列", async () => {
    const env = setup();
    try {
        env.setRequest(async () => { throw new Error("network"); });
        await assert.rejects(env.controller.sortLists(["root"], "bottom"), /network/);
        env.setRequest(undefined);
        await env.controller.sortLists(["root"], "bottom");
        assert.equal(env.calls.filter(call => call.url === "/api/transactions").length, 1);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("没有任何工作区广播，本地直接勾选和取消任务也会触发排序", async () => {
    const env = setup(" ");
    try {
        env.find("done")!.dataset.task = "X";
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        assert.equal(env.find("root")!.firstElementChild!.getAttribute("data-node-id"), "todo");
        env.find("todo")!.dataset.task = "X";
        env.find("done")!.dataset.task = " ";
        await waitFor(() => env.calls.filter(call => call.url === "/api/transactions").length === 2);
        assert.equal(env.find("root")!.firstElementChild!.getAttribute("data-node-id"), "done");
    } finally { env.controller.destroy(); env.win.close(); }
});

test("直接替换任务 DOM 的状态变化也会触发排序，普通重绘与移动不循环", async () => {
    const env = setup(" ");
    try {
        env.find("done")!.outerHTML = item("done", "X");
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        const count = env.calls.length;
        env.find("root")!.outerHTML = env.find("root")!.outerHTML;
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(env.calls.length, count);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("设置从关闭切到开启后立即监听，关闭或销毁后停止监听本地任务", async () => {
    const env = setup(" ");
    try {
        env.setPosition("off");
        env.find("done")!.dataset.task = "X";
        await new Promise(resolve => setTimeout(resolve, 360));
        assert.equal(env.calls.length, 0);
        env.find("done")!.dataset.task = " ";
        env.setPosition("bottom");
        env.find("done")!.dataset.task = "X";
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        const count = env.calls.length;
        env.setPosition("off");
        env.find("done")!.dataset.task = " ";
        env.find("todo")!.dataset.task = "X";
        await new Promise(resolve => setTimeout(resolve, 360));
        assert.equal(env.calls.length, count);
        env.setPosition("bottom");
        env.find("todo")!.dataset.task = " ";
        await Promise.resolve();
        env.controller.destroy();
        await new Promise(resolve => setTimeout(resolve, 360));
        assert.equal(env.calls.length, count);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("切换编辑器时更新监听，不依赖大纲控制器或工作区广播", async () => {
    const env = setup(" ");
    try {
        const content = env.win.document.createElement("section");
        content.innerHTML = list("second", item("second-done") + item("second-todo"));
        env.win.document.body.append(content);
        env.contents.splice(0, 1, content);
        env.controller.syncEditors();
        env.find("done")!.dataset.task = "X";
        env.find("second-done")!.dataset.task = "X";
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        assert.deepEqual(env.calls.filter(call => call.url.endsWith("getBlockDOM")).map(call => call.data.id), ["second"]);
    } finally { env.controller.destroy(); env.win.close(); }
});

test("本地勾选先于原生保存时，等待后端任务状态一致再排序", async () => {
    const env = setup(" ");
    try {
        const saved = env.find("root")!.outerHTML;
        let reads = 0;
        env.setRequest(async (url, data) => {
            if (url.endsWith("getBlockDOM")) {
                reads++;
                return { dom: reads < 3 ? saved : env.find("root")!.outerHTML };
            }
            if (url === "/api/transactions") {
                applyMoves(env.win.document, data.transactions[0].doOperations);
                return [];
            }
            throw new Error(`意外请求 ${url}`);
        });
        env.find("done")!.dataset.task = "X";
        await waitFor(() => env.calls.some(call => call.url === "/api/transactions"));
        assert.equal(reads, 3);
        assert.equal(env.find("root")!.firstElementChild!.getAttribute("data-node-id"), "todo");
    } finally { env.controller.destroy(); env.win.close(); }
});
