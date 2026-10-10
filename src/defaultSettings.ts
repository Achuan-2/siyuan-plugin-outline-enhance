export interface OutlineSettings {
    enableListOutline: boolean;
    enableHeadingOutline: boolean;
    enableHeadingDock: boolean;
    enableHeadingGutters: boolean;
    headingOutlineDisplayMode: "compact" | "icon";
    headingListDepth: number;
    keepCurrentHeadingExpanded: boolean;
    listOutlineRequireChildren: boolean;
    defaultDepth: number;
}

export const MAX_DEPTH = 20;
export const getDefaultSettings = (): OutlineSettings => ({
    enableListOutline: false,
    enableHeadingOutline: true,
    enableHeadingDock: true,
    enableHeadingGutters: false,
    headingOutlineDisplayMode: "icon",
    headingListDepth: 2,
    keepCurrentHeadingExpanded: false,
    listOutlineRequireChildren: false,
    defaultDepth: 3,
});

export function normalizeSettings(value: Partial<OutlineSettings> & { headingIncludeLists?: boolean } = {}): OutlineSettings {
    const defaults = getDefaultSettings();
    const integer = (input: unknown, fallback: number, max: number, min = 1) => {
        const number = Number(input);
        return Number.isFinite(number) && number >= min ? Math.min(max, Math.floor(number)) : fallback;
    };
    const headingListDepth = value.headingListDepth === undefined
        ? (value.headingIncludeLists ? integer(value.defaultDepth, defaults.defaultDepth, MAX_DEPTH) : defaults.headingListDepth)
        // 0 表示不显示列表；独立列表的 defaultDepth 仍须至少为 1。
        : integer(value.headingListDepth, defaults.headingListDepth, MAX_DEPTH, 0);
    return {
        enableListOutline: typeof value.enableListOutline === "boolean" ? value.enableListOutline : defaults.enableListOutline,
        enableHeadingOutline: typeof value.enableHeadingOutline === "boolean" ? value.enableHeadingOutline : defaults.enableHeadingOutline,
        enableHeadingDock: typeof value.enableHeadingDock === "boolean" ? value.enableHeadingDock : defaults.enableHeadingDock,
        enableHeadingGutters: typeof value.enableHeadingGutters === "boolean" ? value.enableHeadingGutters : defaults.enableHeadingGutters,
        headingOutlineDisplayMode: value.headingOutlineDisplayMode === "icon" ? "icon" : defaults.headingOutlineDisplayMode,
        headingListDepth,
        keepCurrentHeadingExpanded: typeof value.keepCurrentHeadingExpanded === "boolean"
            ? value.keepCurrentHeadingExpanded : defaults.keepCurrentHeadingExpanded,
        listOutlineRequireChildren: typeof value.listOutlineRequireChildren === "boolean" ? value.listOutlineRequireChildren : defaults.listOutlineRequireChildren,
        defaultDepth: integer(value.defaultDepth, defaults.defaultDepth, MAX_DEPTH),
    };
}
