import { MAX_DEPTH, type OutlineSettings } from "./defaultSettings";

export const DOCUMENT_LIST_DEPTH_ATTRIBUTE = "custom-outline-list-depth";
export const DOCUMENT_HIDE_COMPLETED_ATTRIBUTE = "custom-outline-hide-completed-tasks";
export type DocumentOutlineOverrides = Partial<Pick<OutlineSettings, "headingListDepth" | "hideCompletedTasks">>;

export function readDocumentOutlineOverrides(attrs: Record<string, unknown>): DocumentOutlineOverrides {
    const overrides: DocumentOutlineOverrides = {};
    const depth = attrs[DOCUMENT_LIST_DEPTH_ATTRIBUTE];
    if (typeof depth === "string" && /^\d+$/.test(depth) && Number(depth) <= MAX_DEPTH) {
        overrides.headingListDepth = Number(depth);
    }
    const hide = attrs[DOCUMENT_HIDE_COMPLETED_ATTRIBUTE];
    if (hide === "true" || hide === "false") overrides.hideCompletedTasks = hide === "true";
    return overrides;
}

/** 全局设置仅作为默认值；文档覆盖项只保存到文档根块属性。 */
export class DocumentOutlineSettings {
    private overrides = new Map<string, DocumentOutlineOverrides>();
    private loading = new Map<string, Promise<void>>();
    private queues = new Map<string, Promise<unknown>>();

    constructor(private request: (url: string, data: Record<string, unknown>) => Promise<any>,
        private getGlobalSettings: () => OutlineSettings) {}

    get(documentId?: string): OutlineSettings {
        return { ...this.getGlobalSettings(), ...(documentId ? this.overrides.get(documentId) : {}) };
    }

    hasOverrides(documentId?: string) {
        return !!documentId && Object.keys(this.overrides.get(documentId) || {}).length > 0;
    }

    async load(documentId: string) {
        if (this.overrides.has(documentId)) return;
        let pending = this.loading.get(documentId);
        if (!pending) {
            pending = this.request("/api/attr/getBlockAttrs", { id: documentId }).then(attrs => {
                this.overrides.set(documentId, readDocumentOutlineOverrides(attrs || {}));
            }).finally(() => this.loading.delete(documentId));
            this.loading.set(documentId, pending);
        }
        await pending;
    }

    save(documentId: string, patch: DocumentOutlineOverrides) {
        return this.enqueue(documentId, async () => {
            await this.load(documentId);
            const attrs: Record<string, string> = {};
            if (patch.headingListDepth !== undefined) attrs[DOCUMENT_LIST_DEPTH_ATTRIBUTE] = String(patch.headingListDepth);
            if (patch.hideCompletedTasks !== undefined) attrs[DOCUMENT_HIDE_COMPLETED_ATTRIBUTE] = String(patch.hideCompletedTasks);
            await this.request("/api/attr/setBlockAttrs", { id: documentId, attrs });
            this.overrides.set(documentId, { ...this.overrides.get(documentId), ...patch });
        });
    }

    reset(documentId: string) {
        return this.enqueue(documentId, async () => {
            await this.load(documentId);
            await this.request("/api/attr/setBlockAttrs", { id: documentId, attrs: {
                [DOCUMENT_LIST_DEPTH_ATTRIBUTE]: "", [DOCUMENT_HIDE_COMPLETED_ATTRIBUTE]: "",
            } });
            this.overrides.set(documentId, {});
        });
    }

    private enqueue(documentId: string, update: () => Promise<void>) {
        if (!documentId) return Promise.reject(new Error("没有可设置的文档"));
        const pending = (this.queues.get(documentId) || Promise.resolve()).catch(() => {}).then(update);
        this.queues.set(documentId, pending);
        void pending.finally(() => {
            if (this.queues.get(documentId) === pending) this.queues.delete(documentId);
        }).catch(() => {});
        return pending;
    }
}
