// 输入框左边的加号：点开是一个小菜单，加照片、加文件，换这一栏的对话模型和任务模型；只有一个能用的模型时，加号直接选文件。
// 换模型和右栏「模型」里是同一个设置：单聊或主对话改助手的，群综合改本群的，群话题和助手话题改当前话题的覆盖层（选「跟随」清除覆盖）。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../shared/i18n.ts";
import type { AssistantSummary, AssistantTopicSummary, GroupSummary, ModelInfo, ModelPick, ModelSettings, TopicConfigView } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { BrandIcon, brandForRef } from "../brand-icons.tsx";
import { fitThinking, rosterOptions } from "../model-list.ts";
import {
  assistantSessionKey,
  loadAssistantTopicConfig,
  loadGroupProfile,
  loadModels,
  patchAssistant,
  patchAssistantTopicConfig,
  patchGroup,
  setNotice,
  useApp,
} from "../store.ts";
import { useMenu } from "./use-menu.ts";

type Role = "conversation" | "work";

export interface ComposerModelOps {
  patchGroup: typeof patchGroup;
  patchAssistantTopicConfig: typeof patchAssistantTopicConfig;
  patchAssistant: typeof patchAssistant;
  loadGroupProfile: typeof loadGroupProfile;
  setNotice: typeof setNotice;
}

export function composerModelHelper(params: {
  g?: GroupSummary;
  a?: AssistantSummary;
  topic?: AssistantTopicSummary;
  parentGroup?: GroupSummary;
  topicConfig?: TopicConfigView;
  models: ModelInfo[] | null;
  settings: ModelSettings;
}) {
  const { g, a, topic, parentGroup, topicConfig, models, settings } = params;
  const isGroupTopic = Boolean(g?.parentId);
  const isAssistantTopic = Boolean(!g && a && topic);
  const nameOf = (ref: string) => models?.find((model) => model.ref === ref)?.name ?? ref;
  const own = (role: Role): ModelPick | undefined => {
    if (isGroupTopic) return g!.overrides !== undefined ? g!.overrides.models?.[role] : g!.models?.[role];
    if (g) return g.models?.[role];
    if (isAssistantTopic) {
      const effective = topicConfig?.models?.[role];
      if (effective) return effective.source === "topic" ? effective.pick : undefined;
      return topic!.overrides?.models?.[role];
    }
    return a?.models?.[role];
  };
  const inheritedRef = (role: Role): string => {
    if (isGroupTopic) return parentGroup?.models?.[role]?.ref ?? "";
    if (g) return "";
    if (isAssistantTopic) {
      const inherited = topicConfig?.models?.[role]?.inherited;
      if (inherited) return inherited.pick.ref;
      return a?.models?.[role]?.ref ?? settings[role].ref;
    }
    return settings[role].ref;
  };
  const follow = (role: Role): string => {
    if (isGroupTopic) {
      const ref = parentGroup?.models?.[role]?.ref;
      return ref ? t("跟随群 · {model}", { model: nameOf(ref) }) : t("跟随群");
    }
    if (g) return t("跟随各成员");
    if (isAssistantTopic) {
      const inherited = topicConfig?.models?.[role]?.inherited;
      if (inherited) {
        return inherited.source === "assistant"
          ? t("跟随助手 · {model}", { model: nameOf(inherited.pick.ref) })
          : t("跟随全局 · {model}", { model: nameOf(inherited.pick.ref) });
      }
      if (a?.models?.[role]) return t("跟随助手 · {model}", { model: nameOf(a.models[role]!.ref) });
      return t("跟随全局 · {model}", { model: nameOf(settings[role].ref) });
    }
    return t("跟随全局（{name}）", { name: nameOf(settings[role].ref) });
  };
  const current = (role: Role): string => {
    const pick = own(role);
    if (pick) return nameOf(pick.ref);
    if (g || isAssistantTopic) return follow(role);
    return nameOf(settings[role].ref);
  };
  const currentRef = (role: Role): string => own(role)?.ref ?? inheritedRef(role);
  const save = async (role: Role, ref: string, ops: ComposerModelOps): Promise<void> => {
    const before = own(role);
    if (ref === (before?.ref ?? "")) return;
    const inheritedThinking = isAssistantTopic
      ? topicConfig?.models?.[role]?.inherited.pick.thinking
      : isGroupTopic
        ? parentGroup?.models?.[role]?.thinking
        : undefined;
    const pick = ref
      ? {
          ref,
          thinking: fitThinking(
            models?.find((model) => model.ref === ref),
            settings.roster.find((entry) => entry.ref === ref)?.thinking ?? before?.thinking ?? inheritedThinking ?? settings[role].thinking,
          ),
        }
      : null;
    if (g) {
      const failure = await ops.patchGroup(g.id, { models: { [role]: pick } });
      if (failure) ops.setNotice(t("保存失败：{error}", { error: failure }));
      else if (isGroupTopic) void ops.loadGroupProfile(g.id);
      return;
    }
    if (!a) return;
    if (isAssistantTopic) {
      const failure = await ops.patchAssistantTopicConfig(a.id, topic!.id, { models: { [role]: pick } });
      if (failure) ops.setNotice(t("保存失败：{error}", { error: failure }));
      return;
    }
    const next = { ...a.models };
    if (pick) next[role] = pick;
    else delete next[role];
    await ops.patchAssistant(a.id, { models: next });
  };
  return { nameOf, own, inheritedRef, follow, current, currentRef, save };
}

export function ComposerPlus({
  g,
  a,
  topic,
  onFiles,
}: {
  g?: GroupSummary;
  a?: AssistantSummary;
  topic?: AssistantTopicSummary;
  onFiles: (files: File[]) => void;
}) {
  const s = useApp();
  const input = useRef<HTMLInputElement>(null);
  const menu = useMenu("left");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  // 首页是照片、文件、对话模型、任务模型；点模型那行换成那一种的模型列表
  const [page, setPage] = useState<"main" | Role>("main");
  const photos = useRef<HTMLInputElement>(null);
  useEffect(() => { void loadModels().then((view) => setModels(view?.models ?? null)); }, []);
  const isGroupTopic = Boolean(g?.parentId);
  const isAssistantTopic = Boolean(!g && a && topic);
  const topicKey = isAssistantTopic ? assistantSessionKey(a!.id, topic!.id) : "";
  const topicConfig = topicKey ? s.assistantTopicConfigs?.[topicKey]?.value : undefined;
  useEffect(() => {
    if (a && topic && !g) void loadAssistantTopicConfig(a.id, topic.id);
  }, [a?.id, topic?.id, g?.id]);
  const settings = s.settings.settings.models;
  const roster = settings.roster.filter((entry) => models?.some((model) => model.ref === entry.ref));
  const switchable = Boolean(models && roster.length > 1 && (g || a));

  const parentGroup = isGroupTopic ? s.groups.find((item) => item.id === g!.parentId) : undefined;
  const roles = [["conversation", "mem", t("对话模型")], ["work", "term", t("任务模型")]] as const;
  const { nameOf, own, inheritedRef, follow, current, currentRef, save } = composerModelHelper({
    g,
    a,
    topic,
    parentGroup,
    topicConfig,
    models,
    settings,
  });

  const choose = async (role: Role, ref: string) => {
    menu.close();
    await save(role, ref, { patchGroup, patchAssistantTopicConfig, patchAssistant, loadGroupProfile, setNotice });
  };
  const pickFiles = () => { menu.close(); input.current?.click(); };
  const pickPhotos = () => { menu.close(); photos.current?.click(); };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) onFiles(files);
  };

  return (
    <>
      <button
        type="button"
        className="pl"
        title={switchable ? undefined : t("加文件（也可粘贴截图）")}
        aria-label={switchable ? t("更多") : t("加文件（也可粘贴截图）")}
        aria-expanded={switchable ? menu.menu !== null : undefined}
        onClick={(event) => { if (!switchable) { pickFiles(); return; } setPage("main"); menu.toggle("plus", event.currentTarget); }}
      >
        <Icon name="plus" size={19} />
      </button>
      <input ref={input} type="file" multiple hidden onChange={onPick} />
      <input ref={photos} type="file" accept="image/*" multiple hidden onChange={onPick} />
      {menu.menu ? createPortal(
        <div className="plus-menu" ref={menu.box} role="menu">
          {page === "main" ? <>
            <button role="menuitem" onClick={pickPhotos}><span className="pm-ic"><Icon name="image" size={19} /></span><span>{t("照片")}</span></button>
            <button role="menuitem" onClick={pickFiles}><span className="pm-ic"><Icon name="file" size={19} /></span><span>{t("文件")}</span></button>
            {roles.map(([role, icon, label]) => (
              <button key={role} role="menuitem" onClick={() => setPage(role)}><span className="pm-ic"><Icon name={icon} size={19} /></span><span>{label}</span><small><BrandIcon plain size={16} brand={brandForRef(currentRef(role), models ?? [], s.settings.settings.providers)} />{current(role)}</small><Icon name="chev" size={15} /></button>
            ))}
          </> : <>
            <button className="pm-back" onClick={() => setPage("main")}><span className="pm-ic"><Icon name="left" size={19} /></span><span>{roles.find(([role]) => role === page)![2]}</span></button>
            {/* 模型多了只滚列表，返回那行留在顶上 */}
            <div className="pm-list">{[{ value: "", label: follow(page) }, ...rosterOptions(roster, own(page)?.ref, nameOf)].map((option) => (
              <button key={option.value || "follow"} role="menuitemradio" aria-checked={option.value === (own(page)?.ref ?? "")} onClick={() => void choose(page, option.value)}>
                <BrandIcon size={28} brand={brandForRef(option.value || inheritedRef(page), models ?? [], s.settings.settings.providers)} />
                <span>{option.label}</span>
                {option.value === (own(page)?.ref ?? "") ? <Icon name="check" size={17} /> : null}
              </button>
            ))}</div>
          </>}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
