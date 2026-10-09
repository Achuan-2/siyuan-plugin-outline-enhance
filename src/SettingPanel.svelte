<script lang="ts">
    import SettingPanel from './libs/components/setting-panel.svelte';
    import { getDefaultSettings, MAX_DEPTH } from './defaultSettings';
    import { showMessage } from 'siyuan';
    import type ListOutlinePlugin from './index';
    export let plugin: ListOutlinePlugin;

    let settings = { ...plugin.settings };
    let saving = false;
    $: items = [
        { key: 'enableHeadingOutline', type: 'checkbox', value: settings.enableHeadingOutline,
          title: '悬浮大纲增强', description: '在当前文档右侧显示悬浮标题目录，悬停线条展开内容，点击定位标题。' },
        { key: 'enableHeadingDock', type: 'checkbox', value: settings.enableHeadingDock,
          title: '右侧大纲增强 Dock', description: '在右侧栏注册一个独立的大纲增强 Dock 面板，持久常驻显示当前文档大纲。' },
        { key: 'enableHeadingGutters', type: 'checkbox', value: settings.enableHeadingGutters,
          title: '常驻标题块标与折叠按钮', description: '在编辑区各级标题前常驻显示 H1–H6 块标和折叠按钮，位置与思源官方块标一致；点击使用思源原生块菜单与折叠操作。' },
        { key: 'headingOutlineDisplayMode', type: 'select', value: settings.headingOutlineDisplayMode,
          options: { compact: '省略列表型', icon: '图标型' },
          title: '电脑端悬浮大纲增强样式', description: '选择省略列表型，或使用和移动端相同的单按钮样式；按钮可悬浮或点击展开大纲增强。' },
        { key: 'enableListOutline', type: 'checkbox', value: settings.enableListOutline,
          title: '悬浮列表/页签大纲', description: '正文或嵌入块中的列表、页签处于可视区域内时，在右侧显示列表项或页签标题；不提取引述块中的内容。' },
        { key: 'listOutlineRequireChildren', type: 'checkbox', value: settings.listOutlineRequireChildren,
          title: '无子级时不显示悬浮大纲', description: '列表仅有单层无子块（如子列表、页签、引述块、代码块、附加段落等）时不显示悬浮大纲，包含子块时显示。' },
        { key: 'headingListDepth', type: 'select', value: String(settings.headingListDepth),
          options: Object.fromEntries(Array.from({ length: MAX_DEPTH + 1 }, (_, depth) =>
            [String(depth), depth === 0 ? '不显示列表/页签' : `显示 ${depth} 层列表/页签`])),
          title: '大纲增强列表/页签层级', description: '选择不显示列表/页签，或在所属标题下显示指定层级的正文及嵌入块列表项、页签标题；块的独立层级设置仍优先生效。' },
        { key: 'defaultDepth', type: 'number', value: settings.defaultDepth,
          title: '列表/页签默认大纲层级', description: `显示前多少层列表项或页签标题，范围 1–${MAX_DEPTH}；单独设置过的块不受影响。` },
    ] as ISettingItem[];

    async function save(next = settings) {
        saving = true;
        try {
            settings = { ...await plugin.saveSettings(next) };
        } catch (error) {
            console.error(error);
            settings = { ...plugin.settings };
            showMessage('列表大纲设置保存失败，请重试。', 5000, 'error');
        } finally {
            saving = false;
        }
    }
</script>

<div class="settings">
    <fieldset disabled={saving}>
        <SettingPanel group="列表大纲" settingItems={items} display={true}
            on:changed={event => save({ ...settings, [event.detail.key]: event.detail.value })} />
        <div class="footer">
            <span class="b3-label__text">修改后自动保存，各项功能独立生效。</span>
            <button class="b3-button b3-button--outline" on:click={() => save(getDefaultSettings())}>恢复默认</button>
        </div>
    </fieldset>
</div>

<style>
    .settings { padding: 8px 16px 20px; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 8px 0; }
</style>
