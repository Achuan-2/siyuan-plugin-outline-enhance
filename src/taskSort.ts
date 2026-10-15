import type { AutoTaskSort, CompletedTaskPosition } from "./defaultSettings";

const TASK_ITEM = '[data-type="NodeListItem"][data-subtype="t"]';
const TASK_LIST = '[data-type="NodeList"][data-subtype="t"]';

export interface TaskMoveOperation {
    action: "move";
    id: string;
    parentID: string;
    previousID: string;
}

interface TaskSortOptions {
    request(url: string, data: Record<string, unknown>): Promise<any>;
    getPosition(): AutoTaskSort;
    canWrite(): boolean;
    transactionContext(): { app: string; session: string };
    reportError(message: string): void;
}

function taskMarker(item: Element): string {
    return item.getAttribute("data-task") ??
        item.querySelector(':scope > .protyle-action--task[data-task]')?.getAttribute("data-task") ?? " ";
}

/** 列表项菜单作用于它所在的同级任务列表，多选时每个列表只处理一次。 */
export function getTaskListTargets(blocks: HTMLElement[]): string[] {
    const ids = new Set<string>();
    for (const block of blocks) {
        const list = block.matches(TASK_LIST) ? block : block.matches(TASK_ITEM) ? block.parentElement : null;
        if (list?.matches(TASK_LIST) && list.getAttribute("data-node-id")) ids.add(list.getAttribute("data-node-id")!);
    }
    return [...ids];
}

/** 稳定分组，仅移动已完成项；从不拆开任务子树，也不改写列表内容。 */
export function createTaskSortPlan(list: HTMLElement, position: CompletedTaskPosition) {
    const parentID = list.dataset.nodeId;
    const items = Array.from(list.children).filter(child => child.getAttribute("data-type") === "NodeListItem");
    if (!parentID || !list.matches(TASK_LIST) || items.some(item => !item.matches(TASK_ITEM))) return null;
    const ids = items.map(item => item.getAttribute("data-node-id") || "");
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) return null;
    const completed = items.filter(item => taskMarker(item).toUpperCase() === "X").map(item => item.getAttribute("data-node-id")!);
    const done = new Set(completed);
    const remaining = ids.filter(id => !done.has(id));
    const desired = position === "top" ? [...completed, ...remaining] : [...remaining, ...completed];
    if (ids.every((id, index) => id === desired[index])) return null;

    const current = [...ids];
    const doOperations: TaskMoveOperation[] = [];
    const undoOperations: TaskMoveOperation[] = [];
    let previousID = position === "bottom" ? remaining.at(-1)! : "";
    for (const id of position === "top" ? [...completed].reverse() : completed) {
        const index = current.indexOf(id);
        const oldPreviousID = current[index - 1] || "";
        if (oldPreviousID !== previousID) {
            doOperations.push({ action: "move", id, parentID, previousID });
            // 倒序撤销，每一步的锚点均对应它提交前的实际位置。
            undoOperations.unshift({ action: "move", id, parentID, previousID: oldPreviousID });
            current.splice(index, 1);
            current.splice(previousID ? current.indexOf(previousID) + 1 : 0, 0, id);
        }
        if (position === "bottom") previousID = id;
    }
    return { doOperations, undoOperations };
}

/** 只消费任务的 update 事务；自身的 move 事务和重新加载不会触发自动排序。 */
export class TaskSortController {
    private disposed = false;
    private generation = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private pending = new Map<string, string | undefined>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private options: TaskSortOptions) {}

    onWorkspaceMessage(message: { cmd?: string; data?: unknown }) {
        if (this.disposed || this.options.getPosition() === "off" || !this.options.canWrite() ||
            message.cmd !== "transactions" || !Array.isArray(message.data)) return;
        for (const transaction of message.data) {
            if (!Array.isArray(transaction?.doOperations)) continue;
            for (const operation of transaction.doOperations) {
                if (operation?.action !== "update" || typeof operation.data !== "string" ||
                    !operation.data.includes('data-subtype="t"')) continue;
                const parsed = new DOMParser().parseFromString(operation.data, "text/html");
                for (const item of parsed.querySelectorAll<HTMLElement>(TASK_ITEM)) {
                    if (!item.dataset.nodeId) continue;
                    const parent = item.parentElement;
                    this.pending.set(item.dataset.nodeId, parent?.matches(TASK_LIST) ? parent.dataset.nodeId : undefined);
                }
            }
        }
        if (!this.pending.size) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const pending = new Map(this.pending);
            this.pending.clear();
            const position = this.options.getPosition();
            const generation = this.generation;
            if (position === "off") return;
            void this.enqueue(async () => {
                const active = () => !this.disposed && this.generation === generation &&
                    this.options.getPosition() === position && this.options.canWrite();
                const lists = new Set<string>();
                for (const [id, knownParent] of pending) {
                    if (!active()) return;
                    const parent = knownParent || (await this.options.request("/api/block/getBlockSiblingID", { id }))?.parent;
                    if (parent) lists.add(parent);
                }
                for (const id of lists) {
                    if (!active()) return;
                    await this.sortList(id, position, active);
                }
            }).catch(error => this.reportError(error));
        }, 300);
    }

    sortLists(ids: string[], position: CompletedTaskPosition): Promise<void> {
        return this.enqueue(async () => {
            for (const id of new Set(ids)) await this.sortList(id, position);
        });
    }

    private async sortList(id: string, position: CompletedTaskPosition, active = () => true) {
        if (this.disposed || !active() || !this.options.canWrite()) return;
        // 重新读取完整列表，不能用编辑区中可能折叠、分页或仅展示部分内容的 DOM 排序。
        const response = await this.options.request("/api/block/getBlockDOM", { id });
        if (this.disposed || !active() || !this.options.canWrite()) return;
        const parsed = new DOMParser().parseFromString(response?.dom || "", "text/html");
        const list = Array.from(parsed.querySelectorAll<HTMLElement>(TASK_LIST)).find(node => node.dataset.nodeId === id);
        if (!list) return;
        const plan = createTaskSortPlan(list, position);
        if (!plan) return;
        await this.options.request("/api/transactions", {
            ...this.options.transactionContext(), reqId: Date.now(), transactions: [plan],
        });
    }

    private enqueue(action: () => Promise<void>): Promise<void> {
        const pending = this.queue.then(action);
        this.queue = pending.catch(() => {});
        return pending;
    }

    private reportError(error: unknown) {
        if (this.disposed) return;
        console.error("任务列表排序失败", error);
        this.options.reportError("任务列表自动排序失败，请稍后重试。");
    }

    refreshSettings() {
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
    }

    destroy() {
        this.disposed = true;
        this.refreshSettings();
    }
}
