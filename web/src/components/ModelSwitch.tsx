// 对话右上角的模型胶囊：点开就能换成名单里已有的模型，不用先进设置。
// 单聊改这个助手的对话模型；群（含话题）改本群的对话模型，成员自己设过的仍按成员的。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../../shared/i18n.ts";
import type { Assistant, AssistantSummary, GroupSummary, ModelInfo } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { modelLabel, modelOwner, ownModelRef, ownThinking, switchOptions, switchableRefs, thinkingForSwitch } from "../model-list.ts";
import { loadModels, patchAssistant, patchGroup, useApp } from "../store.ts";
import { useMenu } from "./use-menu.ts";

export function ModelSwitch({ g, a }: { g?: GroupSummary; a?: AssistantSummary }) {
  const s = useApp();
  const settings = s.settings.settings.models;
  const menu = useMenu();
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => {
    void loadModels().then((view) => { if (view) setModels(view.models); });
  }, []);

  const owner = modelOwner(g, s.groups);
  const ref = ownModelRef(owner, a);
  // 没自己设过就是「跟随」：群里跟随各成员，单聊跟随全局那个模型
  const follow = owner ? t("跟随各成员") : t("跟随全局（{name}）", { name: modelLabel(models, settings.conversation.ref) });
  const options = switchOptions(switchableRefs(settings.roster, models), models, follow);

  const choose = (target: string) => {
    menu.close();
    if (target === ref) return;
    const current = ownThinking(owner, a, settings.conversation.thinking);
    const entry = settings.roster.find((item) => item.ref === target)?.thinking;
    const pick = target ? { ref: target, thinking: thinkingForSwitch(models.find((model) => model.ref === target), entry, current) } : null;
    if (owner) {
      void patchGroup(owner.id, { models: { conversation: pick } });
      return;
    }
    if (!a) return;
    // 助手档案里的任务模型、可分派范围原样留着，只换对话模型
    const next: NonNullable<Assistant["models"]> = { ...a.models };
    if (pick) next.conversation = pick;
    else delete next.conversation;
    void patchAssistant(a.id, { models: next });
  };

  // 名单里一个能用的模型都没有：不显示，交给「设置 → 服务商」那条引导
  if (options.length < 2) return null;

  return (
    <>
      <button
        className="model-pill"
        title={t("切换模型")}
        aria-label={t("切换模型")}
        aria-haspopup="menu"
        aria-expanded={menu.menu !== null}
        onClick={(event) => menu.toggle("model", event.currentTarget)}
      >
        <span>{ref ? modelLabel(models, ref) : follow}</span>
        <Icon name="down" size={13} />
      </button>
      {menu.menu ? createPortal(
        <div className="amenu model-menu" ref={menu.box} role="menu">
          {options.map((option) => (
            <button key={option.value || "follow"} role="menuitem" className={option.value === ref ? "sel" : ""} onClick={() => choose(option.value)}>
              <span>{option.label}</span>
              {option.value === ref ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
