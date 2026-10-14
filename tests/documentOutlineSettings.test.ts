import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeSettings } from "../src/defaultSettings";
import { DocumentOutlineSettings, DOCUMENT_HIDE_COMPLETED_ATTRIBUTE as HIDE,
    DOCUMENT_LIST_DEPTH_ATTRIBUTE as DEPTH, readDocumentOutlineOverrides } from "../src/documentOutlineSettings";

test("文档设置校验属性，保留不显示列表的 0 和关闭过滤的 false", () => {
    assert.deepEqual(readDocumentOutlineOverrides({ [DEPTH]: "0", [HIDE]: "false" }),
        { headingListDepth: 0, hideCompletedTasks: false });
    for (const value of ["", "-1", "21", "1.5", "invalid", null]) {
        assert.deepEqual(readDocumentOutlineOverrides({ [DEPTH]: value, [HIDE]: value }), {});
    }
});

function setup() {
    let global = normalizeSettings({ headingListDepth: 2, hideCompletedTasks: false });
    const documents: Record<string, Record<string, string>> = { first: { title: "文档一" }, second: {} };
    const writes: any[] = [];
    let fail = false;
    const request = async (url: string, data: Record<string, any>) => {
        if (fail) throw new Error("保存失败");
        if (url.endsWith("getBlockAttrs")) return { ...documents[data.id] };
        assert.equal(url, "/api/attr/setBlockAttrs");
        writes.push(data);
        for (const [key, value] of Object.entries(data.attrs)) {
            if (value === "") delete documents[data.id][key];
            else documents[data.id][key] = String(value);
        }
    };
    const create = () => new DocumentOutlineSettings(request, () => global);
    return { store: create(), create, documents, writes,
        setGlobal: (patch: Parameters<typeof normalizeSettings>[0]) => { global = normalizeSettings({ ...global, ...patch }); },
        setFail: (value: boolean) => { fail = value; } };
}

test("文档覆盖写入根块属性，其他文档和全局默认值互不影响，重新读取仍记忆", async () => {
    const env = setup();
    await Promise.all([env.store.load("first"), env.store.load("second")]);
    await env.store.save("first", { headingListDepth: 0 });
    assert.equal(env.store.get("first").headingListDepth, 0);
    assert.equal(env.store.get("second").headingListDepth, 2);
    assert.equal(env.store.get().headingListDepth, 2);
    assert.deepEqual(env.writes[0], { id: "first", attrs: { [DEPTH]: "0" } });
    env.setGlobal({ headingListDepth: 5, hideCompletedTasks: true });
    assert.equal(env.store.get("first").headingListDepth, 0);
    assert.equal(env.store.get("first").hideCompletedTasks, true);
    assert.equal(env.store.get("second").headingListDepth, 5);
    await env.store.save("first", { hideCompletedTasks: false });
    const reloaded = env.create();
    await reloaded.load("first");
    assert.equal(reloaded.get("first").headingListDepth, 0);
    assert.equal(reloaded.get("first").hideCompletedTasks, false);
    await reloaded.reset("first");
    assert.deepEqual(env.documents.first, { title: "文档一" });
    assert.equal(reloaded.hasOverrides("first"), false);
    assert.equal(reloaded.get("first").headingListDepth, 5);
    assert.equal(reloaded.get("first").hideCompletedTasks, true);
});

test("同一文档连续修改不同设置不会覆盖彼此，保存失败保留先前设置", async () => {
    const env = setup();
    await Promise.all([env.store.save("first", { headingListDepth: 4 }),
        env.store.save("first", { hideCompletedTasks: true })]);
    assert.equal(env.store.get("first").headingListDepth, 4);
    assert.equal(env.store.get("first").hideCompletedTasks, true);
    env.setFail(true);
    await assert.rejects(env.store.save("first", { headingListDepth: 1 }));
    await assert.rejects(env.store.reset("first"));
    assert.equal(env.store.get("first").headingListDepth, 4);
    assert.equal(env.store.get("first").hideCompletedTasks, true);
    env.setFail(false);
    await env.store.save("first", { headingListDepth: 1 });
    assert.equal(env.store.get("first").headingListDepth, 1);
});

test("文档属性读取失败后可以重试，不缓存错误的全局回退值", async () => {
    const env = setup();
    env.documents.first[DEPTH] = "3";
    env.setFail(true);
    await assert.rejects(env.store.load("first"));
    env.setFail(false);
    await env.store.load("first");
    assert.equal(env.store.get("first").headingListDepth, 3);
});
